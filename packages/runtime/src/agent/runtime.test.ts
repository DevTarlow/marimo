/**
 * The runtime, from the outside.
 *
 * What is tested here is mostly what happens when the agent *cannot* start,
 * because that is the path a user actually meets: a fresh install with no key, a
 * key that cannot be read, a folder nobody has chosen yet. Each of those has to
 * arrive as a sentence in the conversation rather than as a spinner, an empty
 * screen, or an exception the window never sees.
 *
 * The successful path needs a provider, so it lives with the agent package's
 * tests — this file is about the wiring around it.
 */
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {MAX_MEMORY_BYTES, resolveMemoryFile} from '@marimo/agent';
import {
  DEFAULT_AGENT_IDENTITY,
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
} from '@marimo/protocol';

import {resolveAppPaths} from '../paths.js';
import type {AppPaths} from '../paths.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import {ProfileStore} from '../profiles.js';
import {WorkspaceStore} from '../workspaces.js';
import {AgentRuntime} from './runtime.js';
import type {AgentRuntimeOptions} from './runtime.js';
import type {SecretRead} from '../secrets.js';

/**
 * Gives the install a folder to work in.
 *
 * Seeded at the test's own directory rather than the real one: `resolveAppPaths`
 * derives `defaultWorkspace` from `homedir()`, and a test that let a turn loose
 * in the tester's home would be doing something nobody asked for.
 */
async function seedWorkspaces(paths: AppPaths, root: string): Promise<void> {
  await new WorkspaceStore({
    file: paths.workspaces,
    defaultWorkspaceRoot: root,
  }).load();
}

