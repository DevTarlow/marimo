/**
 * File-backed long-term memory.
 *
 * The agent's memory is markdown, kept in two places, because the two kinds of
 * fact a buddy holds age differently:
 *
 *   <personMemoryRoot>/<profileId>/memory.md   who the user is, how they want to
 *                                              be talked to, what they forbid
 *   <workspaceRoot>/.marimo/<profileId>/memory.md  this project, its paths, its
 *                                              conventions, its pointers
 *
 * The split is deliberate and it is the point of the whole thing: a fact about
 * the person is true in every conversation, while a repo rule is only true
 * inside the repo. Kept in one file, whichever folder happened to be loaded when
 * they mentioned their dog decided whether it was ever remembered again.
 *
 * `personMemoryRoot` is **optional**, and its absence is exactly the old
 * behaviour — one workspace file. That is what a caller with no user-data
 * directory gets (a test, a command that only reads conversations), and it is why
 * the split could be added without rewriting every existing path.
 *
 * The format is deliberately plain: an optional `#` title, then `##` sections of
 * `-` bullets. A user can read and edit either file by hand, and the merge logic
 * below works on lines rather than a parser, so nothing is lost to a round trip.
 * Which section belongs in which file is `scopeForSection` in `sections.ts`, and
 * a heading the app never named stays where it already is.
 *
 * Writes go through one queue and land by `rename`, so an interrupted write
 * cannot leave a half-written memory behind. `prune` keeps each previous file as
 * `memory.md.bak` because it replaces the whole document.
 */
import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {scopeForSection} from './sections.js';
import {MEMORY_SOFT_LIMIT_BYTES} from './size.js';

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
  /** Workspace the workspace-level memory lives in; follows the user's folder. */
  workspaceRoot: string;
  profileId?: string;
  /**
   * Where person-level memory lives — one folder per profile, under user data.
   *
   * Absent means the two layers share the workspace file, which is what the app
   * did before they were split. Every caller that has a user-data directory
   * passes it; a caller that does not (a test, a read-only command) keeps working
   * rather than writing a second file somewhere nobody expects.
   */
  personMemoryRoot?: string;
  /** Overrides where the tools start suggesting a prune. */
  softLimitBytes?: number;
}

export interface MemoryUpdate {
  /** `##` section to write into. Defaults to `Notes`. */
  section?: string;
  content: string;
  /** `append` (default) adds bullets; `replace` rewrites the section. */
  mode?: 'append' | 'replace';
  /**
   * Which file the fact belongs in, when the section name does not say.
   *
   * Absent resolves through `scopeForSection`, which is right for every canonical
   * layer and puts a heading the app never named in the workspace file — where it
   * already is. Passed explicitly only for a new layer the model is inventing.
   */
  scope?: MemoryScope;
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
  /** The whole memory as it now stands, both files merged. */
  content: string;
  supersede: SupersedeReport;
}

export interface MemoryPruneRequest {
  /** The deduplicated document that should replace memory.md. */
  content: string;
  /** Why the prune happened, echoed back to the model. */
  reason?: string;
}

/** What a prune did, and the one thing it refused to do. */
export interface PruneReport {
  /** The whole memory as it now stands, both files merged. */
  content: string;
  /**
   * Person-level memory was left alone because the rewrite did not speak for it.
   *
   * True when `personMemoryRoot` is set and the incoming document names no
   * person-level canonical section at all. The alternative — treating "the model
   * did not mention the person" as "the model wants the person deleted" — is a
   * whole layer of memory lost to an omission, and the model cannot see the two
   * files to know it omitted one. Reported so the tool can say so and the model
   * can send a document that does speak for it.
   */
  personUntouched: boolean;
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

/**
 * Where person-level memory lives for one profile.
 *
 * A folder per profile under user data, with the same file name as the workspace
 * one, so both are "memory.md" and a `.bak` beside either means the same thing.
 * Under user data rather than in a folder because that is what makes it survive
 * switching projects — the whole point of the split.
 */
export function resolvePersonMemoryFile(
  personMemoryRoot: string,
  profileId?: string,
): string {
  return join(personMemoryRoot, safeProfileId(profileId), MEMORY_FILE_NAME);
}

export class MemoryStore {
  private root: string;
  private profileId: string;
  private readonly personRoot: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * The one-time move of person-level sections out of the workspace file.
   *
   * Memoised as a promise rather than a boolean so two reads arriving before the
   * first finishes wait for the same move instead of one of them reading the
   * half-state. Resolved-and-forgotten on failure: a move that could not happen
   * is retried on the next process, and the merged read de-duplicates in the
   * meantime, so the transient copy is invisible rather than doubled.
   */
  private adoption: Promise<void> | undefined;
  /**
   * The size past which the tools warn.
   *
   * Mutable and read at call time rather than captured when the tools are built,
   * because the user can move it in Settings while a window is open: a limit
   * baked into a tool closure would keep quoting the number that was stored when
   * the agent started, which is exactly the disagreement the setting exists to
   * remove.
   */
  private softLimit: number = MEMORY_SOFT_LIMIT_BYTES;

