/**
 * File-backed long-term memory.
 *
 * The agent's memory is one markdown file per agent profile, kept in an
 * app-owned folder *inside* the workspace so it travels with the project and a
 * second profile is a second folder rather than a second mechanism:
 *
 *   <workspaceRoot>/.marimo/<profileId>/memory.md
 *
 * The format is deliberately plain: an optional `#` title, then `##` sections of
 * `-` bullets. A user can read and edit it by hand, and the merge logic below
 * works on lines rather than a parser, so nothing is lost to a round trip.
 *
 * Writes go through one queue and land by `rename`, so an interrupted write
 * cannot leave a half-written memory behind. `prune` keeps the previous file as
 * `memory.md.bak` because it replaces the whole document.
 */
import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

/** Folder, inside the workspace, that holds agent state. */
export const AGENT_DATA_DIR = '.marimo';
/** Profile used until the app exposes a profile picker. */
export const DEFAULT_PROFILE_ID = 'default';
export const MEMORY_FILE_NAME = 'memory.md';

/** Largest memory file the tools will write, in bytes. */
export const MAX_MEMORY_BYTES = 64 * 1024;
/** How much memory is injected into the system prompt, in characters. */
export const MAX_PROMPT_CHARS = 64 * 1024;
/** Longest single bullet, in characters. */
export const MAX_ENTRY_CHARS = 2_000;

/** Section used when an update names none. */
export const DEFAULT_SECTION = 'Notes';

export class MemoryTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `memory.md would be ${bytes} bytes, over the ${MAX_MEMORY_BYTES}-byte cap. ` +
        'Call prune_memory with a deduplicated rewrite before adding more.',
    );
    this.name = 'MemoryTooLargeError';
    this.bytes = bytes;
  }
}

export interface MemoryStoreOptions {
  /** Workspace the memory folder lives in; follows the user's workspace. */
  workspaceRoot: string;
  profileId?: string;
}

export interface MemoryUpdate {
  /** `##` section to write into. Defaults to `Notes`. */
  section?: string;
  content: string;
  /** `append` (default) adds bullets; `replace` rewrites the section. */
  mode?: 'append' | 'replace';
}

export interface MemoryPruneRequest {
  /** The deduplicated document that should replace memory.md. */
  content: string;
  /** Why the prune happened, echoed back to the model. */
  reason?: string;
}

/** A profile id has to be one path segment, so it cannot escape the workspace. */
function safeProfileId(profileId: string | undefined): string {
  const candidate = (profileId ?? DEFAULT_PROFILE_ID).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate) || candidate === '..') {
    return DEFAULT_PROFILE_ID;
  }
  return candidate;
}

export function resolveAgentDataDir(
  workspaceRoot: string,
  profileId?: string,
): string {
  return join(workspaceRoot, AGENT_DATA_DIR, safeProfileId(profileId));
}

export function resolveMemoryFile(
  workspaceRoot: string,
  profileId?: string,
): string {
  return join(resolveAgentDataDir(workspaceRoot, profileId), MEMORY_FILE_NAME);
}

