/**
 * Runtime configuration for the agent. The API key is supplied by the Electron
 * main process after decrypting it; it is never part of the settings object the
 * renderer can read.
 *
 * Everything else here comes from the active agent profile: its identity (the
 * system prompt), the preferences the user wrote for themselves, the folder it
 * works in, and the tools and skills it is allowed to use.
 */
import type {ProviderId} from '@marimo/protocol';

import type {Skill} from './skills/types.js';

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Which backend `baseUrl` points at.
   *
   * All three speak the same wire protocol, so this changes nothing about how a
   * request is shaped — except for the two details the provider catalogue records
   * (a `reasoning_content` channel, and whether `stream_options` may be sent).
   * Absent means DeepSeek, which is what a caller with no settings file wants.
   */
  provider?: ProviderId;
  temperature: number;
  maxOutputTokens?: number;
  /** The profile's identity: who this agent is. */
  systemPrompt: string;
  /**
   * Standing instructions the user wrote about how they want to be talked to.
   *
   * Here rather than in `systemPrompt` because the two have different owners: the
   * identity is the app's text and Settings can restore it, so the user's own
   * words must not live inside it. Read per request like `enabledSkills` below,
   * and for the same reason — it is prompt text, so editing it does not abort a
   * turn that is already running. Absent or blank means they wrote none.
   */
  preferences?: string;
  /**
   * Prompt text for this turn only, appended to the instruction.
   *
   * The one caller is the desktop companion: it shares the conversation with the
   * window, so "answer briefly" cannot be a property of the conversation and has
   * to travel with the turn that asked for it. `AgentHost.run` sets it from the
   * turn's own argument, so it is never carried over: a turn that asks for
   * nothing clears whatever the last one left behind.
   *
   * Read per request like `enabledSkills` below, and for the same reason: it is
   * prompt text, so changing it between turns is not a reason to abort the one
   * in flight.
   */
  instruction?: string;
  /**
   * Agent profile this configuration belongs to. It decides which `memory.md`
   * is read and written, so switching profile switches remembered facts as well
   * as identity. Absent means the default profile.
   */
  profileId?: string;
  /** File tools are confined here; also the default working directory. */
  workspaceRoot: string;
  /**
   * How large `memory.md` may get before the agent is told to prune.
   *
   * Absent means the built-in default. A preference rather than a fact about the
   * agent, so it travels with the configuration and is applied to the memory
   * store when the config changes — which is what makes moving it in Settings
   * affect the next tool call rather than the next launch.
   */
  memorySoftLimitBytes?: number;
  allowPrivateNetworkFetch: boolean;
  /**
   * Tool names this profile may use. Absent means "no restriction", which is
   * what a caller with no profile concept (a test, a future CLI) wants;
   * an empty array means the agent gets no tools at all.
   */
  enabledTools?: string[];
  /**
   * Names of the *user's* skills to carry in the instruction.
   *
   * Not the built-in ones: the operating protocol is unconditional and a
   * capability skill follows `enabledTools`, so this list names only what came
   * out of `/learn`. Absent means all of the user's, an empty array none of them
   * — which is what every profile written before skills could be saved carries,
   * and correctly means "no skills of mine" rather than "no prompt at all".
   */
  enabledSkills?: string[];
  /**
   * The user's skills themselves, for the agent to select from by name.
   *
   * Part of the configuration rather than a host option because it is prompt
   * content, exactly like `systemPrompt` beside it: the runner is rebuilt when
   * this changes, and the next request already carries the new skill.
   */
  userSkills?: readonly Skill[];
}
