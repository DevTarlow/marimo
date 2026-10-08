/**
 * Turning settings and a profile into an agent configuration.
 *
 * Every branch here is a sentence the user will read instead of a turn. The
 * cases worth testing are the refusals, and the distinction between the two
 * ways a key can be missing — "you have not added one" and "the one you added
 * cannot be read" — because telling somebody to enter a key they have already
 * entered is how a working install comes to look broken.
 */
import {describe, expect, it} from 'vitest';

import type {AgentProfile} from '@marimo/protocol';

import type {SecretRead} from '../secrets.js';
import {defaultStoredSettings} from '../settings.js';
import {
  activeWorkspaceRoot,
  parseProfile,
  resolveAgentConfig,
} from './resolve.js';

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile-1',
    name: 'Marimo',
    identity: 'You are Marimo.',
    workspaces: [{id: 'ws-1', name: 'dev', path: '/home/someone/dev'}],
    activeWorkspaceId: 'ws-1',
    enabledTools: ['read_file', 'current_time'],
    enabledSkills: [],
    ...overrides,
  };
}

/** Settings with one provider live, and its key supplied however the test wants. */
function settingsWith(
  providerId: 'deepseek' | 'llamacpp' | 'gemini' | 'openrouter' = 'deepseek',
) {
  const settings = defaultStoredSettings();
  return {
    ...settings,
    providers: {
      active: providerId,
      configs: {
        ...settings.providers.configs,
        [providerId]: {baseUrl: 'https://example.test', model: 'test-model'},
      },
    },
  };
}

const present = (value: string): SecretRead => ({state: 'present', value});
const absent: SecretRead = {state: 'absent'};
const unreadable: SecretRead = {
  state: 'unreadable',
  reason: 'The API key is encrypted and this process cannot decrypt it.',
};

describe('resolveAgentConfig', () => {
  /*
   * The memory soft limit is a settings value, not a constant: it has to reach
   * the configuration, or moving the control in Settings would change a number
   * the agent never sees — a setting that does nothing.
   */
  it('carries the memory soft limit from settings into the configuration', async () => {
    const result = await resolveAgentConfig({
      settings: {...settingsWith(), memorySoftLimitBytes: 16 * 1024},
      profile: profile(),
      readSecret: async () => present('sk-test'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.memorySoftLimitBytes).toBe(16 * 1024);
  });

  it('builds a configuration from the settings and the profile', async () => {
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile(),
      readSecret: async () => present('sk-test'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config).toMatchObject({
      apiKey: 'sk-test',
      baseUrl: 'https://example.test',
      model: 'test-model',
      provider: 'deepseek',
      profileId: 'profile-1',
      workspaceRoot: '/home/someone/dev',
      systemPrompt: 'You are Marimo.',
    });
    // The profile's capability list is carried through untouched: it is the
    // agent's whole surface, and a filter here would be a second place for the
    // user's choices to be overridden.
    expect(result.config.enabledTools).toEqual(['read_file', 'current_time']);
  });

  it('refuses a profile with no folder, and says which one', async () => {
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile({workspaces: [], activeWorkspaceId: null}),
      readSecret: async () => present('sk-test'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('Marimo');
      expect(result.problem).toMatch(/folder/iu);
    }
  });

  it('refuses when the provider needs a key and there is none', async () => {
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile(),
      readSecret: async () => absent,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('DeepSeek');
      expect(result.problem).toMatch(/API key/u);
    }
  });

  /*
   * The distinction that matters. A key exists and this process cannot read it —
   * which is exactly the headless runner's situation on a machine whose keyring
   * is locked. Saying "add an API key" there sends the user to re-enter a key
   * that is already saved, and the real problem goes unfixed.
   */
  it('reports an unreadable key as its own problem, not as a missing one', async () => {
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile(),
      readSecret: async () => unreadable,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe(unreadable.reason);
      expect(result.problem).not.toMatch(/add one in Settings/iu);
    }
  });

  it('does not ask a local server for a key', async () => {
    const result = await resolveAgentConfig({
      settings: settingsWith('llamacpp'),
      profile: profile(),
      readSecret: async () => absent,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.apiKey).toBe('');
      expect(result.config.provider).toBe('llamacpp');
    }
  });

  it('carries the sampling settings through', async () => {
    const settings = settingsWith();
    const result = await resolveAgentConfig({
      settings: {...settings, temperature: 1.25, maxOutputTokens: 4096},
      profile: profile(),
      readSecret: async () => present('sk-test'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.temperature).toBe(1.25);
      expect(result.config.maxOutputTokens).toBe(4096);
    }
  });

  it('omits the output cap rather than sending zero', async () => {
    // Zero would be a different instruction from "no cap", and some endpoints
    // refuse it outright.
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile(),
      readSecret: async () => present('sk-test'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).not.toHaveProperty('maxOutputTokens');
    }
  });

  it('passes the profile skills in the shape the prompt builder wants', async () => {
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile({enabledSkills: ['house-style']}),
      readSecret: async () => present('sk-test'),
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
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile(),
      readSecret: async () => present('sk-test'),
      skills: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).not.toHaveProperty('userSkills');
    }
  });

  it('lets a caller override the folder', async () => {
    // The headless runner works a job's own folder, which is the profile's only
    // when nobody has moved it since.
    const result = await resolveAgentConfig({
      settings: settingsWith(),
      profile: profile(),
      readSecret: async () => present('sk-test'),
      workspaceRoot: '/tmp/elsewhere',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.workspaceRoot).toBe('/tmp/elsewhere');
    }
  });
});

describe('activeWorkspaceRoot', () => {
  it('finds the folder the profile is working in', () => {
    expect(activeWorkspaceRoot(profile())).toBe('/home/someone/dev');
  });

  it('answers nothing when no folder is selected', () => {
    expect(
      activeWorkspaceRoot(profile({activeWorkspaceId: null})),
    ).toBeUndefined();
  });

  /*
   * The workspace was removed from the list while it was still the active one.
   * A stale id is not a folder, and treating it as one would point the file
   * tools at a path the user has already taken away.
   */
  it('answers nothing when the selected folder is no longer listed', () => {
    expect(
      activeWorkspaceRoot(profile({activeWorkspaceId: 'gone'})),
    ).toBeUndefined();
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