  constructor(options: MemoryStoreOptions) {
    this.root = options.workspaceRoot;
    this.profileId = safeProfileId(options.profileId);
    this.personRoot = options.personMemoryRoot;
    if (options.softLimitBytes !== undefined) {
      this.softLimit = options.softLimitBytes;
    }
  }

  /** Re-points memory at a new workspace; the profile id is kept. */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.root = workspaceRoot;
  }

  /** Moves the size at which the tools start suggesting a prune. */
  setSoftLimitBytes(bytes: number): void {
    this.softLimit = bytes;
  }

  get softLimitBytes(): number {
    return this.softLimit;
  }

  /** How many bytes the whole memory is, for a size readout that is not a read. */
  async bytes(): Promise<number> {
    return Buffer.byteLength(await this.read(), 'utf8');
  }

  /** The workspace-level file: this project's facts. */
  get file(): string {
    return join(
      resolveAgentDataDir(this.root, this.profileId),
      MEMORY_FILE_NAME,
    );
  }

  /** The person-level file, when this store has a place for one. */
  get personFile(): string | undefined {
    return this.personRoot === undefined
      ? undefined
      : resolvePersonMemoryFile(this.personRoot, this.profileId);
  }

  /**
   * Both files as one path-shaped phrase, for a result line the model reads.
   *
   * One string rather than two fields because every message that names memory
   * wants the same thing — "where is this" — and a tool that had to decide
   * whether to name one path or two would be a second place the split shows
   * through.
   */
  get location(): string {
    const person = this.personFile;
    return person === undefined ? this.file : `${person} and ${this.file}`;
  }

  /**
   * Re-points memory at another agent profile.
   *
   * Switching profile must switch the memory file, not just the prompt: an agent
   * that inherits the previous agent's remembered facts is not a different agent,
   * and facts one profile was told are private would leak into another. Both
   * files follow, because both are per-profile — the person file's path is
   * derived from the id rather than stored.
   */
  setProfileId(profileId: string | undefined): void {
    this.profileId = safeProfileId(profileId);
  }

  /**
   * The whole memory, merged, or `''` when neither file exists yet.
   *
   * Person-level blocks first: the identity says their world is the point, and a
   * rule about how to talk to them is read before the quirks of whichever repo
   * happens to be open. Bullets that appear in both files are rendered once —
   * see {@link dedupeBullets}.
   */
  async read(): Promise<string> {
    await this.ensureAdopted();
    return await this.readMerged();
  }

  /**
   * The form injected into the system prompt. This never throws: an unreadable
   * memory must not break every turn, so the problem is reported to the model
   * (and through it, the user) instead.
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
        `[memory truncated at ${MAX_PROMPT_CHARS} characters; ` +
        'use prune_memory to shrink it]'
      );
    } catch (error) {
      return `memory.md could not be read: ${describeError(error)}`;
    }
  }

  /**
   * Replaces the whole document, routing each section to the file it belongs in.
   *
   * Callers should prefer `update`. This is the blunt instrument `prune_memory`
   * and the tests use, and it deliberately will not delete person-level memory
   * that the incoming document does not mention — see {@link PruneReport}.
   */
  async write(content: string): Promise<void> {
    await this.ensureAdopted();
    await this.withLock(() => this.writeDocument(content, {backup: false}));
  }

