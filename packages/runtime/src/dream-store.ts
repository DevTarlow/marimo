/**
 * The discovery trees on disk.
 *
 * One versioned JSON document per conversation, holding that conversation's turns
 * as discovery trees. The agent package records the trees and knows nothing about
 * files — see `dream/recorder.ts` — so this is the half that owns a path, and it
 * is here in `runtime` for the reason every other store is: the window and the
 * headless runner resolve the same user-data directory, and a store that
 * resolved its own would be the bug this repository names as an invariant.
 *
 * Four decisions shape it.
 *
 * **A conversation, not a turn, is the unit on disk.** One file per turn would be
 * thousands of small files in one directory — slow to list, slow to clean up, and
 * awkward to read back — while one file for the whole install would be a document
 * that grows forever and is rewritten in full on every step. A conversation is
 * the size that stays small and the boundary a reader already thinks in, and it
 * is the same boundary `sessions/` uses for the transcripts.
 *
 * **It is a versioned document, read through `readVersionedDocument`.** The
 * document is new, so there is no migration and nothing older to accept; what the
 * shared reader buys is the refusal. A file written by a *newer* build is left
 * untouched and reported rather than read as though the shape had not changed.
 *
 * **The write path is strict and quarantines first.** `load` is lenient so the
 * window still opens with a corrupt file, and a lenient read plus an unguarded
 * write is how a user's data disappears — the rule the whole repository is built
 * around. So the write asserts it may write, moves an unreadable file aside, and
 * only then replaces it.
 *
 * **Every turn is keyed by its invocation id, and a re-flush replaces it.** A
 * turn's tree is written several times as it runs — see the recorder — and each
 * of those is a complete snapshot of the *same* turn, so the document holds one
 * entry per invocation rather than one per flush. Without the key the file would
 * hold dozens of near-identical copies of one turn and the replay would count
 * them all as separate evidence.
 *
 * Nothing here ever throws on the recording path. This store's `append` is called
 * from inside a tool callback, where an exception does not fail the recording —
 * it fails the tool call, and the user sees the agent break because it was taking
 * notes. Failures are held and reported through {@link DreamStore.problem}, which
 * the settings card reads.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, readdir, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {assertWritable, DocumentTooNewError, quarantineDocument, readVersionedDocument} from '@marimo/agent';
import type {ReadVersionedOptions} from '@marimo/agent';
import type {DreamTree} from '@marimo/protocol';
import {dreamTreeSchema} from '@marimo/protocol';

import {withFileLock} from './lock.js';

/**
 * The version this store writes.
 *
 * The document is new, so there is nothing to migrate *from*. The field exists
 * anyway because its absence is what a future build has to be able to detect: the
 * point of the shared reader is refusing a newer file, and it cannot refuse what
 * it cannot date.
 */
export const DREAM_VERSION = 1;

const READ_OPTIONS: ReadVersionedOptions = {
  label: 'A discovery log',
  current: DREAM_VERSION,
  migrations: [],
};

/**
 * What one conversation's log holds.
 *
 * Declared here rather than in the protocol because it is a storage shape, not
 * something that crosses a wire: nothing in the window draws a whole log, and the
 * one consumer that reads one — the replay CLI — runs in this process.
 */
interface SessionLog {
  version: number;
  sessionId: string;
  updatedAt: string;
  trees: DreamTree[];
}

/**
 * One session's trees, read back.
 *
 * `problem` rather than a thrown error for the read path, because every caller of
 * this is either the settings card — which has to draw *something* — or the
 * replay, which would rather report "this file could not be read" than exit with
 * a stack trace.
 */
export interface LoadedTrees {
  sessionId: string;
  trees: DreamTree[];
  problem?: string;
}

