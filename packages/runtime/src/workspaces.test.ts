/**
 * The folders every agent works in.
 *
 * Two things are worth testing here and they are not the CRUD: the *adoption* of
 * the folders a pre-workspaces file carried — where getting it wrong loses a
 * user's conversations to the "Other chats" bucket — and the rule that a folder
 * is only ever forgotten. Nothing in this store may touch the directory, because
 * "remove from list" is what the menu says and what the user agreed to.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {Workspace} from '@marimo/protocol';

import {
  WorkspaceStore,
  workspaceLabel,
  workspaceRootFor,
} from './workspaces.js';
import type {LegacyWorkspaces} from './workspaces.js';

describe('WorkspaceStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-workspaces-'));
    file = join(dir, 'workspaces.json');
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(
    options: {
      adoptLegacy?: () => Promise<LegacyWorkspaces | undefined>;
      onAdopted?: () => Promise<void>;
    } = {},
  ): WorkspaceStore {
    return new WorkspaceStore({
      file,
      defaultWorkspaceRoot: join(dir, 'home'),
      ...options,
    });
  }

  it('seeds one folder at the default root on first run', async () => {
    const snapshot = await store().load();
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.workspaces[0]?.path).toBe(join(dir, 'home'));
    expect(snapshot.workspaces[0]?.name).toBe('home');
    expect(snapshot.activeWorkspaceId).toBe(snapshot.workspaces[0]?.id);
  });

  it('adds a folder once and makes it current', async () => {
    const workspaces = store();
    const seeded = await workspaces.active();
    const first = await workspaces.add(join(dir, 'project-a'));
    const second = await workspaces.add(join(dir, 'project-b'));
    const again = await workspaces.add(join(dir, 'project-a'));

    expect(again.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect((await workspaces.workspaces()).map((entry) => entry.id)).toEqual([
      seeded?.id,
      first.id,
      second.id,
    ]);
    // Adding selects, and adding the same folder again selects it back.
    expect(await workspaces.activeWorkspaceId()).toBe(first.id);
  });

  it('selects without adding', async () => {
    const workspaces = store();
    const first = await workspaces.active();
    const second = await workspaces.add(join(dir, 'project'));
    await workspaces.select(first?.id ?? '');
    expect(await workspaces.activeWorkspaceId()).toBe(first?.id);
    expect(await workspaces.byId(second.id)).toBeDefined();
  });

  it('refuses an unknown folder instead of inventing one', async () => {
    await expect(store().select('gone')).rejects.toThrow(/Unknown workspace/u);
    await expect(store().remove('gone')).rejects.toThrow(/Unknown workspace/u);
  });

  it('renames without touching the path, and refuses a blank name', async () => {
    const workspaces = store();
    const workspace = await workspaces.add(join(dir, 'project'));
    const renamed = await workspaces.rename(workspace.id, '  Client work ');
    expect(renamed.name).toBe('Client work');
    expect(renamed.path).toBe(join(dir, 'project'));
    expect(await workspaces.byId(workspace.id)).toMatchObject({
      name: 'Client work',
    });

    await expect(workspaces.rename(workspace.id, '   ')).rejects.toThrow(
      /cannot be empty/u,
    );
  });

  it('moves the current folder when the current one is forgotten', async () => {
    const workspaces = store();
    const a = await workspaces.add(join(dir, 'a'));
    const b = await workspaces.add(join(dir, 'b'));
    expect(await workspaces.activeWorkspaceId()).toBe(b.id);

    const after = await workspaces.remove(b.id);
    expect(after.workspaces.map((entry) => entry.id)).not.toContain(b.id);
    // The current pointer moves to the first one left rather than dangling at a
    // folder that is gone.
    expect(after.activeWorkspaceId).toBe(after.workspaces[0]?.id);
    expect(after.workspaces.map((entry) => entry.id)).toContain(a.id);
  });

  it('answers no current folder when the last one is forgotten', async () => {
    const workspaces = store();
    const only = await workspaces.active();
    const after = await workspaces.remove(only?.id ?? '');
    expect(after.workspaces).toEqual([]);
    expect(after.activeWorkspaceId).toBeNull();
  });

  /*
   * The one thing "remove from list" must never mean. The folder, and everything
   * in it, is the user's — the store has never read or written it, and this is
   * the assertion that keeps that true.
   */
  it('leaves the directory and its contents alone', async () => {
    const workspaces = store();
    const workspace = await workspaces.add(join(dir, 'mine'));
    await mkdir(workspace.path, {recursive: true});
    await writeFile(join(workspace.path, 'notes.txt'), 'keep me', 'utf8');

    await workspaces.remove(workspace.id);

    expect(await readFile(join(workspace.path, 'notes.txt'), 'utf8')).toBe(
      'keep me',
    );
  });

  describe('adopting the folders a pre-workspaces file carried', () => {
    const legacy = (
      workspaces: Workspace[],
      activeWorkspaceId: string | null,
    ): LegacyWorkspaces => ({workspaces, activeWorkspaceId});

    it('takes every id, so no conversation is unfiled', async () => {
      let adopted = false;
      const workspaces = store({
        adoptLegacy: async () =>
          legacy(
            [
              {id: 'ws-a', name: 'project', path: join(dir, 'project')},
              // The same path under a second id: two profiles seeded on one
              // machine both created this, and a conversation names one of them.
              {id: 'ws-b', name: 'project', path: join(dir, 'project')},
              {id: 'ws-c', name: 'other', path: join(dir, 'other')},
            ],
            'ws-c',
          ),
        onAdopted: async () => {
          adopted = true;
        },
      });

      const snapshot = await workspaces.load();
      expect(snapshot.workspaces.map((entry) => entry.id)).toEqual([
        'ws-a',
        'ws-b',
        'ws-c',
      ]);
      expect(snapshot.activeWorkspaceId).toBe('ws-c');
      // The file the folders came from is only cleared after this write.
      expect(adopted).toBe(true);
    });

    it('drops a repeated id rather than listing it twice', async () => {
      const snapshot = await store({
        adoptLegacy: async () =>
          legacy(
            [
              {id: 'ws-a', name: 'one', path: join(dir, 'one')},
              {id: 'ws-a', name: 'one', path: join(dir, 'one')},
            ],
            'ws-a',
          ),
      }).load();
      expect(snapshot.workspaces).toHaveLength(1);
    });

    it('falls back to the first folder when the current one is gone', async () => {
      const snapshot = await store({
        adoptLegacy: async () =>
          legacy(
            [{id: 'ws-a', name: 'one', path: join(dir, 'one')}],
            'never-existed',
          ),
      }).load();
      expect(snapshot.activeWorkspaceId).toBe('ws-a');
    });

    it('seeds the default when the old file held no folders at all', async () => {
      let adopted = false;
      const snapshot = await store({
        adoptLegacy: async () => legacy([], null),
        onAdopted: async () => {
          adopted = true;
        },
      }).load();
      expect(snapshot.workspaces[0]?.path).toBe(join(dir, 'home'));
      // An empty legacy list is still something to clear, so the fields do not
      // go on being read on every launch.
      expect(adopted).toBe(true);
    });

    it('does not look at the old file once a document exists', async () => {
      let calls = 0;
      const first = store({
        adoptLegacy: async () => {
          calls += 1;
          return legacy(
            [{id: 'ws-a', name: 'one', path: join(dir, 'one')}],
            'ws-a',
          );
        },
      });
      await first.load();

      const reopened = store({
        adoptLegacy: async () => {
          calls += 1;
          return undefined;
        },
      });
      const snapshot = await reopened.load();
      expect(calls).toBe(1);
      expect(snapshot.workspaces[0]?.id).toBe('ws-a');
    });
  });

  it('preserves an unreadable file instead of overwriting it', async () => {
    await writeFile(file, '{ not json', 'utf8');
    const snapshot = await store().load();
    expect(snapshot.workspaces).toHaveLength(1);
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes('unreadable'))).toBe(true);
  });

  it('refuses a file from a newer build, leaving it where it is', async () => {
    const written = JSON.stringify({version: 99, workspaces: []});
    await writeFile(file, written, 'utf8');
    await expect(store().load()).rejects.toThrow(/newer version/u);
    expect(await readFile(file, 'utf8')).toBe(written);
  });

  it('gives concurrent first reads the same document', async () => {
    const instance = store();
    const [first, second] = await Promise.all([
      instance.load(),
      instance.load(),
    ]);
    expect(first.activeWorkspaceId).toBe(second.activeWorkspaceId);
    expect(first.workspaces).toHaveLength(1);
  });
});

