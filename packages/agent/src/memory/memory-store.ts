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

/**
 * Section used when an update names none. Kept equal to the `Notes` entry in
 * `./sections.js`, which is the vocabulary the model is shown; a test pins the
 * two together, because a fallback the prompt does not mention is a layer the
 * model cannot choose on purpose.
 */
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
  /**
   * An existing bullet in that section, or a leading substring of one, to
   * remove before the new fact is added.
   *
   * This is the correction path: "we use tabs now" has to take the old bullet
   * out, because a memory holding both versions is worse than one holding
   * neither — the next session reads a contradiction and has no way to tell
   * which half is current.
   */
  replaces?: string;
}

/**
 * What happened to a `replaces` target.
 *
 * `absent` and `ambiguous` are reported rather than silently ignored: a model
 * that believes it corrected something it did not leaves the file exactly as
 * wrong as it was, and says so confidently.
 */
export interface SupersedeReport {
  /** The bullet that was removed, verbatim. */
  removed?: string;
  outcome: 'none' | 'removed' | 'absent' | 'ambiguous';
  /** How many bullets the target matched, when it was not unique. */
  matches?: number;
}

/** What `update` wrote, and what it did with the bullet it was told to replace. */
export interface UpdateReport {
  content: string;
  supersede: SupersedeReport;
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
  async update(update: MemoryUpdate): Promise<UpdateReport> {
    return await this.withLock(async () => {
      const current = await this.readOrEmpty();
      const report = applyUpdateWithReport(current, update);
      await this.writeNow(report.content);
      return report;
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
  return applyUpdateWithReport(current, update).content;
}

/**
 * `applyUpdate`, plus what happened to a `replaces` target.
 *
 * The caller needs the outcome, not just the new text: a correction that matched
 * nothing is the case where the model most needs telling, and the report is the
 * only place that fact survives.
 */
export function applyUpdateWithReport(
  current: string,
  update: MemoryUpdate,
): UpdateReport {
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
    /*
     * A `replaces` against a section the file does not have has removed
     * nothing. `absent` is the honest answer whether the bullet is missing
     * because the section is, or because the model rephrased it — and a section
     * that does not exist yet has no other bullets for it to have matched.
     */
    const report: SupersedeReport =
      (update.replaces ?? '').trim().length === 0
        ? {outcome: 'none'}
        : {outcome: 'absent', matches: 0};
    if (bullets.length === 0) {
      return {content: renderMemory(blocks), supersede: report};
    }
    blocks.push({heading, lines: bullets});
    return {content: renderMemory(blocks), supersede: report};
  }

  const existing = blocks[index] as Block;

  /*
   * Supersede runs before the mode branch, so it composes with both: the common
   * case is a corrected fact appended, and a whole-section rewrite can still
   * name the stale bullet it is replacing.
   */
  const removed = removeTarget(existing.lines, update.replaces);
  if (removed.lines !== undefined) {
    existing.lines = removed.lines;
  }

  if (mode === 'replace') {
    if (bullets.length === 0) {
      blocks.splice(index, 1);
      existing.lines = [];
    } else {
      existing.lines = bullets;
    }
    /*
     * A supersede can empty a section just as a replace can. `## Preferences`
     * with no bullets under it reads as a layer that exists and is blank, and
     * the next writer appends into a heading nobody chose. Only the section this
     * call emptied goes: a blank heading the user wrote is left alone.
     */
    const nextBlocks =
      existing.lines.length === 0
        ? blocks.filter((block) => block !== existing)
        : blocks;
    return {
      content: renderMemory(nextBlocks),
      supersede: removed.report,
    };
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
  // Drop only the section this call emptied: an untouched empty heading is one
  // the user wrote by hand, and removing it would edit their file behind them.
  const nextBlocks =
    existing.lines.length === 0
      ? blocks.filter((block) => block !== existing)
      : blocks;
  return {
    content: renderMemory(nextBlocks),
    supersede: removed.report,
  };
}

/**
 * Removes the one line a `replaces` names.
 *
 * Matching is on the leading substring, compared case-insensitively with runs of
 * whitespace collapsed, so a model can quote as much of the bullet as it is sure
 * of. Exact equality wins outright; otherwise any prefix counts, and the matches
 * are counted first because a prefix that is too short to be unique must refuse
 * rather than pick one. Removing a bullet nobody named is the same failure as
 * leaving both versions in place, only harder to see.
 */
function removeTarget(
  lines: string[],
  replaces: string | undefined,
): {lines?: string[]; report: SupersedeReport} {
  const target = collapse(replaces ?? '');
  if (target.length === 0) {
    return {report: {outcome: 'none'}};
  }

  let exact = -1;
  const prefixes: number[] = [];
  for (const [index, line] of lines.entries()) {
    // Collapsed on both sides: a model that re-typed a bullet from the prompt
    // may have lost the original spacing, and that is not a different fact.
    const candidate = collapse(line).replace(/^[-*]\s+/, '');
    if (candidate.length === 0) {
      continue;
    }
    if (candidate === target) {
      exact = index;
    } else if (candidate.startsWith(target)) {
      prefixes.push(index);
    }
  }

  const matched = exact >= 0 ? [exact] : prefixes;
  if (matched.length === 0) {
    return {report: {outcome: 'absent', matches: 0}};
  }
  if (matched.length > 1) {
    return {report: {outcome: 'ambiguous', matches: matched.length}};
  }

  const at = matched[0] as number;
  const removedLine = lines[at] ?? '';
  return {
    lines: lines.filter((_line, index) => index !== at),
    report: {outcome: 'removed', removed: removedLine.trim()},
  };
}

/** Lowercased with every run of whitespace reduced to one space. */
function collapse(text: string): string {
  return comparable(text).replaceAll(/\s+/gu, ' ');
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
