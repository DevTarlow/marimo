/**
 * Where the agent's suggestions wait for an answer.
 *
 * The watermark is what most of this covers, because it decides whether the
 * feature is usable at all: a review that forgot how far it had read would
 * re-propose the same facts every time the app went quiet, and a queue that
 * refills itself with things already dismissed is one nobody opens.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  MAX_PENDING_PROPOSALS,
  MemoryProposalStore,
} from './memory-proposals.js';
import type {NewProposal} from './memory-proposals.js';

function proposal(overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    sessionId: 'session-1',
    profileId: 'profile-1',
    section: 'Notes',
    text: 'Prefers tabs over spaces.',
    reason: 'they said so',
    ...overrides,
  };
}

describe('the proposal store', () => {
  let dir: string;
  let file: string;
  let store: MemoryProposalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-proposals-'));
    file = join(dir, 'memory-proposals.json');
    store = new MemoryProposalStore({file});
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('starts with nothing waiting and nothing reviewed', async () => {
    const file = await store.load();
    expect(file.proposals).toEqual([]);
    expect(file.reviewed).toEqual({});
  });

  it('records a proposal with an id and a time', async () => {
    const after = await store.record('session-1', 4, [proposal()]);

    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]?.id).toBeTruthy();
    expect(after.proposals[0]?.createdAt).toBeTruthy();
    expect(after.proposals[0]?.text).toBe('Prefers tabs over spaces.');
  });

  it('survives a restart', async () => {
    await store.record('session-1', 4, [proposal()]);
    const reopened = await new MemoryProposalStore({file}).load();
    expect(reopened.proposals).toHaveLength(1);
  });

  describe('the watermark', () => {
    it('starts at zero for a conversation nobody has reviewed', async () => {
      expect(await store.reviewedUpTo('session-9')).toBe(0);
    });

    it('remembers how far it read', async () => {
      await store.record('session-1', 12, []);
      expect(await store.reviewedUpTo('session-1')).toBe(12);
    });

    /*
     * The behaviour this exists to prevent. "I looked and found nothing" is the
     * answer most of the time, and not recording it means looking again on every
     * idle moment forever — spending tokens to be told nothing, repeatedly.
     */
    it('moves even when nothing was proposed', async () => {
      await store.record('session-1', 7, []);
      expect(await store.reviewedUpTo('session-1')).toBe(7);
      expect((await store.load()).proposals).toEqual([]);
    });

    it('keeps each conversation apart', async () => {
      await store.record('session-1', 3, []);
      await store.record('session-2', 9, []);
      expect(await store.reviewedUpTo('session-1')).toBe(3);
      expect(await store.reviewedUpTo('session-2')).toBe(9);
    });

    it('survives a restart, which is the whole point of storing it', async () => {
      await store.record('session-1', 11, []);
      expect(await new MemoryProposalStore({file}).reviewedUpTo('session-1')).toBe(
        11,
      );
    });
  });

  describe('the queue', () => {
    /*
     * The reviewer filters against memory.md; this filters against the queue,
     * which is the other way the same fact arrives twice — a conversation
     * reviewed, then reviewed again from a slightly different watermark.
     */
    it('does not add the same fact twice', async () => {
      await store.record('session-1', 1, [proposal()]);
      const after = await store.record('session-1', 2, [proposal()]);
      expect(after.proposals).toHaveLength(1);
    });

    it('keeps the same fact for two different agents', async () => {
      // Two agents may legitimately remember the same thing; they are separate
      // memories and separate system prompts.
      await store.record('session-1', 1, [proposal()]);
      const after = await store.record('session-1', 2, [
        proposal({profileId: 'profile-2'}),
      ]);
      expect(after.proposals).toHaveLength(2);
    });

    it('drops the oldest when it is full', async () => {
      for (let index = 0; index < MAX_PENDING_PROPOSALS + 3; index += 1) {
        await store.record('session-1', index, [
          proposal({text: `Fact number ${String(index)}.`}),
        ]);
      }
      const after = await store.load();

      expect(after.proposals).toHaveLength(MAX_PENDING_PROPOSALS);
      // The newest survive: they are about the conversation the user just had.
      expect(after.proposals.at(-1)?.text).toBe(
        `Fact number ${String(MAX_PENDING_PROPOSALS + 2)}.`,
      );
      expect(after.proposals[0]?.text).toBe('Fact number 3.');
    });

    it('removes one, whether it was accepted or dismissed', async () => {
      const withOne = await store.record('session-1', 1, [proposal()]);
      const id = withOne.proposals[0]?.id ?? '';

      const after = await store.remove(id);

      expect(after.proposals).toEqual([]);
      // The watermark stays: dismissing is an answer, not a reason to look again.
      expect(after.reviewed['session-1']).toBe(1);
    });

    it('ignores a removal for something already gone', async () => {
      await expect(store.remove('no-such-id')).resolves.toMatchObject({
        proposals: [],
      });
    });

    it('forgets a deleted conversation, watermark and all', async () => {
      await store.record('session-1', 5, [proposal()]);
      // A different fact, so the queue's own dedupe does not collapse the two —
      // which is what it correctly does for the *same* fact from two places.
      await store.record('session-2', 5, [
        proposal({sessionId: 'session-2', text: 'Works in Rust.'}),
      ]);

      const after = await store.forget('session-1');

      expect(after.proposals.map((entry) => entry.sessionId)).toEqual([
        'session-2',
      ]);
      expect(after.reviewed['session-1']).toBeUndefined();
      expect(after.reviewed['session-2']).toBe(5);
    });
  });

  describe('the file', () => {
    it('writes a versioned document', async () => {
      await store.record('session-1', 1, [proposal()]);
      const written = JSON.parse(await readFile(file, 'utf8')) as {
        version: number;
      };
      expect(written.version).toBe(1);
    });

    /*
     * The window still opens on a file it cannot read. Only the write path is
     * strict — a lenient read plus a careless write is how data disappears, so
     * the write is the half that has to refuse.
     */
    it('reads an unreadable file as empty rather than refusing to start', async () => {
      await writeFile(file, 'not json at all', 'utf8');
      expect(await new MemoryProposalStore({file}).load()).toMatchObject({
        proposals: [],
      });
    });

    it('refuses a file from a newer build', async () => {
      await writeFile(file, JSON.stringify({version: 99}), 'utf8');
      await expect(new MemoryProposalStore({file}).load()).rejects.toThrow(
        /newer version/u,
      );
    });

    it('refuses to write over a file from a newer build', async () => {
      const future = JSON.stringify({version: 99});
      await writeFile(file, future, 'utf8');

      await expect(store.record('session-1', 1, [proposal()])).rejects.toThrow(
        /newer version/u,
      );
      expect(await readFile(file, 'utf8')).toBe(future);
    });

    it('leaves no half-file behind', async () => {
      await store.record('session-1', 1, [proposal()]);
      const {readdir} = await import('node:fs/promises');
      const leftovers = (await readdir(dir)).filter((name) =>
        name.endsWith('.tmp'),
      );
      expect(leftovers).toEqual([]);
    });
  });
});
