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

import {memorySizeWarning} from '../memory/size.js';
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
        const bytes = Buffer.byteLength(text, 'utf8');
        // Reported on every read, so the size is visible before the hard cap is
        // what makes it visible — the truncation in the prompt is the last
        // moment and by then the file has been heavy for a while.
        const sizeWarning = memorySizeWarning(bytes);
        const suffix = sizeWarning ? `\n\n${sizeWarning}` : '';
        if (text.trim().length === 0) {
          return `memory.md is empty (${context.memory.file}). Use update_memory to record durable facts.`;
        }
        return `${context.memory.file} (${String(bytes)} bytes)\n\n${text}${suffix}`;
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
      "Add, correct or replace a fact in memory.md, the agent's long-term " +
      'memory for this workspace. Use it for durable things a future session ' +
      'should know: user preferences, project conventions, environment quirks, ' +
      'decisions. When the user corrects something you already remembered, pass ' +
      'the old bullet as "replaces" so the wrong version does not stay behind. ' +
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
          'Layer to write into, e.g. "Preferences and tone", "Environment and ' +
            'conventions", "Project pointers", "Boundaries". Defaults to "Notes".',
        ),
      mode: z
        .enum(['append', 'replace'])
        .optional()
        .describe(
          'append (default) adds facts that are not already present; replace rewrites the whole section.',
        ),
      replaces: z
        .string()
        .optional()
        .describe(
          'When correcting a fact, the existing bullet to remove first — either ' +
            'the whole bullet or a leading substring of it, in the same section. ' +
            'The old bullet is deleted and the new one added, so both versions ' +
            'never sit next to each other.',
        ),
    }),
    execute: async ({content, section, mode, replaces}) => {
      let report: Awaited<ReturnType<MemoryStore['update']>>;
      try {
        report = await context.memory.update({
          content,
          ...(section !== undefined ? {section} : {}),
          ...(mode !== undefined ? {mode} : {}),
          ...(replaces !== undefined ? {replaces} : {}),
        });
      } catch (error) {
        return `Could not update memory.md: ${describeError(error)}`;
      }
      const bytes = byteLength(report.content);
      const size = `${bytes} bytes`;
      /*
       * The correction path is reported in as many words, including when it did
       * nothing. The model cannot see the file, so "Replaced ..." is the only
       * evidence it has that the old bullet is gone — and a silent no-op would
       * let it believe it corrected something it did not.
       */
      let outcome: string;
      switch (report.supersede.outcome) {
        case 'removed':
          outcome = `Updated ${context.memory.file} (now ${size}). Replaced "${report.supersede.removed}". The new contents are in your prompt on the next request.`;
          break;
        case 'absent':
          outcome = `Updated ${context.memory.file} (now ${size}), but nothing in "${
            (section ?? 'Notes').trim() || 'Notes'
          }" matched "${replaces}" so no old bullet was removed. The fact you were correcting may still be there under other words; check read_memory and retry if so.`;
          break;
        case 'ambiguous':
          outcome = `Updated ${context.memory.file} (now ${size}), but "${replaces}" matched ${String(
            report.supersede.matches ?? 0,
          )} bullets, so none was removed. Pass more of the bullet you mean, or use mode "replace" to rewrite the section.`;
          break;
        default:
          outcome = `Updated ${context.memory.file} (now ${size}). The new contents are in your prompt on the next request.`;
      }
      // A write is the moment the file got bigger, so the size advice lands
      // here as well as on a read: a run that never calls read_memory still
      // gets told before the file is the cap's problem.
      const warning = memorySizeWarning(bytes);
      return warning ? `${outcome}\n\n${warning}` : outcome;
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
