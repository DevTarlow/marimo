/**
 * Filesystem tools: `read_file`, `list_dir` and `write_file`.
 *
 * All three are confined to the workspace root through `resolveInsideWorkspace`,
 * and the readers cap what they return so one large file cannot consume the
 * whole context window.
 *
 * `write_file` is the only one that can destroy something, so it is gated: ADK
 * pauses the turn for an approval card whenever the target already exists. A
 * brand-new file writes without a prompt, which keeps ordinary file creation
 * from turning into a wall of dialogs.
 */
import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {PathOutsideWorkspaceError, resolveInsideWorkspace} from './paths.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_ENTRIES = 500;
const MAX_WRITE_BYTES = 1024 * 1024;

export interface FileToolContext {
  workspaceRoot: string;
}

export function createReadFileTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'read_file',
    description:
      "Read a UTF-8 text file from the user's workspace and return its contents. " +
      'Paths may be relative to the workspace root or absolute, but must stay ' +
      'inside it. Output is truncated at 64 KiB.',
    parameters: z.object({
      path: z
        .string()
        .describe(
          'File to read, e.g. "src/index.ts" or "/home/me/project/README.md".',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Byte offset to start reading from. Defaults to 0.'),
    }),
    execute: async ({path: candidate, offset}) => {
      const resolved = await resolveInsideWorkspace(
        context.workspaceRoot,
        candidate,
      );
      const info = await stat(resolved);
      if (info.isDirectory()) {
        return `"${candidate}" is a directory. Use list_dir instead.`;
      }
      if (!info.isFile()) {
        return `"${candidate}" is not a regular file.`;
      }

      const raw = await readFile(resolved, 'utf8');
      if (raw.includes('\u0000')) {
        return `"${candidate}" looks like a binary file (${info.size} bytes); not returning its contents.`;
      }

      const start = Math.min(offset ?? 0, raw.length);
      const slice = raw.slice(start);
      const truncated = slice.length > MAX_READ_BYTES;
      const body = truncated ? slice.slice(0, MAX_READ_BYTES) : slice;

      const header = `${resolved} (bytes ${start}-${start + body.length} of ${info.size})`;
      return truncated
        ? `${header}\n\n${body}\n\n[truncated: re-read with a larger offset to continue]`
        : `${header}\n\n${body}`;
    },
  });
}

export function createListDirTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'list_dir',
    description:
      "List the entries of a directory inside the user's workspace, with sizes " +
      'and whether each entry is a directory. Not recursive.',
    parameters: z.object({
      path: z
        .string()
        .describe('Directory to list. Defaults to the workspace root.'),
    }),
    execute: async ({path: candidate}) => {
      const resolved = await resolveInsideWorkspace(
        context.workspaceRoot,
        candidate,
      );
      const entries = await readdir(resolved, {withFileTypes: true});
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      const shown = entries.slice(0, MAX_ENTRIES);
      const lines = await Promise.all(
        shown.map(async (entry) => {
          if (entry.isDirectory()) {
            return `  ${entry.name}/`;
          }
          if (!entry.isFile()) {
            return `  ${entry.name} (special file)`;
          }
          try {
            const info = await stat(join(resolved, entry.name));
            return `  ${entry.name} (${info.size} bytes)`;
          } catch {
            return `  ${entry.name}`;
          }
        }),
      );

      const suffix =
        entries.length > shown.length
          ? `\n[${entries.length - shown.length} more entries not shown]`
          : '';
      const header = `${resolved}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
      return `${header}\n${lines.join('\n')}${suffix}`;
    },
  });
}

/**
 * `write_file`: replace a file's contents, or create it.
 *
 * The confirmation predicate is evaluated by ADK both when the call is first
 * made and again when an approval resumes it, and ADK separately re-checks that
 * the approved arguments match the call it is about to run — so what the user
 * saw is what executes. A predicate that throws (an unreadable or escaping path,
 * for instance) counts as "no gate"; the tool then refuses in `execute`, so the
 * failure is a readable result rather than a broken turn.
 */
export function createWriteFileTool(context: FileToolContext) {
  return new FunctionTool({
    name: 'write_file',
    description:
      "Write UTF-8 text to a file in the user's workspace, replacing it if it " +
      'already exists or creating it (and its parent directories) if it does ' +
      'not. Overwriting an existing file requires the user to approve first, so ' +
      'say what the change is for. Output is capped at 1 MiB.',
    parameters: z.object({
      path: z
        .string()
        .describe(
          'File to write, e.g. "src/index.ts" or "/home/me/project/notes.md".',
        ),
      content: z.string().describe('The complete new contents of the file.'),
    }),
    requireConfirmation: async ({path: candidate}) => {
      try {
        const resolved = await resolveInsideWorkspace(
          context.workspaceRoot,
          candidate,
        );
        const info = await stat(resolved);
        return info.isFile();
      } catch {
        return false;
      }
    },
    execute: async ({path: candidate, content}) => {
      let resolved: string;
      try {
        resolved = await resolveInsideWorkspace(
          context.workspaceRoot,
          candidate,
        );
      } catch (error) {
        if (error instanceof PathOutsideWorkspaceError) {
          return error.message;
        }
        return `Could not resolve "${candidate}": ${describeError(error)}`;
      }

      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return `Refusing to write ${bytes} bytes to "${candidate}": the limit is ${MAX_WRITE_BYTES} bytes.`;
      }

      let existing: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        existing = await stat(resolved);
      } catch (error) {
        if (!isNotFound(error)) {
          return `Could not inspect "${candidate}": ${describeError(error)}`;
        }
      }
      if (existing?.isDirectory()) {
        return `"${candidate}" is a directory. Use a file path.`;
      }
      if (existing && !existing.isFile()) {
        return `"${candidate}" is not a regular file; refusing to overwrite it.`;
      }

      try {
        await mkdir(dirname(resolved), {recursive: true});
        await writeFile(resolved, content, 'utf8');
      } catch (error) {
        return `Could not write "${candidate}": ${describeError(error)}`;
      }

      return existing
        ? `Replaced ${resolved} (${existing.size} → ${bytes} bytes).`
        : `Wrote ${resolved} (${bytes} bytes, new file).`;
    },
  });
}

export function createCurrentTimeTool() {
  return new FunctionTool({
    name: 'current_time',
    description:
      "Return the current local date and time, with the machine's UTC offset.",
    parameters: z.object({}),
    execute: () => {
      const now = new Date();
      const offsetMinutes = -now.getTimezoneOffset();
      const sign = offsetMinutes >= 0 ? '+' : '-';
      const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(
        2,
        '0',
      );
      const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
      return `${now.toISOString()} (local ${now.toString()}, UTC${sign}${hours}:${minutes})`;
    },
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: string}).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as {code?: string}).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