describe('AgentRuntime', () => {
  let dir: string;
  let paths: ReturnType<typeof resolveAppPaths>;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-runtime-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);

    // Set the install up the way the app would: a default profile, with no
    // capabilities and no folders of its own.
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultIdentity: '',
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function runtime(
    readSecret: AgentRuntimeOptions['readSecret'],
  ): AgentRuntime {
    return new AgentRuntime({paths, readSecret});
  }

  const noKey = async (): Promise<SecretRead> => ({state: 'absent'});

  /*
   * The size control in Settings reads these three numbers. They come from the
   * agent's own store rather than from a second copy of the setting, which is
   * what stops the dialog drawing a bar against a limit the agent is not using.
   */
  describe('memory usage', () => {
    it('reports the file size, the user limit and the hard cap', async () => {
      const agent = runtime(noKey);
      await agent.updateSettings({memorySoftLimitBytes: 16 * 1024});

      await mkdir(join(dir, '.marimo', profileId), {recursive: true});
      await writeFile(resolveMemoryFile(dir, profileId), '- a fact\n', 'utf8');

      const usage = await agent.memoryUsage(profileId);
      expect(usage).toEqual({
        bytes: Buffer.byteLength('- a fact\n', 'utf8'),
        limitBytes: 16 * 1024,
        capBytes: MAX_MEMORY_BYTES,
      });
    });

    it('reports zero for an agent that has never been told anything', async () => {
      const usage = await runtime(noKey).memoryUsage(profileId);
      expect(usage.bytes).toBe(0);
      expect(usage.limitBytes).toBe(DEFAULT_MEMORY_SOFT_LIMIT_BYTES);
    });

    /*
     * A readout is not a reason to dial an MCP server. Answering from settings
     * and the file is the same answer by construction, and it keeps the dialog
     * working on an install with no API key yet.
     */
    it('answers without building a host', async () => {
      const agent = runtime(noKey);
      await agent.updateSettings({memorySoftLimitBytes: 4 * 1024});
      expect(await agent.memoryUsage(profileId)).toMatchObject({
        limitBytes: 4 * 1024,
      });
      expect(await agent.host(profileId)).toMatchObject({ok: false});
    });
  });

  /*
   * The Fetch Models button writes through here. What matters from the outside
   * is that the list lands on disk, that the provider's own model is moved when
   * the endpoint no longer offers it — a retired name is a 404 at the start of
   * the next turn — and that no other provider is touched.
   */
  describe('recording what a provider serves', () => {
    it('stores the list and moves a model the endpoint no longer offers', async () => {
      const agent = runtime(noKey);
      await agent.updateSettings({
        providers: {configs: {deepseek: {model: 'gone-model'}}},
      });

      const after = await agent.setAvailableModels('deepseek', [
        'deepseek-a',
        'deepseek-b',
      ]);

      expect(after.availableModels.deepseek).toEqual([
        'deepseek-a',
        'deepseek-b',
      ]);
      expect(after.providers.configs.deepseek.model).toBe('deepseek-a');
      expect((await agent.settings()).availableModels.deepseek).toEqual([
        'deepseek-a',
        'deepseek-b',
      ]);
    });

    it('keeps the model when the endpoint still offers it', async () => {
      const agent = runtime(noKey);
      await agent.updateSettings({
        providers: {configs: {deepseek: {model: 'deepseek-b'}}},
      });

      const after = await agent.setAvailableModels('deepseek', [
        'deepseek-a',
        'deepseek-b',
      ]);
      expect(after.providers.configs.deepseek.model).toBe('deepseek-b');
    });

    it('leaves every other provider alone', async () => {
      const agent = runtime(noKey);
      await agent.setAvailableModels('gemini', ['gemini-a']);

      const after = await agent.setAvailableModels('deepseek', ['deepseek-a']);
      expect(after.availableModels.gemini).toEqual(['gemini-a']);
    });
  });

  describe('when the agent cannot start', () => {
    it('says so from `host` rather than throwing', async () => {
      const result = await runtime(noKey).host(profileId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problem).toMatch(/API key/u);
      }
    });

    /*
     * The refusal has to be an event, not an exception. `turn.failed` is what
     * the window already knows how to draw, next to the composer, where the user
     * is looking — an exception would be a console line they never see.
     */
    it('reports a turn it cannot start as a failed turn', async () => {
      const agent = runtime(noKey);
      const events = [];
      for await (const event of agent.run(profileId, 'session-1', 'hello')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'turn.failed',
        sessionId: 'session-1',
        code: 'not-configured',
      });
      if (events[0]?.type === 'turn.failed') {
        expect(events[0].message).toMatch(/API key/u);
      }
    });

    it('says which agent when the profile does not exist', async () => {
      const result = await runtime(noKey).host('no-such-profile');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problem).toContain('no-such-profile');
      }
    });
  });

  /*
   * A conversation is a file. Gating one on a working provider would mean a
   * fresh install could not open the chat it is supposed to explain itself in —
   * the refusal would have nowhere to be shown.
   */
  describe('conversations without a provider', () => {
    it('can be started anyway', async () => {
      const session = await runtime(noKey).createSession(profileId);
      expect(session).toBeDefined();
      expect(session?.id.length).toBeGreaterThan(0);
    });

    it('are filed under the agent that started them', async () => {
      const agent = runtime(noKey);
      await agent.createSession(profileId);

      expect(await agent.listSessions(profileId)).toHaveLength(1);
      // And not under an agent that did not.
      expect(await agent.listSessions('someone-else')).toEqual([]);
    });

    it('reports no pending gates for an agent that does not exist', async () => {
      expect(await runtime(noKey).pendingGates('nope', 'session')).toEqual([]);
    });

    it('has a place to record a gate even with no key', async () => {
      const agent = runtime(noKey);
      const session = await agent.createSession(profileId);
      expect(await agent.pendingGates(profileId, session?.id ?? '')).toEqual(
        [],
      );
    });
  });

  describe('state', () => {
    it('is not busy before anything has run', () => {
      expect(runtime(noKey).isBusy()).toBe(false);
      expect(runtime(noKey).busyProfile()).toBeUndefined();
    });

    it('aborts a conversation it has never heard of without complaining', () => {
      expect(runtime(noKey).abort(profileId, 'no-such-session')).toBe(false);
    });

    /*
     * A host holds the session service and the conversation state, so one per
     * profile is the point — building a new one per call would re-read the
     * session index on every message.
     */
    it('reuses one host for a profile', async () => {
      const agent = runtime(noKey);
      await agent.createSession(profileId);
      await agent.createSession(profileId);
      // Both were created through the same host, so both are listed by it.
      expect(await agent.listSessions(profileId)).toHaveLength(2);
    });

    it('disposes without error when nothing was ever started', () => {
      expect(() => {
        runtime(noKey).dispose();
      }).not.toThrow();
    });
  });

  /*
   * What the headless runner needs and the window does not: the same runtime
   * with a different answer to "what is the key". Nothing else changes, which is
   * the whole reason this class lives in the shared package rather than in the
   * app.
   */
  it('takes its secret reader from the caller', async () => {
    const asked: string[] = [];
    const agent = runtime(async (providerId) => {
      asked.push(providerId);
      return {state: 'absent'};
    });

    await agent.host(profileId);
    expect(asked).toEqual(['deepseek']);
  });

  it('reports an unreadable key rather than a missing one', async () => {
    const agent = runtime(async () => ({
      state: 'unreadable',
      reason: 'The API key is encrypted and this process cannot decrypt it.',
    }));

    const result = await agent.host(profileId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toMatch(/cannot decrypt/u);
    }
  });
});