  /** Merges facts into the document, creating the section when needed. */
  async update(update: MemoryUpdate): Promise<UpdateReport> {
    await this.ensureAdopted();
    return await this.withLock(async () => {
      const target = this.fileFor(update);
      const current = await this.readFileAt(target);
      const report = applyUpdateWithReport(current, update);
      await this.writeFileAt(target, report.content);
      /*
       * The report answers with the *whole* memory rather than the file that was
       * written, because every caller of it is asking a question about memory:
       * how big it is, how many bullets the index now holds behind. A per-file
       * answer to a whole-memory question is how a size warning comes to quote
       * half the number.
       */
      return {content: await this.readMerged(), supersede: report.supersede};
    });
  }

  /** Replaces the document, keeping each previous file as `memory.md.bak`. */
  async prune(request: MemoryPruneRequest): Promise<PruneReport> {
    await this.ensureAdopted();
    return await this.withLock(async () => {
      const personUntouched = await this.writeDocument(request.content, {
        backup: true,
      });
      return {content: await this.readMerged(), personUntouched};
    });
  }

  /**
   * Writes one document across both files, by section scope.
   *
   * Each canonical section goes to its own file; the preamble and any heading the
   * app never named go to the workspace file, which is where an unknown heading
   * already is. The person file is rewritten only when the document contains at
   * least one person-level canonical heading, and the boolean that comes back says
   * whether that condition held — the caller turns it into a sentence so a missing
   * layer is reported rather than silently kept.
   *
   * Writes the person file first. A crash between the two leaves the facts in both
   * files rather than neither, and {@link dedupeBullets} makes that transient
   * state invisible to the prompt.
   */
  private async writeDocument(
    content: string,
    options: {backup: boolean},
  ): Promise<boolean> {
    const blocks = splitMemory(content);
    const personBlocks = blocks.filter(
      (block) =>
        block.heading !== undefined && scopeForSection(block.heading) === 'person',
    );
    const workspaceBlocks = blocks.filter(
      (block) =>
        !(block.heading !== undefined && scopeForSection(block.heading) === 'person'),
    );

    const person = this.personFile;
    const personUntouched = person !== undefined && personBlocks.length === 0;

    if (person !== undefined && !personUntouched) {
      if (options.backup) {
        await this.backup(person);
      }
      await this.writeFileAt(person, renderMemory(personBlocks));
    }

    await this.backupThenWrite(this.file, renderMemory(workspaceBlocks), options);

    /*
     * A document with person-level sections and no workspace-level ones is a
     * prune that says "this is all about the person now", and the workspace file
     * is emptied to say so. That is a real statement and not the omission this
     * guard is for: the omission is the person file, which cannot be reconstructed
     * from anywhere, while a project section can be written again from the
     * conversation it came from.
     */
    return personUntouched;
  }

  private async backupThenWrite(
    file: string,
    content: string,
    options: {backup: boolean},
  ): Promise<void> {
    if (options.backup) {
      await this.backup(file);
    }
    await this.writeFileAt(file, content);
  }

  private async backup(file: string): Promise<void> {
    const current = await this.readFileAt(file);
    if (current.trim().length > 0) {
      await copyFile(file, `${file}.bak`);
    }
  }

  /** The merged document, with no adoption attempt of its own. */
  private async readMerged(): Promise<string> {
    const person = this.personFile;
    const personText = person === undefined ? '' : await this.readFileAt(person);
    const workspaceText = await this.readFileAt(this.file);
    if (personText.trim().length === 0) {
      return workspaceText;
    }
    if (workspaceText.trim().length === 0) {
      return personText;
    }
    return renderMemory(
      dedupeBullets([...splitMemory(personText), ...splitMemory(workspaceText)]),
    );
  }

