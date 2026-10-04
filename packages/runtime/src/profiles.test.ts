/**
 * Agent profiles on disk.
 *
 * The interesting parts are the invariants: there is always an active profile,
 * the active workspace always exists, a folder added twice is not listed twice,
 * and deleting a profile never claims the last one or touches a user's files.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  LastProfileError,
  ProfileStore,
  UnknownProfileError,
  workspaceLabel,
} from './profiles.js';

const TOOLS = ['read_file', 'write_file', 'run_shell'];
const SKILLS = ['reasoning', 'memory'];

describe('ProfileStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-profiles-'));
    file = join(dir, 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): ProfileStore {
    return new ProfileStore({
      file,
      defaultWorkspaceRoot: join(dir, 'home'),
      defaultIdentity: 'You are an agent.',
      defaultTools: TOOLS,
      defaultSkills: SKILLS,
    });
  }

  it('seeds one profile with the app default folder on first run', async () => {
    const snapshot = await store().load();
    expect(snapshot.profiles).toHaveLength(1);
    const profile = snapshot.profiles[0];
    expect(profile?.name).toBe('Marimo');
    expect(profile?.identity).toBe('You are an agent.');
    expect(profile?.enabledTools).toEqual(TOOLS);
    expect(profile?.enabledSkills).toEqual(SKILLS);
    expect(profile?.workspaces).toHaveLength(1);
    expect(profile?.activeWorkspaceId).toBe(profile?.workspaces[0]?.id);
  });

  it('keeps the workspace and prompt a pre-profile install had', async () => {
    const snapshot = await store().load({
      workspaceRoot: join(dir, 'legacy-project'),
      systemPrompt: 'You are the old prompt.',
    });
    const profile = snapshot.profiles[0];
    expect(profile?.identity).toBe('You are the old prompt.');
    expect(profile?.workspaces[0]?.path).toBe(join(dir, 'legacy-project'));
    expect(profile?.workspaces[0]?.name).toBe('legacy-project');
  });

  it('persists across stores', async () => {
    const first = store();
    await first.create('Research');
    const reopened = await store().load();
    expect(reopened.profiles.map((profile) => profile.name)).toEqual([
      'Marimo',
      'Research',
    ]);
    expect(reopened.activeProfileId).toBe(
      reopened.profiles[1]?.id ?? 'missing',
    );
  });

  it('moves the active pointer on select, and refuses an unknown one', async () => {
    const profiles = store();
    const first = await profiles.activeProfile();
    const second = await profiles.create('Second');
    expect(await profiles.activeProfileId()).toBe(second.id);

    await profiles.select(first.id);
    expect(await profiles.activeProfileId()).toBe(first.id);
    expect((await profiles.activeProfile()).name).toBe(first.name);

    await expect(profiles.select('missing')).rejects.toBeInstanceOf(
      UnknownProfileError,
    );
  });

  it('refuses a blank workspace name instead of persisting it', async () => {
    const profiles = store();
    const workspace = await profiles.addWorkspace(join(dir, 'project'));
    await expect(profiles.renameWorkspace(workspace.id, '   ')).rejects.toThrow(
      /cannot be empty/,
    );
    // The stored profile still satisfies its own schema, so nothing is lost.
    const stored = (await profiles.activeProfile()).workspaces.find(
      (entry) => entry.id === workspace.id,
    );
    expect(stored?.name).toBe('project');
  });

  it('falls back when the stored active profile no longer exists', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'ghost',
        profiles: [
          {
            id: 'real',
            name: 'Real',
            identity: '',
            workspaces: [],
            activeWorkspaceId: null,
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );
    const snapshot = await store().load();
    expect(snapshot.activeProfileId).toBe('real');
  });

  it('preserves an unreadable file instead of overwriting it', async () => {
    const original = '{ "profiles": "not an array" }';
    await writeFile(file, original, 'utf8');
    await store().load();
    // The unusable file is kept under another name, so a parse bug can never be
    // the end of a user's agents.
    const {readdir} = await import('node:fs/promises');
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes('unreadable'))).toBe(true);
  });

  it('creates a profile with unique names and switches to it', async () => {
    const profiles = store();
    const one = await profiles.create('Agent');
    const two = await profiles.create('Agent');
    expect(one.id).not.toBe(two.id);
    expect(two.name).toBe('Agent 2');
    expect(await profiles.activeProfileId()).toBe(two.id);
  });

  it('updates identity, tools and skills without duplicating names', async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    const updated = await profiles.update(profile.id, {
      identity: 'You are a researcher.',
      enabledTools: ['read_file', 'read_file'],
      enabledSkills: [],
    });
    expect(updated.identity).toBe('You are a researcher.');
    expect(updated.enabledTools).toEqual(['read_file']);
    expect(updated.enabledSkills).toEqual([]);
  });

  it('refuses an unknown profile', async () => {
    await expect(store().update('nope', {name: 'x'})).rejects.toBeInstanceOf(
      UnknownProfileError,
    );
  });

  it('adds a folder once and selects it', async () => {
    const profiles = store();
    const first = await profiles.addWorkspace(join(dir, 'project-a'));
    const second = await profiles.addWorkspace(join(dir, 'project-b'));
    const again = await profiles.addWorkspace(join(dir, 'project-a'));
    expect(again.id).toBe(first.id);
    expect(await profiles.activeWorkspace()).toMatchObject({
      id: first.id,
      path: join(dir, 'project-a'),
    });
    expect((await profiles.activeProfile()).workspaces).toHaveLength(3);
    expect(second.id).not.toBe(first.id);
  });

  it('labels a folder by its last segment', async () => {
    const profiles = store();
    const workspace = await profiles.addWorkspace(join(dir, 'my-app'));
    expect(workspace.name).toBe('my-app');
    expect(workspaceLabel('/')).toBe('/');
  });

  it('renames a folder without touching its path', async () => {
    const profiles = store();
    const workspace = await profiles.addWorkspace(join(dir, 'project'));
    const renamed = await profiles.renameWorkspace(
      workspace.id,
      '  Client work ',
    );
    expect(renamed.name).toBe('Client work');
    expect(renamed.path).toBe(workspace.path);
  });

  it('forgets a folder and falls back to another one', async () => {
    const profiles = store();
    const a = await profiles.addWorkspace(join(dir, 'a'));
    const b = await profiles.addWorkspace(join(dir, 'b'));
    await profiles.removeWorkspace(b.id);
    const profile = await profiles.activeProfile();
    const remaining = profile.workspaces.map((entry) => entry.id);
    expect(remaining).toContain(a.id);
    // The seeded default folder is still there alongside the added one.
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(b.id);
    // The active pointer moves rather than dangling at a folder that is gone.
    expect(remaining).toContain(profile.activeWorkspaceId);
  });

  it('refuses to delete the last profile', async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    await expect(profiles.remove(profile.id)).rejects.toBeInstanceOf(
      LastProfileError,
    );
  });

  it('moves the active profile when the active one is deleted', async () => {
    const profiles = store();
    const second = await profiles.create('Second');
    const snapshot = await profiles.remove(second.id);
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.activeProfileId).toBe(snapshot.profiles[0]?.id);
  });

  it('recovers from a corrupt file by seeding a fresh profile', async () => {
    await writeFile(file, '{ not json', 'utf8');
    const snapshot = await store().load();
    expect(snapshot.profiles).toHaveLength(1);
    // And the file is usable again.
    const repaired = JSON.parse(await readFile(file, 'utf8')) as {
      profiles: unknown[];
    };
    expect(repaired.profiles).toHaveLength(1);
  });

  it('drops a profile that does not match the schema', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'good',
        profiles: [
          {
            id: 'good',
            name: 'Good',
            identity: '',
            workspaces: [],
            activeWorkspaceId: null,
            enabledTools: [],
            enabledSkills: [],
          },
          {id: 'bad', name: '', identity: 42},
        ],
      }),
      'utf8',
    );
    const snapshot = await store().load();
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(['good']);
    expect(snapshot.activeProfileId).toBe('good');
  });

  /*
   * The first-run race.
   *
   * The window and the headless runner — or simply two calls from one of them —
   * can ask for the profile file before either has read it. Both then find no
   * file, both create a profile, and both write: each holds a profile with its
   * own random id, only one is on disk, and the other caller is left with an
   * agent that does not exist. It showed up as "there is no agent called <id>"
   * from a window that had been handed that id a moment earlier.
   *
   * Memoising the read as a *promise* rather than as a value is the fix: the
   * second caller waits for the first instead of starting its own.
   */
  it('gives concurrent first reads the same profile', async () => {
    const instance = store();
    const [first, second, third] = await Promise.all([
      instance.load(),
      instance.load(),
      instance.load(),
    ]);

    expect(first.activeProfileId).toBe(second.activeProfileId);
    expect(second.activeProfileId).toBe(third.activeProfileId);
    expect(first.profiles).toHaveLength(1);
  });

  it('leaves exactly one profile on disk after concurrent first reads', async () => {
    const instance = store();
    await Promise.all([instance.load(), instance.load()]);

    // Re-read from a fresh store, so this is what was actually written rather
    // than what a cache remembers.
    const reread = await store().load();
    expect(reread.profiles).toHaveLength(1);
  });
});