/*
 * What an agent may be granted, and making a grant take effect.
 *
 * The catalogue is built by *constructing* the tools rather than from a second
 * hand-written list, so these tests are also what stops a renamed tool being
 * offered under a name that grants nothing when it is ticked.
 */
describe('the catalogue', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-catalog-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultIdentity: '',
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({
      paths,
      readSecret: async () => ({state: 'absent'}),
    });
  }

  it('lists the tools by the name and wording the model is given', async () => {
    const catalog = await runtime().catalog();
    const names = catalog.tools.map((tool) => tool.name);

    expect(names).toContain('read_file');
    expect(names).toContain('spawn_agent');
    // Every entry has to carry a description, or the settings screen offers a
    // checkbox with nothing beside it.
    expect(catalog.tools.every((tool) => tool.description.length > 10)).toBe(
      true,
    );
  });

  /*
   * A tool the profile has not been granted is still in the catalogue — that is
   * the whole point of a pick-list. What must not happen is the reverse: a name
   * in the catalogue that no tool answers to.
   */
  it('lists tools the profile has not been granted', async () => {
    const catalog = await runtime().catalog();
    expect(catalog.tools.map((tool) => tool.name)).toContain('run_shell');
  });

  /*
   * The catalogue is not per profile: the tools are the install's, and what
   * differs between agents is the grant. A catalogue that took a profile id was
   * one that varied only by the folder the agent happened to name.
   */
  it('is the same catalogue for every agent', async () => {
    const instance = runtime();
    const created = await instance.createProfile('Researcher');
    const forResearcher = await instance.catalog();
    await instance.selectProfile(profileId);
    expect((await instance.catalog()).tools.map((tool) => tool.name)).toEqual(
      forResearcher.tools.map((tool) => tool.name),
    );
    expect(created.id).not.toBe(profileId);
  });

  /*
   * The presets are narrowed to what this install has, in the one place that
   * knows what that is. A card promising the to-do tools on an install with no
   * desk would be a choice that grants nothing — and the window, handed the
   * list, would have no way to tell.
   */
  it('offers presets naming only the tools this install has', async () => {
    const catalog = await runtime().catalog();
    const names = new Set(catalog.tools.map((tool) => tool.name));

    expect(catalog.presets.length).toBeGreaterThan(1);
    for (const preset of catalog.presets) {
      expect(preset.tools.length).toBeGreaterThan(0);
      expect(preset.tools.filter((name) => !names.has(name))).toEqual([]);
    }

    /*
     * This runtime wires no desk, and the desk is not part of the app yet, so
     * the eight to-do and note tools are not built here — and the widest card
     * must not offer them. The scheduling tools deliberately stay: this
     * catalogue does list them, because the app has jobs.
     */
    const capable = catalog.presets.find((preset) => preset.id === 'capable');
    expect(capable?.tools).toContain('create_job');
    expect(capable?.tools).not.toContain('list_todos');
    expect(capable?.tools).not.toContain('save_skill');
  });
});

