/**
 * Turning settings and a profile into an agent configuration.
 *
 * Every branch here is a sentence the user will read instead of a turn, so the
 * refusals are the cases worth testing: a profile with no folder, and an engine
 * that is not running. There is no third one any more — the app holds no model
 * key, so the two ways a key could be missing went with the key.
 */
import {describe, expect, it} from 'vitest';

import {LOCAL_MODEL_ID} from '@marimo/protocol';
import type {AgentProfile} from '@marimo/protocol';

import {defaultStoredSettings} from '../settings.js';
import {parseProfile, resolveAgentConfig} from './resolve.js';
import type {ResolvedAgent, ResolveAgentOptions} from './resolve.js';

/**
 * Where the turn runs, as the caller supplies it.
 *
 * Not a field on the profile any more: a conversation is filed under a folder in
 * the install's workspace document, and only the caller knows which conversation
 * is asking. Every case below names it; the one that deliberately does not is
 * the refusal.
 */
const WORKSPACE = '/home/someone/dev';

/** Where the process that started the engine says it is listening. */
const ENGINE = 'http://127.0.0.1:49231/v1';

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile-1',
    name: 'Marimo',
    identity: 'You are Marimo.',
    enabledTools: ['read_file', 'current_time'],
    enabledSkills: [],
    ...overrides,
  };
}

/** `resolveAgentConfig` with a folder and an engine, unless a case says otherwise. */
function resolve(
  options: Omit<ResolveAgentOptions, 'workspaceRoot' | 'engineBaseUrl'> & {
    workspaceRoot?: string;
    engineBaseUrl?: string;
  },
): Promise<ResolvedAgent> {
  return resolveAgentConfig({
    workspaceRoot: WORKSPACE,
    engineBaseUrl: ENGINE,
    ...options,
  });
}

describe('resolveAgentConfig', () => {
  /*
   * The memory soft limit is a settings value, not a constant: it has to reach
   * the configuration, or moving the control in Settings would change a number
   * the agent never sees — a setting that does nothing.
   */
  it('carries the memory soft limit from settings into the configuration', async () => {
    const result = await resolve({
      settings: {...defaultStoredSettings(), memorySoftLimitBytes: 16 * 1024},
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.memorySoftLimitBytes).toBe(16 * 1024);
  });

  it('builds a configuration from the engine, the settings and the profile', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config).toMatchObject({
      baseUrl: ENGINE,
      // The one model this app answers with, which is also the engine's
      // `--alias`: the same constant on both sides of the wire.
      model: LOCAL_MODEL_ID,
      profileId: 'profile-1',
      workspaceRoot: '/home/someone/dev',
      systemPrompt: 'You are Marimo.',
    });
    // No credential exists to carry, and a field for one would be a field that
    // is always empty.
    expect(result.config).not.toHaveProperty('apiKey');
    expect(result.config).not.toHaveProperty('provider');
    // The profile's capability list is carried through untouched: it is the
    // agent's whole surface, and a filter here would be a second place for the
    // user's choices to be overridden.
    expect(result.config.enabledTools).toEqual(['read_file', 'current_time']);
  });

  /*
   * Carried beside the system prompt rather than folded into it, because the two
   * have different owners. The prompt builder is the only thing that knows how to
   * order them, so this test is about the field surviving the join at all.
   */
  it("carries the user's preferences beside the identity", async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile({preferences: 'Call me Tarlow. Skip the emoji.'}),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.systemPrompt).toBe('You are Marimo.');
    expect(result.config.preferences).toBe('Call me Tarlow. Skip the emoji.');
  });

  it('leaves preferences absent when the user wrote none', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
    });

    expect(result.ok && result.config.preferences).toBeUndefined();
  });

  it('refuses a turn with no folder, and says which agent', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
      // The caller has no folder to name: no workspaces at all, or the
      // conversation's folder has been forgotten and there is nothing current.
      workspaceRoot: undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('Marimo');
      expect(result.problem).toMatch(/folder/iu);
    }
  });

  /*
   * The refusal that matters most, because the alternative is not a broken turn.
   *
   * The engine comes up on whatever port was free, so there is no stored address
   * to fall back to — and inventing one would send the conversation to whatever
   * else happens to be listening there. So a missing address is refused, and the
   * sentence names the card that fixes it.
   */
  it('refuses a turn until the app has started the engine', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
      engineBaseUrl: undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('not running');
      expect(result.problem).toContain('Settings');
    }
  });

  it('uses the live address of the engine', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
      engineBaseUrl: 'http://127.0.0.1:52117/v1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.baseUrl).toBe('http://127.0.0.1:52117/v1');
    }
  });

  it('carries the sampling settings through', async () => {
    const result = await resolve({
      settings: {
        ...defaultStoredSettings(),
        temperature: 1.25,
        maxOutputTokens: 4096,
      },
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.temperature).toBe(1.25);
      expect(result.config.maxOutputTokens).toBe(4096);
    }
  });

  it('omits the output cap rather than sending zero', async () => {
    // Zero would be a different instruction from "no cap", and the engine
    // refuses it outright.
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).not.toHaveProperty('maxOutputTokens');
    }
  });

  it('passes the profile skills in the shape the prompt builder wants', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile({enabledSkills: ['house-style']}),
      skills: [
        {
          name: 'house-style',
          description: 'How to write here.',
          instructions: 'Be brief.',
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.userSkills).toEqual([
        {
          name: 'house-style',
          description: 'How to write here.',
          instructions: 'Be brief.',
        },
      ]);
    }
  });

  it('leaves userSkills absent when there are none', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
      skills: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).not.toHaveProperty('userSkills');
    }
  });

  it('runs in whatever folder the caller named', async () => {
    // The folder is the conversation's, not the profile's: two chats on one
    // agent work in two different projects, and this is the seam that lets them.
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
      workspaceRoot: '/tmp/elsewhere',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.workspaceRoot).toBe('/tmp/elsewhere');
    }
  });
});

describe('parseProfile', () => {
  it('accepts a profile the schema understands', () => {
    expect(parseProfile(profile())).toMatchObject({id: 'profile-1'});
  });

  it('refuses a hand-edited profile rather than passing it on', () => {
    // The store validates on the way in, so this is for the file somebody edited
    // between two runs — the moment a missing field would reach the agent.
    expect(parseProfile({id: 'x'})).toBeUndefined();
    expect(parseProfile(null)).toBeUndefined();
    expect(parseProfile('not a profile')).toBeUndefined();
  });
});