export class MemoryStore {
  private root: string;
  private profileId: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryStoreOptions) {
    this.root = options.workspaceRoot;
    this.profileId = safeProfileId(options.profileId);
  }

  /** Re-points memory at a new workspace; the profile id is kept. */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.root = workspaceRoot;
  }

  get file(): string {
    return join(
      resolveAgentDataDir(this.root, this.profileId),
      MEMORY_FILE_NAME,
    );
  }

  /**
   * Re-points memory at another agent profile.
   *
   * Switching profile must switch the memory file, not just the prompt: an agent
   * that inherits the previous agent's remembered facts is not a different agent,
   * and facts one profile was told are private would leak into another.
   */
  setProfileId(profileId: string | undefined): void {
    this.profileId = safeProfileId(profileId);
  }

  /** Raw contents, or `''` when the file does not exist yet. */
  async read(): Promise<string> {
    try {
      return await readFile(this.file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return '';
      }
      throw error;
    }
  }

  /**
   * The form injected into the system prompt. This never throws: an unreadable
   * memory file must not break every turn, so the problem is reported to the
   * model (and through it, the user) instead.
   */
  async readForPrompt(): Promise<string> {
    try {
      const text = await this.read();
      if (text.trim().length === 0) {
        return '';
      }
      if (text.length <= MAX_PROMPT_CHARS) {
        return text;
      }
      return (
        `${text.slice(0, MAX_PROMPT_CHARS)}\n\n` +
        `[memory.md truncated at ${MAX_PROMPT_CHARS} characters; ` +
        'use prune_memory to shrink it]'
      );
    } catch (error) {
      return `memory.md could not be read: ${describeError(error)}`;
    }
  }

  /** Replaces the whole document. Callers should prefer `update`. */
  async write(content: string): Promise<void> {
    return await this.withLock(() => this.writeNow(content));
  }

  /** Merges facts into the document, creating the section when needed. */
  async update(update: MemoryUpdate): Promise<string> {
    return await this.withLock(async () => {
      const current = await this.readOrEmpty();
      const next = applyUpdate(current, update);
      await this.writeNow(next);
      return next;
    });
  }

  /** Replaces the document, keeping the previous one as `memory.md.bak`. */
  async prune(request: MemoryPruneRequest): Promise<string> {
    return await this.withLock(async () => {
      const current = await this.readOrEmpty();
      if (current.trim().length > 0) {
        await copyFile(this.file, `${this.file}.bak`);
      }
      await this.writeNow(request.content);
      return request.content;
    });
  }

  private async readOrEmpty(): Promise<string> {
    try {
      return await this.read();
    } catch (error) {
      if (isNotFound(error)) {
        return '';
      }
      throw error;
    }
  }

  private async writeNow(content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_MEMORY_BYTES) {
      throw new MemoryTooLargeError(bytes);
    }
    await mkdir(dirname(this.file), {recursive: true});
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, this.file);
  }

  /** Serializes every mutation, so two tool calls in one turn cannot interleave. */
  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

interface Block {
  /** A `##` heading, or the preamble before the first one. */
  heading?: string;
  lines: string[];
}

/** Splits the document into the preamble and one block per `##` section. */
export function splitMemory(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block = {lines: []};

  for (const line of text.split('\n')) {
    if (/^##\s+/.test(line)) {
      blocks.push(current);
      current = {heading: line.replace(/^##\s+/, '').trim(), lines: []};
      continue;
    }
    current.lines.push(line);
  }
  blocks.push(current);
  return blocks;
}

function renderMemory(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const lines = trimBlankEdges(block.lines);
    if (block.heading === undefined) {
      if (lines.length > 0) {
        parts.push(lines.join('\n'));
      }
      continue;
    }
    parts.push([`## ${block.heading}`, ...lines].join('\n'));
  }
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

/** Turns free text into bullet lines, one per non-empty input line. */
export function toBullets(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line.startsWith('- ') || line.startsWith('* ')
        ? line.slice(2).trim()
        : line,
    )
    .filter((line) => line.length > 0)
    .map((line) => `- ${line.slice(0, MAX_ENTRY_CHARS)}`);
}

function comparable(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Merges one update into the document.
 *
 * Append adds bullets that are not already in the section, which is the cheap
 * half of de-duplication; a real rewrite is what `prune_memory` is for. Replace
 * swaps the whole section body, and removes the section when the replacement is
 * empty.
 */
export function applyUpdate(current: string, update: MemoryUpdate): string {
  const mode = update.mode ?? 'append';
  const heading = (update.section ?? DEFAULT_SECTION).trim() || DEFAULT_SECTION;
  const bullets = toBullets(update.content);

  const blocks = splitMemory(current);
  const index = blocks.findIndex(
    (block) =>
      block.heading !== undefined &&
      comparable(block.heading) === comparable(heading),
  );

  if (index === -1) {
    if (bullets.length === 0) {
      return renderMemory(blocks);
    }
    blocks.push({heading, lines: bullets});
    return renderMemory(blocks);
  }

  const existing = blocks[index] as Block;
  if (mode === 'replace') {
    if (bullets.length === 0) {
      blocks.splice(index, 1);
      return renderMemory(blocks);
    }
    existing.lines = bullets;
    return renderMemory(blocks);
  }

  const seen = new Set(existing.lines.map(comparable));
  const additions = bullets.filter((bullet) => {
    const key = comparable(bullet);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  existing.lines = [...trimBlankEdges(existing.lines), ...additions];
  return renderMemory(blocks);
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim().length === 0) {
    start += 1;
  }
  while (end > start && (lines[end - 1] ?? '').trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
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