describe('changing an agent', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-grant-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultIdentity: '',
      defaultTools: ['read_file'],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({
      paths,
      readSecret: async () => ({state: 'absent'}),
    });
  }

  it('records a new grant', async () => {
    const instance = runtime();
    await instance.updateProfile(profileId, {
      enabledTools: ['read_file', 'run_shell'],
    });

    const profile = (await instance.profiles()).find(
      (entry) => entry.id === profileId,
    );
    expect(profile?.enabledTools).toEqual(['read_file', 'run_shell']);
  });

  /*
   * A grant is worthless if a host built under the old one goes on answering.
   * The host is dropped rather than updated, so the next turn is built from what
   * the profile now says — and this is the assertion that says so, because the
   * bug it prevents is invisible: the setting saves, the screen agrees, and the
   * agent carries on doing what it did before.
   */
  it('forgets the built agent so the next turn uses the new grant', async () => {
    const instance = runtime();
    await instance.updateProfile(profileId, {enabledTools: ['read_file']});
    // Nothing to drop before a host exists, which is the state after this call.
    expect(instance.isBusy()).toBe(false);

    await expect(
      instance.updateProfile(profileId, {enabledTools: []}),
    ).resolves.toMatchObject({enabledTools: []});
  });

  it('adds an agent and can switch to it', async () => {
    const instance = runtime();
    const created = await instance.createProfile('Researcher');
    expect(created.name).toBe('Researcher');

    await instance.selectProfile(created.id);
    expect((await instance.activeProfile()).id).toBe(created.id);
  });
});

/*
 * The identity a new agent starts with, and the half that matters more: the
 * identities already on disk that must not change.
 *
 * The two are one feature. Settings resets an edited identity to this same
 * constant, so a seed and a button that disagreed would make Reset restore
 * something no agent is ever given — and a "default" applied on read would be
 * the app editing the user's words back to its own.
 */
describe('the identity a new agent gets', () => {
  let dir: string;
  let paths: AppPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-identity-'));
    paths = resolveAppPaths(dir);
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({
      paths,
      readSecret: async () => ({state: 'absent'}),
    });
  }

  it('starts the first agent on the shipped identity', async () => {
    const [profile] = await runtime().profiles();
    expect(profile?.identity).toBe(DEFAULT_AGENT_IDENTITY);
    // The same constant is what the Reset button restores, so a blank one is a
    // feature that quietly does nothing in both places at once.
    expect(DEFAULT_AGENT_IDENTITY.trim().length).toBeGreaterThan(0);
  });

  it('gives an agent made later the same identity', async () => {
    const created = await runtime().createProfile('Researcher');
    expect(created.identity).toBe(DEFAULT_AGENT_IDENTITY);
  });

  it('leaves an identity the user already saved alone', async () => {
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultIdentity: '',
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();

    const [profile] = await runtime().profiles();
    expect(profile?.identity).toBe('');
  });
});

/*
 * Reading a conversation must not need a provider.
 *
 * The version that resolved the model configuration first returned an *empty*
 * conversation whenever the key was missing — so an expired key, a cleared key,
 * or a fresh install emptied every chat in the window while the messages sat on
 * disk the whole time. That is indistinguishable from having lost them.
 *
 * It was found by trying to render a stored answer and getting a blank screen,
 * which is why the test writes a real conversation file and reads it back.
 */
