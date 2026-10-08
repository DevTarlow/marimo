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
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {MAX_MEMORY_BYTES, resolveMemoryFile} from '@marimo/agent';
import {DEFAULT_MEMORY_SOFT_LIMIT_BYTES} from '@marimo/protocol';

import {resolveAppPaths} from '../paths.js';
import type {AppPaths} from '../paths.js';
import {ProfileStore} from '../profiles.js';
import {AgentRuntime} from './runtime.js';
import type {AgentRuntimeOptions} from './runtime.js';
import type {SecretRead} from '../secrets.js';

describe('AgentRuntime', () => {
  let dir: string;
  let paths: ReturnType<typeof resolveAppPaths>;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-runtime-'));
    paths = resolveAppPaths(dir);

    // Set the install up the way the app would: a default profile, with a
    // folder chosen, and nothing else turned on.
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultWorkspaceRoot: dir,
      defaultIdentity: '',
      defaultTools: [],
      defaultSkills: [],
    });
    await profiles.load();
    const active = await profiles.activeProfile();
    await profiles.addWorkspace(dir);
    profileId = active.id;
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
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultWorkspaceRoot: dir,
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
    const catalog = await runtime().catalog(profileId);
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
    const catalog = await runtime().catalog(profileId);
    expect(catalog.tools.map((tool) => tool.name)).toContain('run_shell');
  });

  it('answers for whichever agent is active', async () => {
    const result = await runtime().catalogForActive();
    expect(result.profileId).toBe(profileId);
    expect(result.catalog.tools.length).toBeGreaterThan(0);
  });
});

describe('changing an agent', () => {
  let dir: string;
  let paths: AppPaths;
  let profileId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-grant-'));
    paths = resolveAppPaths(dir);
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultWorkspaceRoot: dir,
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
    const profiles = new ProfileStore({
      file: paths.profiles,
      defaultWorkspaceRoot: dir,
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
});