export interface DreamStoreOptions {
  /**
   * The directory holding one document per conversation.
   *
   * One file per conversation that was recorded, and deliberately no separate cap
   * on how many: the number of files is the number of conversations the user has,
   * which is already a number they control by having them. `keepLogs` beside it is
   * the bound whose effect somebody can actually see.
   */
  dir: string;
  /**
   * How many turns to keep per conversation.
   *
   * Read per write rather than captured, like every other setting the stores take:
   * a user who lowers it in Settings should have the next turn's write trim the
   * file, not the next launch.
   */
  keepLogs: () => number;
  /** Injected so a test can produce deterministic documents. */
  now?: () => Date;
}

export class DreamStore {
  private queue: Promise<unknown> = Promise.resolve();
  private failure: string | undefined;

  constructor(private readonly options: DreamStoreOptions) {}

  /**
   * The last thing the write path could not do, or nothing.
   *
   * Kept rather than thrown because of where the writes come from. `append` runs
   * inside a tool callback during a turn the user is watching, and a full disk is
   * not a reason to fail that turn — but it *is* a reason for the settings card to
   * stop claiming the agent is recording anything.
   *
   * A status rather than a one-shot message, and the difference matters: the card
   * is drawn from a settings payload the window reads for its own reasons, so a
   * message that cleared on read could be swallowed by a read nobody was looking
   * at the card for. It is the *last* write that decides, so a later success
   * clears it and a later failure replaces it.
   */
  problem(): string | undefined {
    return this.failure;
  }

  /** The path one conversation's log lives at. */
  fileFor(sessionId: string): string {
    return join(this.options.dir, `${safeName(sessionId)}.json`);
  }

  /**
   * Writes one turn's tree, replacing whatever was there for that invocation.
   *
   * Called several times per turn, once per flush. It is deliberately not
   * `await`ed by the recorder — the sink interface is synchronous because the
   * recorder runs inside a tool callback and must not be able to stall a tool —
   * so this returns nothing and reports failure through {@link takeProblem}.
   *
   * Returns a promise only so a test can await the write it just caused. The
   * recorder ignores it, which is the intended use.
   */
  append(tree: DreamTree): Promise<void> {
    const run = this.queue.then(async () => {
      try {
        await this.writeTree(tree);
        // The last write is what the card reports on, so a turn that records
        // cleanly after a failed one stops being described as broken.
        this.failure = undefined;
      } catch (error) {
        this.failure = describeError(error);
      }
    });
    // The chain keeps moving after a failed write: one unwritable turn must not
    // wedge every turn after it.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeTree(tree: DreamTree): Promise<void> {
    const file = this.fileFor(tree.sessionId);
    return await withFileLock(`${file}.lock`, async () => {
      /*
       * Refused before anything is written, and the file moved aside first if
       * nothing can read it. Both are the same rule from two directions: the read
       * below is lenient so a corrupt file does not stop the turn, and that
       * leniency plus an unguarded write is exactly how a user's data disappears.
       */
      await assertWritable(file, READ_OPTIONS);
      const read = await readVersionedDocument(file, READ_OPTIONS);
      if (read.state === 'unreadable') {
        await quarantineDocument(file);
      }
      if (read.state === 'too-new') {
        throw new DocumentTooNewError('A discovery log', read.found, read.supported);
      }

      const current = treesIn(read);
      const without = current.filter(
        (existing) => existing.invocationId !== tree.invocationId,
      );
      const keep = Math.max(1, this.options.keepLogs());
      const combined = [...without, tree];
      const document: SessionLog = {
        version: DREAM_VERSION,
        sessionId: tree.sessionId,
        updatedAt: this.now().toISOString(),
        // Oldest first, so the trimmed end is the far past rather than the turn
        // that just ran.
        trees:
          combined.length > keep
            ? combined.slice(combined.length - keep)
            : combined,
      };

      await mkdir(dirname(file), {recursive: true});
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    });
  }

