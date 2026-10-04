/**
 * `search_knowledge_base`: literal text search over the user's workspace.
 *
 * Matching is a plain substring test, deliberately not a regular expression: the
 * query is model-authored, and handing an arbitrary pattern to a regex engine is
 * a denial-of-service primitive. Case-insensitive by default, which is what a
 * "where is this mentioned?" question wants.
 *
 * The walk is bounded (files scanned, bytes per file, matches, output size) and
 * skips the directories that would waste the budget — `node_modules`, `.git`,
 * build output, and the agent's own `.marimo` folder.
 */
import {readFile, readdir, stat} from 'node:fs/promises';
import {join, relative, sep} from 'node:path';

import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {PathOutsideWorkspaceError, resolveInsideWorkspace} from './paths.js';

const MAX_FILES_SCANNED = 2_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;
const MAX_OUTPUT_CHARS = 8 * 1024;
const MAX_LINE_CHARS = 200;

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.marimo',
  '.venv',
  '.next',
  '.cache',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'venv',
]);

export interface KnowledgeToolContext {
  workspaceRoot: string;
}

export interface SearchMatch {
  /** Path relative to the workspace root. */
  file: string;
  /** 1-based line number. */
  line: number;
  text: string;
}

export interface SearchOutcome {
  matches: SearchMatch[];
  filesScanned: number;
  unreadable: number;
  /** True when a cap stopped the walk or the match list early. */
  truncated: boolean;
}

export interface SearchRequest {
  query: string;
  /** File or directory to search; defaults to the workspace root. */
  start?: string;
  maxResults?: number;
  caseSensitive?: boolean;
}

export async function searchWorkspace(
  workspaceRoot: string,
  request: SearchRequest,
): Promise<SearchOutcome> {
  const needle = request.caseSensitive
    ? request.query.trim()
    : request.query.trim().toLowerCase();
  const limit = Math.min(
    Math.max(request.maxResults ?? DEFAULT_RESULTS, 1),
    MAX_RESULTS,
  );
  const root = await resolveInsideWorkspace(workspaceRoot, '.');
  const start = await resolveInsideWorkspace(
    workspaceRoot,
    request.start && request.start.length > 0 ? request.start : '.',
  );

  const outcome: SearchOutcome = {
    matches: [],
    filesScanned: 0,
    unreadable: 0,
    truncated: false,
  };
  if (needle.length === 0) {
    return outcome;
  }

  const info = await stat(start);
  const files: string[] = [];
  if (info.isFile()) {
    files.push(start);
  } else if (info.isDirectory()) {
    await collectFiles(start, files, outcome);
  }

  for (const file of files) {
    if (outcome.matches.length >= limit) {
      outcome.truncated = true;
      break;
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      outcome.unreadable += 1;
      continue;
    }
    if (text.includes('\u0000')) {
      continue;
    }
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const haystack = request.caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }
      const whole = line.trim();
      /*
       * A clipped line is a *truncated* result, and it has to say so in the same
       * place the match-count cap does — otherwise the summary reports a
       * complete search while handing the model a sentence that stops halfway.
       */
      const text =
        whole.length > MAX_LINE_CHARS
          ? `${whole.slice(0, MAX_LINE_CHARS)} [line cut]`
          : whole;
      if (whole.length > MAX_LINE_CHARS) {
        outcome.truncated = true;
      }
      outcome.matches.push({
        file: relative(root, file).split(sep).join('/'),
        line: index + 1,
        text,
      });
      if (outcome.matches.length >= limit) {
        outcome.truncated = true;
        break;
      }
    }
  }

  return outcome;
}

/** Depth-first walk with a hard file budget and no symlink following. */
async function collectFiles(
  start: string,
  files: string[],
  outcome: SearchOutcome,
): Promise<void> {
  const stack = [start];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch {
      outcome.unreadable += 1;
      continue;
    }

    for (const entry of entries) {
      if (outcome.filesScanned >= MAX_FILES_SCANNED) {
        outcome.truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) {
        // Following links risks cycles and escapes the walk's budget.
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          stack.push(path);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      outcome.filesScanned += 1;
      try {
        const info = await stat(path);
        if (info.size > MAX_FILE_BYTES) {
          continue;
        }
      } catch {
        outcome.unreadable += 1;
        continue;
      }
      files.push(path);
    }
  }
}

export function createSearchKnowledgeBaseTool(context: KnowledgeToolContext) {
  return new FunctionTool({
    name: 'search_knowledge_base',
    description:
      'Search the text of files in the workspace for a literal string and ' +
      'return matching lines as "path:line: text", with paths relative to the ' +
      'workspace root. Case-insensitive by default. Read a file with read_file ' +
      'once you know where to look. Dependency folders and build output are ' +
      'skipped.',
    parameters: z.object({
      query: z.string().min(1).describe('Literal text to look for.'),
      path: z
        .string()
        .optional()
        .describe(
          'File or directory inside the workspace to search. Defaults to the whole workspace.',
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS)
        .optional()
        .describe(
          `Maximum matching lines to return. Defaults to ${DEFAULT_RESULTS}.`,
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .describe('Match case-sensitively. Defaults to false.'),
    }),
    execute: async ({query, path, maxResults, caseSensitive}) => {
      let outcome: SearchOutcome;
      try {
        outcome = await searchWorkspace(context.workspaceRoot, {
          query,
          ...(path !== undefined ? {start: path} : {}),
          ...(maxResults !== undefined ? {maxResults} : {}),
          ...(caseSensitive !== undefined ? {caseSensitive} : {}),
        });
      } catch (error) {
        return error instanceof PathOutsideWorkspaceError
          ? error.message
          : `Search failed: ${describeError(error)}`;
      }

      if (outcome.matches.length === 0) {
        const scanned = `${outcome.filesScanned} file${outcome.filesScanned === 1 ? '' : 's'}`;
        return `No matches for "${query}" in ${scanned}.`;
      }

      const lines: string[] = [];
      let length = 0;
      let shown = 0;
      for (const match of outcome.matches) {
        const line = `${match.file}:${match.line}: ${match.text}`;
        if (length + line.length > MAX_OUTPUT_CHARS) {
          outcome.truncated = true;
          break;
        }
        lines.push(line);
        length += line.length + 1;
        shown += 1;
      }

      const count = outcome.truncated
        ? `${outcome.matches.length}+`
        : `${outcome.matches.length}`;
      const header = `${count} match${outcome.matches.length === 1 && !outcome.truncated ? '' : 'es'} for "${query}" in ${outcome.filesScanned} file${outcome.filesScanned === 1 ? '' : 's'}`;
      const notes: string[] = [];
      if (outcome.truncated || shown < outcome.matches.length) {
        notes.push('stopped at the result cap; narrow the query or the path');
      }
      if (outcome.unreadable > 0) {
        notes.push(`${outcome.unreadable} file(s) could not be read`);
      }
      const suffix = notes.length > 0 ? `\n[${notes.join('; ')}]` : '';
      return `${header}\n\n${lines.join('\n')}${suffix}`;
    },
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as {code?: string}).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
