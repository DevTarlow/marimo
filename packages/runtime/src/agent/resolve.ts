/**
 * Turning what the user configured into what the agent runs on.
 *
 * This is the join between three documents that were written at different times
 * and never see each other: the settings (which provider, which model, how
 * warm), the profile (who this agent is, where it works, what it may use), and
 * the secret store (the key). The agent wants one `AgentConfig`; this is where
 * that comes from.
 *
 * It is a pure function of its inputs, deliberately. Every failure it can have —
 * a profile with no folder, a key that is missing, a key that exists but cannot
 * be decrypted — has to be reportable *before* a turn starts, because a turn
 * that begins and then dies at the provider gives the user a spinner and a
 * stack trace instead of a sentence. So it answers with a reason rather than
 * throwing, and the caller decides how to say it.
 */
import type {AgentConfig, Skill} from '@marimo/agent';

import {PROVIDERS, agentProfileSchema} from '@marimo/protocol';
import type {AgentProfile, ProviderId, Settings} from '@marimo/protocol';

import type {SecretRead} from '../secrets.js';

/** The skill shape the agent's instruction builder takes. */
export interface StoredSkillForPrompt {
  name: string;
  description: string;
  instructions: string;
}

/**
 * What a turn needs, or why it cannot start.
 *
 * `problem` is phrased for the person who will read it: these reach the chat
 * window as an error line, and "no API key" is a worse sentence than "DeepSeek
 * needs an API key — add one in Settings".
 */
export type ResolvedAgent =
  | {ok: true; config: AgentConfig; profile: AgentProfile}
  | {ok: false; problem: string};

export interface ResolveAgentOptions {
  settings: Settings;
  profile: AgentProfile;
  /** Reads the key for a provider. Never returns the value for logging. */
  readSecret: (providerId: ProviderId) => Promise<SecretRead>;
  /** The skills this profile carries, already filtered to the ones it enabled. */
  skills?: readonly StoredSkillForPrompt[];
  /**
   * The folder this turn runs in.
   *
   * Supplied by the caller rather than read off the profile, because the answer
   * is a fact about the *conversation*: a chat is filed under a folder in the
   * install's workspace document, and the caller is the only one that knows
   * which conversation this turn belongs to. Absent means there is no folder to
   * work in at all, which is a refusal rather than a default.
   */
  workspaceRoot?: string;
  /**
   * Where the app's own engine is listening, when it is running.
   *
   * The one address in the settings file that is not an answer: a managed
   * provider's `baseUrl` is a placeholder, because the port is whatever was free
   * when the engine started. So the live one arrives from the caller — the
   * process that started it — and its absence is a refusal rather than a
   * fallback to the placeholder. Falling back would mean a turn that sends a
   * conversation to whatever happens to be on port 8137.
   */
  managedBaseUrl?: string;
}

export async function resolveAgentConfig(
  options: ResolveAgentOptions,
): Promise<ResolvedAgent> {
  const {settings, profile} = options;

  const workspaceRoot = options.workspaceRoot;
  if (workspaceRoot === undefined) {
    return {
      ok: false,
      problem:
        `"${profile.name}" has no folder to work in. Use “Load folder…” in the ` +
        'sidebar so its file tools have somewhere to work.',
    };
  }

  const providerId = settings.providers.active;
  const provider = PROVIDERS[providerId];
  const providerConfig = settings.providers.configs[providerId];

  const secret = await options.readSecret(providerId);
  const apiKey = secret.state === 'present' ? secret.value : '';

  /*
   * A provider that needs a key and does not have one is refused here rather
   * than at the first request. The two cases are kept apart because the fix
   * differs: one is "add a key", the other is "the key is there and this
   * machine cannot read it", and telling a user to re-enter a key they already
   * entered is how a working install looks broken.
   */
  if (provider.requiresApiKey && apiKey.length === 0) {
    return {
      ok: false,
      problem:
        secret.state === 'unreadable'
          ? secret.reason
          : `${provider.label} needs an API key. Add one in Settings.`,
    };
  }

  /*
   * A provider this app runs itself, with no engine behind it.
   *
   * Refused here rather than at the first request, like the missing key above:
   * the caller starts the engine before it calls this, so getting here without
   * one means it did not start — and the sentence says where to look rather than
   * describing the state it is in.
   */
  if (provider.managed && options.managedBaseUrl === undefined) {
    return {
      ok: false,
      problem:
        `The ${provider.label.toLowerCase()} is not running. Open Settings → ` +
        'Model and press Start, or choose another service.',
    };
  }

  return {
    ok: true,
    profile,
    config: {
      apiKey,
      /*
       * The live address, but only for the provider this app runs itself.
       *
       * Guarded by `managed` as well as by presence: a caller that handed this a
       * managed address while the user had switched to DeepSeek would otherwise
       * have their conversation sent to a port on this machine. The one wrong
       * base URL here is not a broken turn, it is a turn that reaches somewhere
       * the user did not choose.
       */
      baseUrl:
        provider.managed && options.managedBaseUrl !== undefined
          ? options.managedBaseUrl
          : providerConfig.baseUrl,
      model: providerConfig.model,
      provider: providerId,
      temperature: settings.temperature,
      ...(settings.maxOutputTokens !== undefined
        ? {maxOutputTokens: settings.maxOutputTokens}
        : {}),
      systemPrompt: profile.identity,
      /*
       * Carried beside the identity rather than folded into it: the two have
       * different owners, and the agent's prompt is composed so the user's words
       * outrank the app's on manner without outranking the app's method rules.
       */
      ...(profile.preferences !== undefined
        ? {preferences: profile.preferences}
        : {}),
      profileId: profile.id,
      workspaceRoot,
      memorySoftLimitBytes: settings.memorySoftLimitBytes,
      allowPrivateNetworkFetch: settings.allowPrivateNetworkFetch,
      enabledTools: [...profile.enabledTools],
      enabledSkills: [...profile.enabledSkills],
      ...(options.skills !== undefined && options.skills.length > 0
        ? {userSkills: options.skills.map(toAgentSkill)}
        : {}),
    },
  };
}

function toAgentSkill(skill: StoredSkillForPrompt): Skill {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
  };
}

/**
 * Reads a profile defensively.
 *
 * The store already validates on the way in, so this is for the file that was
 * hand-edited between two runs — the moment when a corrupt document would
 * otherwise reach the agent as an object with missing fields.
 */
export function parseProfile(raw: unknown): AgentProfile | undefined {
  const parsed = agentProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