  /**
   * One conversation's trees, oldest first.
   *
   * Lenient: an absent file is an empty list and an unreadable one is an empty
   * list with a reason. The replay reports the reason; the settings card shows the
   * count, which is zero either way, and the difference between "nothing recorded
   * yet" and "nothing could be read" is what the `problem` field is for.
   */
  async load(sessionId: string): Promise<LoadedTrees> {
    const file = this.fileFor(sessionId);
    const read = await readVersionedDocument(file, READ_OPTIONS);
    if (read.state === 'absent') {
      return {sessionId, trees: []};
    }
    if (read.state === 'too-new') {
      return {
        sessionId,
        trees: [],
        problem:
          `This conversation's discovery log was written by a newer version of ` +
          `Marimo Bot (version ${read.found}, this build reads ${read.supported}). ` +
          'It has been left alone rather than read as though it had not changed.',
      };
    }
    if (read.state === 'unreadable') {
      return {
        sessionId,
        trees: [],
        problem: `This conversation's discovery log could not be read: ${read.reason}`,
      };
    }
    return {sessionId, trees: treesIn(read)};
  }

  /**
   * Every conversation's trees, oldest session first.
   *
   * What the replay reads. Deliberately not cached: a log is read by a person
   * running a command once, and a cache here would be a second answer to "what is
   * on disk" that goes stale the moment the agent records another turn.
   */
  async loadAll(): Promise<LoadedTrees[]> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      // No directory at all is the state of somebody who has never turned the
      // feature on, which is not a failure.
      return [];
    }

    const loaded: LoadedTrees[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.endsWith('.unreadable')) {
        continue;
      }
      loaded.push(await this.load(name.slice(0, -'.json'.length)));
    }
    return loaded;
  }

  /**
   * Drops one conversation's log.
   *
   * Called when the conversation is deleted, so the record of what the agent did
   * in it does not outlive the user's ability to see it. Best effort: a deletion
   * that fails is not a reason to fail the deletion the user asked for.
   */
  async forget(sessionId: string): Promise<void> {
    const file = this.fileFor(sessionId);
    const read = await readVersionedDocument(file, READ_OPTIONS);
    if (read.state === 'absent') {
      return;
    }
    try {
      await rename(file, `${file}.${randomUUID()}.deleted`);
    } catch {
      // Nothing to do and nothing to say: the file is either gone already or
      // somewhere this process cannot reach, and the conversation is deleted
      // either way.
    }
  }

  /** How many turns are on record for one conversation. */
  async count(sessionId: string): Promise<number> {
    return (await this.load(sessionId)).trees.length;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/**
 * The trees inside a document the shared reader accepted.
 *
 * Each tree is validated on its own rather than the array as a whole, and a tree
 * that does not validate is dropped instead of failing the read. That is the
 * choice between losing one turn and losing a conversation's whole history to a
 * single malformed entry — and the entries are written by a recorder that
 * validated them on the way in, so an invalid one means the file was edited or
 * truncated by something other than this app.
 */
function treesIn(read: {
  state: string;
  document?: Record<string, unknown>;
}): DreamTree[] {
  if (read.document === undefined) {
    return [];
  }
  const trees = read.document['trees'];
  if (!Array.isArray(trees)) {
    return [];
  }

  const parsed: DreamTree[] = [];
  for (const entry of trees) {
    const result = dreamTreeSchema.safeParse(entry);
    if (result.success) {
      parsed.push(result.data);
    }
  }
  return parsed;
}

/**
 * A conversation id turned into a file name that cannot leave the directory.
 *
 * Ids are UUIDs the app made, so this is belt and braces — but the one thing that
 * must not be possible is a path escaping `trees/`, and the cost of the guarantee
 * is a regex. It is the same rule and nearly the same function as
 * `secretFileName`, which exists because connector names *are* typed by a user;
 * this one is here so that a future caller passing something else cannot make the
 * mistake.
 */
function safeName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^[.-]+/u, '');
  return safe.length > 0 ? safe : 'session';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
