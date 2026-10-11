/**
 * Finding the text files in a folder, once, for both things that need them.
 *
 * This was inside `knowledge-tools.ts`, where it served the literal search. The
 * recall indexer needs the same walk — same skip list, same byte cap, same
 * refusal to follow a symlink — and two copies of *that* would be two answers to
 * "which files are in this folder", which is the kind of disagreement that shows
 * up as a search that finds a file and an index that does not contain it.
 *
 * What it deliberately is not is a reader. The two callers want different things
 * from a file: the search wants its lines, the indexer wants it in pieces, and
 * neither should inherit the other's caps. So this answers one question — which
 * paths are worth opening — and the budgets below are about the walk rather than
 * about what happens to a file afterwards.
 */
import {readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Directories that are never worth walking.
 *
 * The same list the literal search has always used, and it is one list on
 * purpose: a folder the search skips but the index walks is a folder whose files
 * the agent can recall but not quote, which is a stranger failure than either.
 * `.marimo` is the interesting entry — it is the agent's own state, which
 * includes the index being built, so a walk that followed it would try to index
 * its own vectors.
 */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
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

/** The largest file worth opening, in bytes. */
export const MAX_FILE_BYTES = 256 * 1024;

/** How many files one walk will look at before it gives up. */
export const MAX_FILES_SCANNED = 2_000;

export interface WalkResult {
  /** Files worth opening: regular, within the cap, and not behind a symlink. */
  files: string[];
  /** Files examined, including the ones skipped for their size. */
  scanned: number;
  /** Directories that could not be listed, or files that could not be sized. */
  unreadable: number;
  /** True when a budget stopped the walk before it had finished the folder. */
  truncated: boolean;
}

export interface WalkOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
}

/**
 * Every text-file candidate under `start`, depth-first.
 *
 * Symlinks are skipped rather than followed: one that points at a parent
 * directory is a walk that never ends, and one that points outside the workspace
 * is a file the agent's path rules would refuse to read anyway — so following
 * them would be a walk whose budget is spent on things that cannot be used.
 *
 * The result is sorted, which makes the walk's order something a caller can
 * depend on: an index built in a different order than the one it is refreshed in
 * would report every file as changed.
 */
export async function walkFiles(
  start: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? MAX_FILES_SCANNED;
  const maxBytes = options.maxBytesPerFile ?? MAX_FILE_BYTES;
  const result: WalkResult = {
    files: [],
    scanned: 0,
    unreadable: 0,
    truncated: false,
  };

  const stack = [start];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch {
      result.unreadable += 1;
      continue;
    }

    for (const entry of entries) {
      if (result.scanned >= maxFiles) {
        result.truncated = true;
        return finish(result);
      }
      if (entry.isSymbolicLink()) {
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
      result.scanned += 1;
      try {
        const info = await stat(path);
        if (info.size > maxBytes) {
          continue;
        }
      } catch {
        result.unreadable += 1;
        continue;
      }
      result.files.push(path);
    }
  }

  return finish(result);
}

function finish(result: WalkResult): WalkResult {
  result.files.sort();
  return result;
}
