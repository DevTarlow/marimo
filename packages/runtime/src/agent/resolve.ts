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
  /** Overrides the profile's active workspace, for a caller that knows better. */
  workspaceRoot?: string;
}

export async function resolveAgentConfig(
  options: ResolveAgentOptions,
): Promise<ResolvedAgent> {
  const {settings, profile} = options;

  const workspaceRoot = options.workspaceRoot ?? activeWorkspaceRoot(profile);
  if (workspaceRoot === undefined) {
    return {
      ok: false,
      problem:
        `"${profile.name}" has no folder yet. Add one in Settings so its file ` +
        'tools have somewhere to work.',
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

  return {
    ok: true,
    profile,
    config: {
      apiKey,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      provider: providerId,
      temperature: settings.temperature,
      ...(settings.maxOutputTokens !== undefined
        ? {maxOutputTokens: settings.maxOutputTokens}
        : {}),
      systemPrompt: profile.identity,
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

/**
 * The folder a profile works in, or undefined when it has none.
 *
 * A profile with no workspace is legitimate — it is what a fresh install has
 * before anybody picks a folder — so this answers rather than throws, and the
 * caller turns it into that sentence above.
 */
export function activeWorkspaceRoot(profile: AgentProfile): string | undefined {
  if (profile.activeWorkspaceId === null) {
    return undefined;
  }
  return profile.workspaces.find(
    (workspace) => workspace.id === profile.activeWorkspaceId,
  )?.path;
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
