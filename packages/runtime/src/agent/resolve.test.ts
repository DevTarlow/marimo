/**
 * Turning settings and a profile into an agent configuration.
 *
 * Every branch here is a sentence the user will read instead of a turn, so the
 * refusals are the cases worth testing: a profile with no folder, a provider that
 * needs a key and has none, a key that exists and this process cannot read, and a
 * provider this build has never heard of. The other half of the file is the other
 * thing this layer decides — which of the three places a model choice can live
 * wins — because the app carries no model of its own and the choice is now the
 * user's.
 */
import {describe, expect, it} from 'vitest';

import {DEFAULT_PROVIDER_ID, PROVIDERS} from '@marimo/protocol';
import type {
  AgentModel,
  AgentProfile,
  ProviderId,
  Settings,
} from '@marimo/protocol';

import type {SecretRead} from '../secrets.js';
import {defaultStoredSettings} from '../settings.js';
import {modelChoiceFor, parseProfile, resolveAgentConfig} from './resolve.js';
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

/**
 * A key, for whichever provider asks for one.
 *
 * What an injected engine used to be, now that the app ships no model of its own:
 * a working turn needs a provider, and a provider needs a credential. The two
 * answers a real install can give — none at all, and one this process cannot
 * decrypt — are named where they are used rather than here.
 */
const keyPresent = async (): Promise<SecretRead> => ({
  state: 'present',
  value: 'test-key',
});
const noKey = async (): Promise<SecretRead> => ({state: 'absent'});

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

type ResolveOptions = Omit<
  ResolveAgentOptions,
  'readSecret' | 'workspaceRoot'
> & {
  readSecret?: ResolveAgentOptions['readSecret'];
  workspaceRoot?: string;
};

/** `resolveAgentConfig` with a folder and a key, unless a case says otherwise. */
function resolve(options: ResolveOptions): Promise<ResolvedAgent> {
  return resolveAgentConfig({
    workspaceRoot: WORKSPACE,
    readSecret: keyPresent,
    ...options,
  });
}

/** The default document, pointed at one provider. */
function settingsWithActive(active: ProviderId): Settings {
  const settings = defaultStoredSettings();
  return {...settings, providers: {...settings.providers, active}};
}

/**
 * A profile written by a build that knows a service this one does not.
 *
 * The cast is the point rather than a shortcut: every record in the document is
 * keyed by this build's own enum, so such a value can only arrive from a *newer*
 * file — the one a downgrade produces — and a resolver that dereferenced it
 * would fail on `undefined.label` rather than answer about the settings.
 */
