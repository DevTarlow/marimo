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
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {resolveAppPaths} from '../paths.js';
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
      expect(await agent.pendingGates(profileId, session?.id ?? '')).toEqual([]);
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