describe('workspaceLabel', () => {
  it('uses the last segment, and the path itself when there is none', () => {
    expect(workspaceLabel('/home/someone/my-app')).toBe('my-app');
    expect(workspaceLabel('/')).toBe('/');
  });
});

/*
 * The rule the feature rests on: a turn runs in the folder its conversation is
 * filed under, not in whichever folder happens to be current. The fallbacks are
 * the interesting half — a conversation with no folder, and one whose folder has
 * been forgotten, both have to land somewhere real.
 */
describe('workspaceRootFor', () => {
  const file = {
    version: 1 as const,
    workspaces: [
      {id: 'ws-a', name: 'a', path: '/home/a'},
      {id: 'ws-b', name: 'b', path: '/home/b'},
    ],
    activeWorkspaceId: 'ws-b',
  };

  it('prefers the conversation own folder', () => {
    expect(workspaceRootFor(file, 'ws-a')).toBe('/home/a');
  });

  it('falls back to the current folder for an unfiled conversation', () => {
    expect(workspaceRootFor(file, undefined)).toBe('/home/b');
    expect(workspaceRootFor(file, null)).toBe('/home/b');
  });

  it('falls back for a folder that has been forgotten', () => {
    expect(workspaceRootFor(file, 'gone')).toBe('/home/b');
  });

  it('answers nothing when there are no folders at all', () => {
    expect(
      workspaceRootFor({version: 1, workspaces: [], activeWorkspaceId: null}),
    ).toBeUndefined();
  });
});