function profileFromANewerBuild(provider: string): AgentProfile {
  return profile({
    model: {
      provider,
      model: 'a-model-this-build-has-never-heard-of',
    } as AgentModel,
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

  /*
   * The three facts that say where a request goes now live in the settings
   * document rather than in a supervised engine's live port: which service, its
   * address and the model id. All three have to survive the join, or a provider
   * the user configured would be answered by the catalogue's default instead.
   */
  it('carries the provider, the address and the model the settings document holds', async () => {
    const base = defaultStoredSettings();
    const result = await resolve({
      settings: {
        ...base,
        providers: {
          active: 'opencode_go',
          configs: {
            ...base.providers.configs,
            opencode_go: {
              baseUrl: 'https://go.example.test/v1',
              model: 'glm-5.3-flash',
              keyStorage: 'keychain',
            },
          },
        },
      },
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config).toMatchObject({
      provider: 'opencode_go',
      baseUrl: 'https://go.example.test/v1',
      model: 'glm-5.3-flash',
      profileId: 'profile-1',
      workspaceRoot: '/home/someone/dev',
      systemPrompt: 'You are Marimo.',
    });
    // The credential the store produced, carried whole: a turn without one is the
    // refusal below rather than an empty request.
    expect(result.config.apiKey).toBe('test-key');
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
   * The refusal a fresh install meets, and the sentence has to name the service
   * rather than the missing thing: "DeepSeek needs an API key" tells somebody
   * which screen to open, and "no API key" leaves them to work out that the
   * provider they picked is the one asking.
   */
  it('refuses a provider that needs a key and has none, naming the provider', async () => {
    const result = await resolve({
      settings: settingsWithActive('gemini'),
      profile: profile(),
      readSecret: noKey,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('Google Gemini');
      expect(result.problem).toMatch(/API key/u);
      expect(result.problem).toContain('Settings');
    }
  });

  /*
   * The distinction that keeps a working install from looking broken.
   *
   * A key that is stored and cannot be decrypted — a locked keychain, a headless
   * runner with no cipher at all — is not a key that was never entered. Reported
   * as missing, it sends the user to re-type something that is already there; the
   * store's own reason is the only sentence that says what to actually do.
   */
  it('reports a key it cannot read with its own reason rather than as missing', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profile(),
      readSecret: async () => ({
        state: 'unreadable',
        reason:
          'The key for DeepSeek is encrypted and this machine has no keychain to open it.',
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('no keychain');
      expect(result.problem).not.toMatch(/Add one in Settings/u);
    }
  });

  /*
   * The provider that keeps the promise the bundled model made: a llama-server on
   * your own machine usually takes no key at all, so a read that finds nothing
   * must not be the thing that stops the turn. The empty string is what the
   * transport sends.
   */
  it('resolves a provider that needs no key with an empty one', async () => {
    const result = await resolve({
      settings: settingsWithActive('llamacpp'),
      profile: profile(),
      readSecret: noKey,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.provider).toBe('llamacpp');
      expect(result.config.apiKey).toBe('');
      expect(result.config.baseUrl).toBe(PROVIDERS.llamacpp.defaultBaseUrl);
      expect(result.config.model).toBe(PROVIDERS.llamacpp.fallbackModels[0]);
    }
  });

  /*
   * The resolution order, reaching the configuration the agent is actually built
   * with: a conversation's own model outranks its agent's, which outranks the
   * app's default. `modelChoiceFor` is tested on its own below; this is the half
   * that says the order is the one the turn runs under, and that a conversation's
   * chosen id travels with its provider rather than being replaced by the
   * provider's stored default.
   */
  it('resolves the turn on the most specific model choice there is', async () => {
    const settings = defaultStoredSettings();
    const agent = profile({
      model: {provider: 'gemini', model: 'gemini-3.1-pro'},
    });

    const inherited = await resolve({settings, profile: agent});
    expect(inherited.ok && inherited.config.provider).toBe('gemini');
    expect(inherited.ok && inherited.config.baseUrl).toBe(
      PROVIDERS.gemini.defaultBaseUrl,
    );

    const chosen = await resolve({
      settings,
      profile: agent,
      sessionModel: {provider: 'openrouter', model: 'some-vendor/some-model'},
    });
    expect(chosen.ok && chosen.config.provider).toBe('openrouter');
    expect(chosen.ok && chosen.config.model).toBe('some-vendor/some-model');
  });

  it('refuses a provider this build does not know, by name', async () => {
    const result = await resolve({
      settings: defaultStoredSettings(),
      profile: profileFromANewerBuild('a-service-from-a-newer-build'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain('a-service-from-a-newer-build');
      expect(result.problem).toMatch(/does not know/u);
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
    // Zero would be a different instruction from "no cap", and a provider that
    // read it as one would answer an empty turn rather than a long one.
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

/*
 * Which model answers, in the order the evidence is good.
 *
 * One function answers it because a second implementation of the order would be
 * a second answer to "which model is this", and the one a user reads would be the
 * wrong one. A model is a pair throughout, because an id means nothing apart from
 * the endpoint that serves it.
 */
describe('modelChoiceFor', () => {
  const app = defaultStoredSettings();
  const agentModel: AgentModel = {provider: 'gemini', model: 'gemini-3.1-pro'};
  const sessionModel: AgentModel = {
    provider: 'openrouter',
    model: 'some-vendor/some-model',
  };

  it("answers with the app's provider when neither the agent nor the conversation chose", () => {
    expect(modelChoiceFor(app, profile())).toEqual({
      provider: DEFAULT_PROVIDER_ID,
      config: app.providers.configs[DEFAULT_PROVIDER_ID],
    });
  });

  it("lets an agent's own model outrank the app's, id and all", () => {
    /*
     * A choice wins *whole*: the agent's provider supplies the address and the
     * credential, and the agent's own model id is what the request asks for. The
     * failure this guards is quiet rather than loud — taking the provider from the
     * agent and the id from the settings file means a picker that says
     * `gemini-3.1-pro` over a turn answered by whatever Gemini was last set to,
     * with nothing on screen disagreeing.
     */
    expect(modelChoiceFor(app, profile({model: agentModel}))).toEqual({
      provider: 'gemini',
      config: {...app.providers.configs.gemini, model: agentModel.model},
    });
  });

  it("lets a conversation's model outrank its agent's, carrying its own id", () => {
    // This is the level that carries a model id of its own: the picker above a
    // composer chooses a pair, and the id is the choice rather than whatever the
    // provider was last set to.
    expect(
      modelChoiceFor(app, profile({model: agentModel}), sessionModel),
    ).toEqual({
      provider: 'openrouter',
      config: {...app.providers.configs.openrouter, model: sessionModel.model},
    });
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