  /** Raw contents of one file, or `''` when it does not exist yet. */
  private async readFileAt(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return '';
      }
      throw error;
    }
  }

  /** The file one update belongs in. */
  private fileFor(update: MemoryUpdate): string {
    const heading = (update.section ?? DEFAULT_SECTION).trim() || DEFAULT_SECTION;
    const scope = update.scope ?? scopeForSection(heading);
    const person = this.personFile;
    return scope === 'person' && person !== undefined ? person : this.file;
  }

  /**
   * Moves person-level sections out of the workspace file, once.
   *
   * Runs on the first read after an upgrade rather than in a migration, for the
   * reason the folders had: a migration is a pure function of one document and
   * this moves data between two. The trigger is the workspace file still holding
   * a person-level canonical section, not the person file being absent — a crash
   * between the two writes leaves it present *and* still holding them, and
   * "destination exists" would then mean the copy is never cleaned up.
   *
   * Idempotent by construction: a workspace file with no person-level section
   * does nothing and writes nothing, which is the steady state and therefore the
   * cost on every later read.
   *
   * A write on a read path is the thing to be suspicious of, so: the two
   * processes that can hold a memory store never hold it at once. The headless
   * runner returns without doing anything while the app's lock file is held and
   * takes that lock itself before it runs a job (`run-due.ts`), so this is a
   * read-modify-write with no other writer to interleave with. Within a process
   * the memo means it happens once, and the merge de-duplicates in the meantime.
   */
  private async ensureAdopted(): Promise<void> {
    this.adoption ??= this.adoptOnce().catch(() => undefined);
    return await this.adoption;
  }

  private async adoptOnce(): Promise<void> {
    const person = this.personFile;
    if (person === undefined) {
      return;
    }
    let workspaceText: string;
    try {
      workspaceText = await this.readFileAt(this.file);
    } catch {
      // Unreadable: leave both files exactly where they are. The prompt reports
      // the problem, and a move is not the way to fix it.
      return;
    }
    const blocks = splitMemory(workspaceText);
    const adopted = blocks.filter(
      (block) =>
        block.heading !== undefined && scopeForSection(block.heading) === 'person',
    );
    if (adopted.length === 0) {
      return;
    }

    const personBlocks = splitMemory(await this.readFileAt(person));
    for (const block of adopted) {
      mergeBlock(personBlocks, block);
    }

    // Person first. The other order loses the facts outright if this throws
    // between the two writes.
    await this.writeFileAt(person, renderMemory(personBlocks));
    const remaining = blocks.filter((block) => !adopted.includes(block));
    await this.writeFileAt(this.file, renderMemory(remaining));
  }

  private async writeFileAt(file: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_MEMORY_BYTES) {
      throw new MemoryTooLargeError(bytes);
    }
    await mkdir(dirname(file), {recursive: true});
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
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

/** Which file a layer belongs in. */
export type MemoryScope = 'person' | 'workspace';

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

/**
 * The first copy of every bullet, and every other line untouched.
 *
 * The one state this exists for is the instant between the adoption's two writes,
 * where a person-level fact is legitimately in both files. Rendering it twice
 * would put the same sentence in the prompt twice, which reads as emphasis rather
 * than as a duplicate — and the model has no way to know which copy is real.
 *
 * Only bullet lines are compared. A heading, a blank line or a sentence someone
 * typed by hand passes through, because those are structure rather than facts and
 * dropping one silently would edit a file the user wrote.
 */
function dedupeBullets(blocks: readonly Block[]): Block[] {
  const seen = new Set<string>();
  return blocks.map((block) => ({
    ...(block.heading === undefined ? {} : {heading: block.heading}),
    lines: block.lines.filter((line) => {
      const match = /^\s*[-*]\s+(.*)$/u.exec(line);
      if (match === null) {
        return true;
      }
      const key = collapse(match[1] ?? '');
      if (key.length === 0 || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
  }));
}

/**
 * Adds one block's lines into the matching section, creating it when absent.
 *
 * Used by the adoption, where the destination file already has some of the
 * layer's bullets — the user may have written one there by hand, or a crash may
 * have left the move half done. Matching is on the bullet's collapsed text, the
 * same rule the append path uses, so a fact already present is not added twice.
 */
function mergeBlock(target: Block[], block: Block): void {
  const lines = trimBlankEdges(block.lines);
  const heading = block.heading;
  if (heading === undefined) {
    // A preamble has no section to merge into; it stays where it was.
    return;
  }
  const existing = target.find(
    (candidate) =>
      candidate.heading !== undefined &&
      comparable(candidate.heading) === comparable(heading),
  );
  if (existing === undefined) {
    target.push({heading, lines});
    return;
  }
  const seen = new Set(existing.lines.map(collapse));
  const additions = lines.filter((line) => {
    const key = collapse(line);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  existing.lines = [...trimBlankEdges(existing.lines), ...additions];
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