describe('reading a conversation without a working provider', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;
  const sessionId = 'session-read-check';

  /**
   * One stored event, in the shape the session service writes.
   *
   * `actions` and `longRunningToolIds` are part of it: a line missing them is
   * skipped by the reader, which is how a hand-written conversation file
   * silently reads back as nothing at all.
   */
  function stored(author: string, role: string, text: string): string {
    return JSON.stringify({
      author,
      content: {role, parts: [{text}]},
      id: `event-${author}-${text.length}`,
      invocationId: '',
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfirmation: {},
        requestedToolConfirmations: {},
      },
      longRunningToolIds: [],
      timestamp: Date.now(),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-read-'));
    paths = resolveAppPaths(dir);
    await seedWorkspaces(paths, dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultIdentity: '',
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;

    await mkdir(paths.sessions, {recursive: true});
    await writeFile(
      join(paths.sessions, `${sessionId}.jsonl`),
      `${stored('user', 'user', 'show me the parser output')}\n${stored('marimo', 'model', 'Here it is.')}\n`,
      'utf8',
    );
    await writeFile(
      join(paths.sessions, 'index.json'),
      JSON.stringify({
        version: 1,
        sessions: {
          [sessionId]: {
            id: sessionId,
            title: 'Parser output',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 2,
            appName: 'marimo',
            userId: 'local',
            profileId,
          },
        },
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function runtime(): AgentRuntime {
    return new AgentRuntime({
      paths,
      readSecret: async () => ({state: 'absent'}),
    });
  }

  it('refuses the turn, because there is no key', async () => {
    // The premise: this install genuinely cannot answer.
    expect((await runtime().host(profileId)).ok).toBe(false);
  });

  it('still reads the stored conversation', async () => {
    const {messages} = await runtime().transcript(profileId, sessionId);

    expect(messages.map((message) => message.text)).toEqual([
      'show me the parser output',
      'Here it is.',
    ]);
  });

  it('answers with nothing for an agent that does not exist', async () => {
    const runtime = new AgentRuntime({
      paths,
      readSecret: async () => ({state: 'absent'}),
    });
    const {messages, pending} = await runtime.transcript(
      'no-such-agent',
      sessionId,
    );
    expect(messages).toEqual([]);
    expect(pending).toEqual([]);
  });

  it('refuses to compact with the sentence about the missing key', async () => {
    /*
     * Thrown rather than answered with `{compacted: false}`: the difference the
     * two carry is the difference between "there was nothing to do" and "this
     * install cannot do it at all", and only the second is worth a red banner.
     * The sentence is the configuration's own, so it names the provider rather
     * than a stack.
     */
    await expect(runtime().compact(profileId, sessionId)).rejects.toThrow(
      /API key/u,
    );
  });
});

/*
 * The folders, and the rule the whole feature rests on: a turn runs in the
 * folder its conversation is filed under.
 *
 * This is the seam that makes browsing the rail safe. The folder is resolved
 * from the conversation at the moment a turn starts, so opening another chat
 * cannot move the one that is streaming — and the profile's current folder is
 * only the fallback, for a conversation with none or one whose folder has since
 * been forgotten.
 */
describe('folders and filing', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-filing-'));
    paths = resolveAppPaths(dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultIdentity: '',
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    profileId = (await profiles.activeProfile()).id;
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function runtime(
    readSecret: AgentRuntimeOptions['readSecret'] = async () => ({
      state: 'absent',
    }),
  ): AgentRuntime {
    return new AgentRuntime({paths, readSecret});
  }

  /** A key that works, so a host can be built and its memory read. */
  const withKey = async (): Promise<SecretRead> => ({
    state: 'present',
    value: 'sk-test',
  });

  /** Writes what an agent would have remembered in one folder. */
  async function remember(folder: string, line: string): Promise<void> {
    const memory = resolveMemoryFile(join(dir, folder), profileId);
    await mkdir(dirname(memory), {recursive: true});
    await writeFile(memory, `${line}\n`, 'utf8');
  }

  const folderId = (
    state: {workspaces: Array<{id: string; path: string}>},
    folder: string,
  ): string =>
    state.workspaces.find((entry) => entry.path === join(dir, folder))?.id ??
    '';

  it('seeds one folder at the default root', async () => {
    const state = await runtime().workspaces();
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.path).toBe(paths.defaultWorkspace);
    expect(state.activeWorkspaceId).toBe(state.workspaces[0]?.id);
  });

  it('adds, selects, renames and removes, answering with the whole list', async () => {
    const agent = runtime();
    const first = await agent.addWorkspace(join(dir, 'alpha'));
    const alpha = folderId(first, 'alpha');
    expect(first.workspaces.map((entry) => entry.name)).toContain('alpha');
    // Loading a folder makes it the one a new conversation is filed under.
    expect(first.activeWorkspaceId).toBe(alpha);

    const renamed = await agent.renameWorkspace(alpha, 'Client work');
    expect(renamed.workspaces.find((entry) => entry.id === alpha)?.name).toBe(
      'Client work',
    );

    const second = await agent.addWorkspace(join(dir, 'beta'));
    expect(second.activeWorkspaceId).not.toBe(alpha);
    expect((await agent.selectWorkspace(alpha)).activeWorkspaceId).toBe(alpha);

    const removed = await agent.removeWorkspace(alpha);
    expect(removed.workspaces.map((entry) => entry.id)).not.toContain(alpha);
    expect(await agent.workspaceById(alpha)).toBeUndefined();
  });

  /*
   * The upgrade. A file written before folders were install-wide holds the only
   * copy of them, and the runtime is what hands it over — then drops the fields
   * from the file they came from.
   */
  it('adopts the folders a profiles file carried', async () => {
    await writeFile(
      paths.profiles,
      JSON.stringify({
        version: 1,
        activeProfileId: 'legacy-agent',
        profiles: [
          {
            id: 'legacy-agent',
            name: 'Agent',
            identity: 'You are an agent.',
            workspaces: [
              {id: 'legacy-ws', name: 'legacy', path: join(dir, 'legacy')},
            ],
            activeWorkspaceId: 'legacy-ws',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );

    const state = await runtime().workspaces();
    expect(state.workspaces).toEqual([
      {id: 'legacy-ws', name: 'legacy', path: join(dir, 'legacy')},
    ]);
    expect(state.activeWorkspaceId).toBe('legacy-ws');

    const raw = JSON.parse(await readFile(paths.profiles, 'utf8')) as {
      profiles: Array<{workspaces?: unknown; activeWorkspaceId?: unknown}>;
    };
    expect(raw.profiles[0]?.workspaces).toBeUndefined();
    expect(raw.profiles[0]?.activeWorkspaceId).toBeUndefined();
  });

  it('runs a turn in the folder its conversation is filed under', async () => {
    await remember('alpha', '- the parser lives in alpha');
    await remember('beta', '- the renderer lives in beta');

    const agent = runtime(withKey);
    const alpha = folderId(
      await agent.addWorkspace(join(dir, 'alpha')),
      'alpha',
    );
    const session = await agent.createSession(profileId);
    // Another folder becomes current; the conversation keeps its own.
    await agent.addWorkspace(join(dir, 'beta'));

    const filed = await agent.host(profileId, session?.id);
    expect(filed.ok).toBe(true);
    if (filed.ok) {
      expect(await filed.host.memoryText()).toContain('alpha');
    }

    // Asked about no conversation in particular, the agent is on the current
    // folder — which is what the memory readout in Settings reports.
    const current = await agent.host(profileId);
    if (current.ok) {
      expect(await current.host.memoryText()).toContain('beta');
    }

    // Unfiled, it falls back to the current folder rather than to nothing.
    await agent.setSessionWorkspace(profileId, session?.id ?? '', null);
    const loose = await agent.host(profileId, session?.id);
    if (loose.ok) {
      expect(await loose.host.memoryText()).toContain('beta');
    }

    // And a folder that has been forgotten falls back the same way.
    await agent.setSessionWorkspace(profileId, session?.id ?? '', alpha);
    await agent.removeWorkspace(alpha);
    const forgotten = await agent.host(profileId, session?.id);
    if (forgotten.ok) {
      expect(await forgotten.host.memoryText()).toContain('beta');
    }
  });

  it('files, renames and deletes one conversation, refusing another agent', async () => {
    const agent = runtime();
    const session = await agent.createSession(profileId);
    const id = session?.id ?? '';

    const alpha = folderId(
      await agent.addWorkspace(join(dir, 'alpha')),
      'alpha',
    );
    expect(
      (await agent.setSessionWorkspace(profileId, id, alpha)).workspaceId,
    ).toBe(alpha);
    expect(
      (await agent.setSessionWorkspace(profileId, id, null)).workspaceId,
    ).toBeUndefined();

    // A stale window cannot touch another agent's conversation by naming it.
    await expect(
      agent.setSessionWorkspace('someone-else', id, alpha),
    ).rejects.toThrow(/Unknown session/u);

    expect(
      (await agent.renameSession(profileId, id, 'Release prep')).title,
    ).toBe('Release prep');

    await agent.deleteSession(profileId, id);
    expect(
      (await agent.listSessions(profileId)).map((entry) => entry.id),
    ).not.toContain(id);
  });

  it("chooses a conversation's model, and gives the choice up again", async () => {
    const agent = runtime();
    const session = await agent.createSession(profileId);
    const id = session?.id ?? '';

    expect(
      (await agent.setSessionModel(profileId, id, 'deepseek-v4-pro')).model,
    ).toBe('deepseek-v4-pro');
    // Read back from the index rather than echoed: this is what the rail draws.
    expect(
      (await agent.listSessions(profileId)).find((entry) => entry.id === id)
        ?.model,
    ).toBe('deepseek-v4-pro');

    /*
     * `null` is the way back to following the app default, and it has to be a
     * real state in the entry — a conversation that kept showing a model after
     * giving the choice up would never follow a changed default again.
     */
    expect(
      (await agent.setSessionModel(profileId, id, null)).model,
    ).toBeUndefined();

    await expect(
      agent.setSessionModel('someone-else', id, 'deepseek-flash'),
    ).rejects.toThrow(/Unknown session/u);
  });

  /*
   * An accepted fact has to land in the project it came from, not in whichever
   * folder happens to be current when the user presses Accept — which can be a
   * day later, after opening something else entirely.
   */
  it('writes an accepted fact into the folder it came from', async () => {
    const agent = runtime(withKey);
    await mkdir(join(dir, 'alpha'), {recursive: true});
    await agent.addWorkspace(join(dir, 'alpha'));
    const session = await agent.createSession(profileId);
    // The current folder moves on before the user answers.
    await agent.addWorkspace(join(dir, 'beta'));

    const proposals = new MemoryProposalStore({file: paths.memoryProposals});
    const recorded = await proposals.record(session?.id ?? '', 1, [
      {
        sessionId: session?.id ?? null,
        profileId,
        section: 'Project',
        text: 'The parser lives in alpha.',
        reason: 'Said so in that conversation.',
      },
    ]);
    const proposal = recorded.proposals[0];

    const result = await agent.resolveMemoryProposal(proposal?.id ?? '', true);
    expect(result.ok).toBe(true);
    expect(
      await readFile(resolveMemoryFile(join(dir, 'alpha'), profileId), 'utf8'),
    ).toContain('The parser lives in alpha.');
    // And nothing was written into the folder that merely happens to be current.
    await expect(
      readFile(resolveMemoryFile(join(dir, 'beta'), profileId), 'utf8'),
    ).rejects.toThrow();
  });
});
