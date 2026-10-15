import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import type {DreamTree} from '@marimo/protocol';

import {DreamStore} from './dream-store.js';

/**
 * A tree with one call in it, which is the smallest document the replay will
 * look at. Built by hand rather than through the recorder so that a store test
 * states the document it is about.
 */
function tree(sessionId: string, invocationId: string): DreamTree {
  const at = '2026-09-14T00:00:00.000Z';
  return {
    version: 1,
    sessionId,
    invocationId,
    startedAt: at,
    outcome: 'answered',
    policy: {explorationWeight: 1, pruningThreshold: -1},
    nodes: [
      {
        id: `${invocationId}-root`,
        kind: 'turn',
        depth: 0,
        invocationId,
        allowed: true,
        at,
      },
      {
        id: `${invocationId}-call`,
        parentId: `${invocationId}-root`,
        kind: 'call',
        depth: 1,
        invocationId,
        tool: 'read_file',
        result: 'ok',
        reward: {value: 1, reason: 'returned a result'},
        allowed: true,
        at,
      },
    ],
  };
}

async function storeUnder(
  options: {keepLogs?: number} = {},
): Promise<{store: DreamStore; dir: string}> {
  // `mkdtemp` under the working directory rather than `/tmp`, so a sandbox that
  // only permits writes inside the repository still runs these.
  const dir = await mkdtemp(join(process.cwd(), '.marimo-dream-'));
  return {
    dir,
    store: new DreamStore({dir, keepLogs: () => options.keepLogs ?? 200}),
  };
}

describe('DreamStore', () => {
  it('answers an absent file with an empty list and no problem', async () => {
    const {store} = await storeUnder();
    // Somebody who has never turned the feature on is not a failure.
    expect(await store.load('missing')).toEqual({sessionId: 'missing', trees: []});
  });

  it('writes a turn and reads it back', async () => {
    const {store} = await storeUnder();
    await store.append(tree('session-1', 'inv-1'));
    const loaded = await store.load('session-1');
    expect(loaded.problem).toBeUndefined();
    expect(loaded.trees).toHaveLength(1);
    expect(loaded.trees[0]?.invocationId).toBe('inv-1');
  });

  it('replaces a turn rather than appending a second copy of it', async () => {
    const {store} = await storeUnder();
    // A turn's tree is flushed several times as it runs, and each flush is a
    // whole snapshot of the *same* turn. Without the invocation key the file
    // would hold dozens of near-identical copies and a replay would count them
    // all as separate evidence.
    await store.append(tree('session-1', 'inv-1'));
    await store.append(tree('session-1', 'inv-1'));
    expect(await store.count('session-1')).toBe(1);
  });

  it('keeps the turns of one conversation and separates two', async () => {
    const {store} = await storeUnder();
    await store.append(tree('session-1', 'inv-1'));
    await store.append(tree('session-1', 'inv-2'));
    await store.append(tree('session-2', 'inv-3'));
    expect(await store.count('session-1')).toBe(2);
    expect(await store.count('session-2')).toBe(1);
    expect((await store.loadAll()).filter((e) => e.trees.length > 0)).toHaveLength(2);
  });

  it('drops the oldest turn once the cap is reached', async () => {
    const {store} = await storeUnder({keepLogs: 2});
    await store.append(tree('session-1', 'inv-1'));
    await store.append(tree('session-1', 'inv-2'));
    await store.append(tree('session-1', 'inv-3'));
    const loaded = await store.load('session-1');
    // The turn that just ran is the one that survives the trim.
    expect(loaded.trees.map((entry) => entry.invocationId)).toEqual([
      'inv-2',
      'inv-3',
    ]);
  });

  it('answers an unreadable file with empty trees and a reason', async () => {
    const {store, dir} = await storeUnder();
    await writeFile(join(dir, 'session-1.json'), 'not json at all', 'utf8');
    const loaded = await store.load('session-1');
    expect(loaded.trees).toEqual([]);
    expect(loaded.problem).toContain('could not be read');
  });

  it('moves an unreadable file aside before writing over it', async () => {
    const {store, dir} = await storeUnder();
    const file = join(dir, 'session-1.json');
    await writeFile(file, '{"version": 1, "trees": "not an array"', 'utf8');
    await store.append(tree('session-1', 'inv-1'));
    // The lenient read plus an unguarded write is how a user's data disappears:
    // the corrupt file becomes an empty one and the evidence of what went wrong
    // is gone with it.
    const aside = await readFile(`${file}.unreadable`, 'utf8');
    expect(aside).toContain('not an array');
    expect(await store.count('session-1')).toBe(1);
  });

  it('leaves a newer file alone and says so', async () => {
    const {store, dir} = await storeUnder();
    const file = join(dir, 'session-1.json');
    await writeFile(
      file,
      `${JSON.stringify({version: 99, sessionId: 'session-1', trees: []})}\n`,
      'utf8',
    );
    const loaded = await store.load('session-1');
    expect(loaded.trees).toEqual([]);
    expect(loaded.problem).toContain('newer version');
    // Left untouched: refusing to read a newer document is the point, and a
    // refusal that rewrote it would be the opposite.
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({version: 99});
  });

  it('drops one tree that does not validate rather than the whole file', async () => {
    const {store, dir} = await storeUnder();
    const file = join(dir, 'session-1.json');
    await writeFile(
      file,
      `${JSON.stringify({
        version: 1,
        sessionId: 'session-1',
        updatedAt: '2026-09-14T00:00:00.000Z',
        trees: [tree('session-1', 'inv-1'), {nonsense: true}],
      })}\n`,
      'utf8',
    );
    // Losing one turn beats losing a conversation's history to one bad entry.
    expect((await store.load('session-1')).trees).toHaveLength(1);
  });

  it('forgets a conversation without failing when there is nothing to forget', async () => {
    const {store} = await storeUnder();
    await store.append(tree('session-1', 'inv-1'));
    await store.forget('session-1');
    expect(await store.count('session-1')).toBe(0);
    await store.forget('session-1');
  });

  it('reports the last failed write, and stops reporting it once one lands', async () => {
    const {store, dir} = await storeUnder();
    const file = join(dir, 'session-1.json');
    expect(store.problem()).toBeUndefined();

    /*
     * A newer file is the cheapest way to make the *write* path fail: it is the
     * one failure the store raises rather than swallows, and it needs no
     * permission trickery that a sandbox would turn into a skipped test.
     */
    await writeFile(
      file,
      `${JSON.stringify({version: 99, sessionId: 'session-1', trees: []})}\n`,
      'utf8',
    );
    await store.append(tree('session-1', 'inv-1'));
    expect(store.problem()).toContain('newer version');

    /*
     * A status rather than a message: the card is drawn from a payload the window
     * reads for its own reasons, so clearing on read could swallow the news. What
     * clears it is the thing it describes — a write that worked.
     */
    expect(store.problem()).toContain('newer version');
    await rm(file, {force: true});
    await store.append(tree('session-1', 'inv-2'));
    expect(store.problem()).toBeUndefined();
    expect(await store.count('session-1')).toBe(1);
  });
});
