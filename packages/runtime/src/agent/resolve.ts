/**
 * Turning what the user configured into what the agent runs on.
 *
 * This is the join between three things that never see each other: the settings
 * (how warm the model runs), the profile (who this agent is, where it works, what
 * it may use), and the engine's address — which belongs to the process that
 * started it rather than to any file. The agent wants one `AgentConfig`; this is
 * where that comes from.
 *
 * It is a pure function of its inputs, deliberately. Every failure it can have —
 * a profile with no folder, an engine that is not up — has to be reportable
 * *before* a turn starts, because a turn that begins and then dies at the engine
 * gives the user a spinner and a stack trace instead of a sentence. So it
 * answers with a reason rather than throwing, and the caller decides how to say
 * it.
 */
import type {AgentConfig, Skill} from '@marimo/agent';

import {agentProfileSchema, LOCAL_MODEL_ID} from '@marimo/protocol';
import type {AgentProfile, Settings} from '@marimo/protocol';

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
 * window as an error line, and "not configured" is a worse sentence than one
 * naming the card that fixes it.
 */
export type ResolvedAgent =
  | {ok: true; config: AgentConfig; profile: AgentProfile}
  | {ok: false; problem: string};

export interface ResolveAgentOptions {
  settings: Settings;
  profile: AgentProfile;
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
   * The one address in this app that is not stored anywhere: the port is whatever
   * was free when the engine started. So the live one arrives from the caller —
   * the process that started it — and its absence is a refusal rather than a
   * fallback. There is no placeholder to fall back *to*, which is the point: a
   * fixed port would send a conversation to whatever else is listening there.
   */
  engineBaseUrl?: string;
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

  /*
   * The engine, with no address behind it.
   *
   * Refused here rather than at the first request: the caller starts the engine
   * before it calls this, so getting here without an address means it did not
   * start — and the sentence says where to look rather than describing the state
   * it is in.
   */
  if (options.engineBaseUrl === undefined) {
    return {
      ok: false,
      problem:
        'The built-in model is not running. Open Settings → Model and press ' +
        'Start.',
    };
  }

  return {
    ok: true,
    profile,
    config: {
      // The live address, which exists only in the process that started it.
      baseUrl: options.engineBaseUrl,
      // The one model this app answers with, as the engine's `--alias` and the
      // request's `model` — the same constant on both sides of the wire.
      model: LOCAL_MODEL_ID,
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
