/**
 * Memory tools: `read_memory`, `update_memory` and `prune_memory`.
 *
 * None of them takes a path. Memory lives at exactly one app-owned location per
 * profile, so the model cannot aim a memory write at an arbitrary file, and no
 * approval gate is needed for the agent's own notebook. The file is still
 * inspectable — every call and its arguments are in the transcript.
 *
 * Failures come back as text rather than exceptions: a full disk or an
 * oversized rewrite should reach the model as something it can react to, not as
 * a broken turn.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import type {MemoryStore} from '../memory/index.js';

export interface MemoryToolContext {
  memory: MemoryStore;
}

export function createReadMemoryTool(context: MemoryToolContext) {
  return new FunctionTool({
    name: 'read_memory',
    description:
      "Return the current contents of memory.md, the agent's long-term memory " +
      'for this workspace. The same contents are already included in your ' +
      'system prompt, so this is only for re-checking your own recent writes.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const text = await context.memory.read();
        if (text.trim().length === 0) {
          return `memory.md is empty (${context.memory.file}). Use update_memory to record durable facts.`;
        }
        return `${context.memory.file}\n\n${text}`;
      } catch (error) {
        return `Could not read memory.md: ${describeError(error)}`;
      }
    },
  });
}

export function createUpdateMemoryTool(context: MemoryToolContext) {
  return new FunctionTool({
    name: 'update_memory',
    description:
      "Add or replace a fact in memory.md, the agent's long-term memory for " +
      'this workspace. Use it for durable things a future session should know: ' +
      'user preferences, project conventions, environment quirks, decisions. ' +
      'Never store secrets, credentials, or transient output. Duplicate facts ' +
      'are dropped rather than repeated.',
    parameters: z.object({
      content: z
        .string()
        .min(1)
        .describe(
          'The fact to remember. One fact per line; each line becomes a bullet.',
        ),
      section: z
        .string()
        .optional()
        .describe(
          'Section to write into, e.g. "Preferences" or "Project facts". Defaults to "Notes".',
        ),
      mode: z
        .enum(['append', 'replace'])
        .optional()
        .describe(
          'append (default) adds facts that are not already present; replace rewrites the whole section.',
        ),
    }),
    execute: async ({content, section, mode}) => {
      try {
        const next = await context.memory.update({
          content,
          ...(section !== undefined ? {section} : {}),
          ...(mode !== undefined ? {mode} : {}),
        });
        return `Updated ${context.memory.file} (now ${byteLength(next)} bytes). The new contents are in your prompt on the next request.`;
      } catch (error) {
        return `Could not update memory.md: ${describeError(error)}`;
      }
    },
  });
}

export function createPruneMemoryTool(context: MemoryToolContext) {
  return new FunctionTool({
    name: 'prune_memory',
    description:
      'Replace memory.md with a deduplicated, summarised rewrite: drop what is ' +
      'outdated or no longer true, merge repeats, and keep everything that still ' +
      'matters. The previous contents are kept as memory.md.bak. Use this when ' +
      'memory has grown noisy, repetitive, or contradictory.',
    parameters: z.object({
      content: z
        .string()
        .min(1)
        .describe(
          'The complete replacement document, in the same markdown shape as the current memory.md.',
        ),
      reason: z
        .string()
        .optional()
        .describe('One line on why the prune was needed.'),
    }),
    execute: async ({content, reason}) => {
      let before: string;
      try {
        before = await context.memory.read();
      } catch (error) {
        return `Could not read memory.md before pruning: ${describeError(error)}`;
      }
      try {
        await context.memory.prune({
          content,
          ...(reason !== undefined ? {reason} : {}),
        });
      } catch (error) {
        return `Could not prune memory.md: ${describeError(error)}`;
      }
      const suffix = reason ? ` Reason: ${reason}` : '';
      return `Pruned ${context.memory.file} (${byteLength(before)} → ${byteLength(content)} bytes). Previous contents kept as memory.md.bak.${suffix}`;
    },
  });
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as {code?: string}).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
