/**
 * Where the agent's suggestions wait for an answer.
 *
 * A store rather than a queue in memory, for the same reason the approval gates
 * are stored: the user is not sitting there when a review runs. A proposal that
 * only existed in the process would be lost on the next restart, and the user
 * would never learn it had been made.
 *
 * The **watermark** is the other half, and it is the part that decides whether
 * the feature is usable. It records how many events of each conversation have
 * been reviewed, so going idle twice does not review the same exchange twice. A
 * queue that refills itself with things the user has already dismissed is one
 * they stop opening.
 *
 * Versioned and locked like every other document here: it holds decisions the
 * user has not made yet, and a newer build's file must not be overwritten by
 * this one.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  emptyMemoryProposals,
  memoryProposalsFileSchema,
} from '@marimo/protocol';
import type {MemoryProposal, MemoryProposalsFile} from '@marimo/protocol';

import {withFileLock} from './lock.js';
import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';

/** How many proposals may wait at once. */
export const MAX_PENDING_PROPOSALS = 50;

export interface MemoryProposalStoreOptions {
  file: string;
  now?: () => Date;
}

/** A proposal about to be recorded, before it has an id or a time. */
export interface NewProposal {
  sessionId: string | null;
  profileId: string;
  section: string;
  text: string;
  reason: string;
}

export class MemoryProposalStore {
  private cache: MemoryProposalsFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: MemoryProposalStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The proposals waiting, and how far each conversation has been reviewed.
   *
   * Lenient: a file that cannot be read answers as empty so the window still
   * opens. Only the write path has to be strict, and it is.
   */
  async load(): Promise<MemoryProposalsFile> {
    if (this.cache) {
      return this.cache;
    }
    const read = await readVersionedDocument(this.options.file, {
      label: 'The memory proposals file',
    });
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The memory proposals file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'current' || read.state === 'migrated') {
      const parsed = memoryProposalsFileSchema.safeParse(read.document);
      if (parsed.success) {
        this.cache = parsed.data;
        return parsed.data;
      }
    }
    this.cache = emptyMemoryProposals();
    return this.cache;
  }

  /**
   * How many events of a conversation have already been reviewed.
   *
   * The caller compares this against the stored conversation to decide what is
   * new. Kept here rather than in the caller because it has to survive a
   * restart: reviewing the same exchange on every launch is the behaviour this
   * exists to prevent.
   */
  async reviewedUpTo(sessionId: string): Promise<number> {
    const file = await this.load();
    return file.reviewed[sessionId] ?? 0;
  }

  /** Adds proposals, and moves the watermark, in one write. */
  async record(
    sessionId: string,
    reviewed: number,
    proposals: readonly NewProposal[],
  ): Promise<MemoryProposalsFile> {
    return await this.mutate((current) => {
      const existing = new Set(
        current.proposals.map((proposal) => `${proposal.profileId}\u0000${proposal.text}`),
      );

      const added: MemoryProposal[] = [];
      for (const proposal of proposals) {
        const key = `${proposal.profileId}\u0000${proposal.text}`;
        // A proposal already waiting is not added again. The reviewer filters
        // against memory.md; this filters against the queue, which is the other
        // way the same fact arrives twice.
        if (existing.has(key)) {
          continue;
        }
        existing.add(key);
        added.push({
          id: randomUUID(),
          ...proposal,
          createdAt: this.now().toISOString(),
        });
      }

      /*
       * Capped by dropping the *oldest*. A queue that grows without bound is one
       * nobody scrolls, and the newest suggestions are the ones about the
       * conversation the user has just had.
       */
      const combined = [...current.proposals, ...added];
      const kept =
        combined.length > MAX_PENDING_PROPOSALS
          ? combined.slice(combined.length - MAX_PENDING_PROPOSALS)
          : combined;

      return {
        version: 1,
        proposals: kept,
        // Moved whether or not anything was proposed: "I looked and found
        // nothing" is the answer most of the time, and not recording it means
        // looking again on every idle moment forever.
        reviewed: {...current.reviewed, [sessionId]: reviewed},
      };
    });
  }

  /** Removes one proposal, whether it was accepted or dismissed. */
  async remove(proposalId: string): Promise<MemoryProposalsFile> {
    return await this.mutate((current) => ({
      ...current,
      proposals: current.proposals.filter(
        (proposal) => proposal.id !== proposalId,
      ),
    }));
  }

  /** Forgets a conversation's watermark, for when it is deleted. */
  async forget(sessionId: string): Promise<MemoryProposalsFile> {
    return await this.mutate((current) => {
      const reviewed = {...current.reviewed};
      delete reviewed[sessionId];
      return {
        ...current,
        reviewed,
        proposals: current.proposals.filter(
          (proposal) => proposal.sessionId !== sessionId,
        ),
      };
    });
  }

  private async mutate(
    edit: (current: MemoryProposalsFile) => MemoryProposalsFile,
  ): Promise<MemoryProposalsFile> {
    return await this.withLock(async () => {
      /*
       * The filesystem lock as well as the queue above, because the queue is
       * only this process's. A review running while the app writes its own
       * dismissals would otherwise lose one of the two.
       */
      return await withFileLock(`${this.options.file}.lock`, async () => {
        /*
         * Refused before anything is written. A lenient read plus a write is
         * how a user's data disappears, and the leniency above is deliberate —
         * it is what lets the window open with an unreadable file rather than
         * refusing to start.
         */
        await assertWritable(this.options.file, {
          label: 'The memory proposals file',
        });

        const current = await this.load();
        const next = edit(current);
        const validated = memoryProposalsFileSchema.safeParse(next);
        if (!validated.success) {
          const detail = validated.error.issues
            .map((issue) => issue.path.join('.') || issue.message)
            .join('; ');
          throw new Error(
            `Refusing to store an invalid proposals document: ${detail}`,
          );
        }

        await mkdir(dirname(this.options.file), {recursive: true});
        const temporary = `${this.options.file}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(validated.data, null, 2)}\n`,
          'utf8',
        );
        await rename(temporary, this.options.file);
        this.cache = validated.data;
        return validated.data;
      });
    });
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}
