/**
 * The agent runtime behind the chat window.
 *
 * `AgentHost` is the only stateful object in this package and the only thing
 * the Electron main process touches. It owns the ADK `Runner`, translates ADK
 * events into the flat UI event stream the renderer understands, and keeps the
 * human-in-the-loop approval round trip.
 *
 * It deliberately imports nothing from Electron: moving the agent into a
 * `utilityProcess` later is then a transport change, not a rewrite.
 */
import {randomUUID} from 'node:crypto';

import {
  createEvent,
  isCompactedEvent,
  LlmAgent,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Runner,
  StreamingMode,
} from '@google/adk';
import type {Content, Part} from '@google/genai';
import type {
  AgentUiEvent,
  CompactResult,
  PendingGate,
  SessionSource,
  SessionSummary,
  TokenUsage,
  TranscriptMessage,
} from '@marimo/protocol';
import {MAIN_AGENT_NAME} from '@marimo/protocol';

import type {AgentConfig} from '../config.js';
import {MemoryStore} from '../memory/index.js';
import {MEMORY_SOFT_LIMIT_BYTES} from '../memory/size.js';
import {OpenAiCompatLlm} from '../models/openai-compat-llm.js';
import {FileSessionService} from '../sessions/file-session-service.js';
import type {
  AdkEvent,
  SessionIndexEntry,
} from '../sessions/file-session-service.js';
import {composeInstruction} from '../skills/index.js';
import {createTools} from '../tools/index.js';
import type {
  McpToolsetSource,
  SubagentDeps,
  SubagentLimits,
} from '../tools/index.js';
import type {DeskService} from '../tools/desk-tools.js';
import type {SkillService} from '../tools/skill-tools.js';
import type {DiscordService} from '../tools/discord-tools.js';
import type {JobService} from '../tools/job-tools.js';
import type {WebSearchProvider} from '../tools/web-search-tool.js';
import {
  buildCompactedEvent,
  compactionPrompt,
  planCompaction,
  renderForSummary,
} from './compaction.js';
import {projectTranscript} from './transcript.js';
import {RepeatedToolCallPlugin} from './tool-loop-plugin.js';

export interface AgentHostOptions {
  sessionsDir: string;
  config: AgentConfig;
  appName?: string;
  userId?: string;
  /** Supplied by the desktop app; without it the agent has no `web_search`. */
  webSearch?: WebSearchProvider;
  /**
   * Supplied by the desktop app; without it the agent cannot see or create
   * scheduled jobs. The host only passes it through — what a job *is* belongs to
   * whatever owns the store.
   */
  jobService?: JobService;
  /**
   * Supplied by the desktop app when a Discord bot is connected; without it the
   * agent has no way to post or read there. Like `jobService`, this is passed
   * through untouched: the connection, the token and the watched channel are the
   * app's, not the agent's.
   */
  discordService?: DiscordService;
  /**
   * Supplied by the desktop app; without it the agent cannot read or change the
   * to-do list or the notes. Like the rest, passed through untouched: those two
   * documents belong to the app, and the tools name an intention rather than a
   * file.
   */
  deskService?: DeskService;
  /**
   * Supplied by the desktop app; without it the agent cannot save a skill, and
   * `/learn` has nothing to write with.
   */
  skillService?: SkillService;
  /**
   * The MCP servers that are currently connected.
   *
   * Passed as connections rather than as configuration, because that is what
   * they are: the app owns enabling a server, dialling it and giving up on it,
   * and this host only decides what the model is offered. Change them with
   * {@link AgentHost.setMcpServers} when a server connects or drops.
   */
  mcpServers?: readonly McpToolsetSource[];
  /**
   * Where a helper agent's words go while it runs.
   *
   * Out of band rather than through the turn's generator, because a tool call
   * cannot yield into the stream that is awaiting it. The same channel the MCP
   * status events use, for the same reason.
   */
  onSubagentEvent?: (event: AgentUiEvent) => void;
  /** Ceilings on a helper: steps, time, and the size of what it hands back. */
  subagentLimits?: Partial<SubagentLimits>;
}

export interface ApproveParams {
  sessionId: string;
  callId: string;
  confirmed: boolean;
  payload?: unknown;
}

/** One gate's answer, as the user gave it. */
interface GateDecision {
  confirmed: boolean;
  payload?: unknown;
}

/*
 * `PendingGate` is the contract's, not this file's. It is what a card is drawn
 * from, so the window has to be able to name it — and a second declaration here
 * would be a second shape that could drift from the one on the wire.
 */

/**
 * The gates of one paused round, and the decisions taken so far.
 *
 * Held together because ADK reads confirmations from the newest message alone:
 * the answers cannot be sent one at a time, so they have to accumulate somewhere
 * until the round is complete.
 */
interface GateRound {
  sessionId: string;
  gates: Set<string>;
  decisions: Map<string, GateDecision>;
}

/**
 * The confirmation response ADK resumes a gated call with.
 *
 * ADK matches it to the gate by `id` and to the original call through the gate's
 * own arguments, so the name has to be the gate's rather than the tool's.
 */
function confirmationResponse(callId: string, decision: GateDecision): Part {
  return {
    functionResponse: {
      id: callId,
      name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      response: {
        confirmed: decision.confirmed,
        ...(decision.payload !== undefined ? {payload: decision.payload} : {}),
      },
    },
  };
}

export class AgentHost {
  static readonly APP_NAME = MAIN_AGENT_NAME;
  static readonly USER_ID = 'local';

  private readonly sessionService: FileSessionService;
  private readonly appName: string;
  private readonly userId: string;
  /**
   * Long-term memory, shared by the instruction provider and the memory tools so
   * the prompt and the tools can never disagree about which file is memory.
   */
  private readonly memory: MemoryStore;
  private readonly webSearch?: WebSearchProvider;
  private readonly jobService?: JobService;
  private readonly discordService?: DiscordService;
  private readonly deskService?: DeskService;
  private readonly skillService?: SkillService;
  /**
   * The MCP servers in play, replaced wholesale when one connects or drops.
   *
   * Mutable, unlike the services beside it, because a connection is not a
   * setting: a server can die and come back while the app is running, and the
   * next turn has to be offered what is actually reachable now.
   */
  private mcpServers: readonly McpToolsetSource[];
  private readonly onSubagentEvent: ((event: AgentUiEvent) => void) | undefined;
  private readonly subagentLimits: Partial<SubagentLimits> | undefined;
  private config: AgentConfig;
  /**
   * The cached runner, keyed by model.
   *
   * There is one model now, so this holds one entry — kept as a map because ADK
   * binds the model into the agent and `runnerFor` is still the one place a
   * runner is built, not because a second model is coming.
   */
  private readonly runners = new Map<string, Runner>();
  private active: {sessionId: string; controller: AbortController} | undefined;
  /**
   * The approval gates a paused turn is waiting on, and the decisions taken so
   * far.
   *
   * A round has to be answered as one message, because ADK reads the
   * confirmations from the newest user message alone: answering the first gate of
   * a two-gate round resumes the turn with the second still unanswered, and the
   * provider then refuses the request — an assistant message's tool calls must
   * each be answered. Holding the decision here is also the honest state: the
   * turn is waiting for the user, not for the model.
   *
   * A new turn abandons whatever the last one was waiting on, which is what the
   * window does when the user stops a paused turn and asks something else. The
   * mapping layer answers the calls left behind on the wire, so an abandoned
   * round costs a re-ask rather than a broken conversation.
   */
  private gateRound: GateRound | undefined;

  constructor(options: AgentHostOptions) {
    this.sessionService = new FileSessionService({
      rootDir: options.sessionsDir,
    });
    this.appName = options.appName ?? AgentHost.APP_NAME;
    this.userId = options.userId ?? AgentHost.USER_ID;
    this.config = options.config;
    // Memory follows both the folder and the agent profile: pointing the app at
    // another project, or switching to another agent, must not carry facts over.
    this.memory = new MemoryStore({
      workspaceRoot: options.config.workspaceRoot,
      ...(options.config.profileId !== undefined
        ? {profileId: options.config.profileId}
        : {}),
      ...(options.config.memorySoftLimitBytes !== undefined
        ? {softLimitBytes: options.config.memorySoftLimitBytes}
        : {}),
    });
    this.webSearch = options.webSearch;
    this.jobService = options.jobService;
    this.discordService = options.discordService;
    this.deskService = options.deskService;
    this.skillService = options.skillService;
    this.mcpServers = options.mcpServers ?? [];
    this.onSubagentEvent = options.onSubagentEvent;
    this.subagentLimits = options.subagentLimits;
  }

  /** Prepares the runner cache. There is nothing to build until a turn runs. */
  init(): void {
    this.runners.clear();
  }

  updateConfig(config: AgentConfig): void {
    const affectsRuns =
      config.model !== this.config.model ||
      config.baseUrl !== this.config.baseUrl ||
      config.temperature !== this.config.temperature ||
      config.maxOutputTokens !== this.config.maxOutputTokens ||
      config.systemPrompt !== this.config.systemPrompt ||
      config.profileId !== this.config.profileId ||
      config.workspaceRoot !== this.config.workspaceRoot ||
      !sameList(config.enabledTools, this.config.enabledTools) ||
      config.allowPrivateNetworkFetch !== this.config.allowPrivateNetworkFetch;

    /*
     * `enabledSkills` is deliberately not in the list above, and neither is
     * `instruction`.
     *
     * Tool names, the model and the folder all change what a running turn can do,
     * so a change to one of them aborts it rather than letting it finish against
     * a configuration the user has just replaced. A skill and a turn's own
     * instruction are prompt text: the instruction provider reads `this.config`
     * on every request, so text changed midway through a turn is simply in the
     * next one — and aborting the turn that saved a skill, which is what `/learn`
     * does, would be the one case where the feature could never work.
     */
    this.config = config;
    // Memory follows both the folder and the agent: a profile switch must not
    // inherit the previous agent's remembered facts.
    this.memory.setWorkspaceRoot(config.workspaceRoot);
    this.memory.setProfileId(config.profileId);
    // Read at call time by the tools, so moving the limit in Settings reaches the
    // next read and write rather than the next launch.
    this.memory.setSoftLimitBytes(
      config.memorySoftLimitBytes ?? MEMORY_SOFT_LIMIT_BYTES,
    );
    // Agents hold the model, address and tool closures, so a settings change
    // invalidates every cached runner.
    this.runners.clear();
    if (affectsRuns) {
      // A run in flight is using the previous configuration; stop it rather
      // than letting it finish against settings the user just replaced.
      this.abortActive();
    }
  }

  /**
   * Replaces the connected MCP servers.
   *
   * The cached runners are dropped because a runner holds the tool closures it
   * was built with: a server that connected after that build would be invisible
   * until something rebuilt, which is exactly the "I added it and nothing
   * happened" complaint this avoids.
   *
   * A turn in flight is deliberately *not* aborted. Tools are chosen when a turn
   * begins, and the request already in flight is carrying the old list — killing
   * it to deliver a new server's tools mid-sentence would lose the answer the
   * user is reading. The next turn has them.
   */
  setMcpServers(sources: readonly McpToolsetSource[]): void {
    this.mcpServers = sources;
    this.runners.clear();
  }

  /**
   * The conversations a profile can see.
   *
   * Sessions are per profile, so passing one is how the sidebar stays scoped.
   * `undefined` lists everything, which is what a host with no profile concept
   * wants.
   */
  async listSessions(profileId?: string): Promise<SessionSummary[]> {
    const entries = await this.sessionService.getIndex();
    const scoped =
      profileId === undefined
        ? entries
        : entries.filter((entry) => entry.profileId === profileId);
    return scoped
      .map(toSummary)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /**
   * The folder a conversation is filed under, or `undefined` when it is unfiled
   * — either because it predates folders, or because the folder it named has
   * since been forgotten.
   *
   * A read of the index and nothing more: it is what decides which folder a turn
   * runs in, and the caller resolves the id to a path, because the folders are
   * the whole install's business rather than one host's.
   */
  async sessionWorkspaceId(sessionId: string): Promise<string | undefined> {
    return (await this.sessionService.getIndexEntry(sessionId))?.workspaceId;
  }

  /**
   * Claims conversations that predate profiles, so an upgrade does not strand a
   * user's history outside every profile.
   */
  async adoptUnownedSessions(profileId: string): Promise<number> {
    return await this.sessionService.adoptUnownedSessions(profileId);
  }

  /** Deletes a profile's conversations. Its memory files are left alone. */
  async deleteSessionsForProfile(profileId: string): Promise<number> {
    if (
      this.active &&
      (await this.sessionProfile(this.active.sessionId)) === profileId
    ) {
      this.abortActive();
    }
    const deleted =
      await this.sessionService.deleteSessionsForProfile(profileId);
    return deleted.length;
  }

  async createSession(
    title?: string,
    profileId?: string,
    workspaceId?: string,
    source?: SessionSource,
  ): Promise<SessionSummary> {
    const state: Record<string, unknown> = {};
    if (title) {
      state['title'] = title;
    }
    if (profileId) {
      state['profileId'] = profileId;
    }
    if (workspaceId) {
      state['workspaceId'] = workspaceId;
    }
    if (source) {
      state['source'] = source;
    }

    const session = await this.sessionService.createSession({
      appName: this.appName,
      userId: this.userId,
      sessionId: randomUUID(),
      state: Object.keys(state).length > 0 ? state : undefined,
    });
    const entry = await this.sessionService.getIndexEntry(session.id);
    return entry
      ? toSummary(entry)
      : {
          id: session.id,
          title: title ?? 'New chat',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          ...(workspaceId ? {workspaceId} : {}),
          ...(source ? {source} : {}),
        };
  }

  /**
   * Re-files a conversation under another folder, or under none.
   *
   * This is the sidebar's filing, not the agent's confinement root: what the
   * agent may touch is the active profile's active workspace, which the window
   * shows above the composer. A conversation keeps running exactly as it did.
   */
  async setSessionWorkspace(
    sessionId: string,
    workspaceId: string | undefined,
    profileId?: string,
  ): Promise<SessionSummary> {
    await this.assertOwned(sessionId, profileId);
    const entry = await this.sessionService.setSessionWorkspace(
      sessionId,
      workspaceId,
    );
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return toSummary(entry);
  }

  /**
   * Names a conversation, replacing the title derived from its first message.
   *
   * Ownership is asserted like every other path that touches a conversation, so
   * a window cannot rename another profile's chat by guessing at an id.
   */
  async renameSession(
    sessionId: string,
    title: string,
    profileId?: string,
  ): Promise<SessionSummary> {
    await this.assertOwned(sessionId, profileId);
    const entry = await this.sessionService.renameSession(sessionId, title);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return toSummary(entry);
  }

  /**
   * Replaces the older part of a conversation with a summary the model writes.
   *
   * One event is appended and nothing else is touched — see `compaction.ts` for
   * why that is the whole mechanism, and why a rewrite was worth avoiding. The
   * conversation keeps every message; the request gets smaller; the transcript
   * shows one card where the replaced messages were.
   *
   * The refusals are returned rather than thrown. A command that cannot run is
   * not a failure of the app: a short conversation has nothing to compact, and a
   * turn that is mid-flight has a reason the user can act on. Throwing would turn
   * all of those into the same red banner as a provider that is down.
   */
  async compact(sessionId: string, profileId?: string): Promise<CompactResult> {
    await this.assertOwned(sessionId, profileId);

    /*
     * One turn at a time, and a compaction is a write to the conversation the
     * turn is reading. The gates are the sharper half of the same rule: a paused
     * turn is answered by the *next* invocation, and replacing the events it is
     * paused in would leave a card the model can no longer confirm.
     */
    if (this.active?.sessionId === sessionId) {
      return {
        compacted: false,
        reason:
          'A turn is running in this conversation. Stop it, or wait for it to ' +
          'finish, and then compact.',
      };
    }
    const waiting = await this.pendingGates(sessionId);
    if (waiting.length > 0) {
      return {
        compacted: false,
        reason:
          'This conversation is waiting for your approval. Answer it — or stop ' +
          'the turn — and then compact.',
      };
    }

    const session = await this.sessionService.getSession({
      appName: this.appName,
      userId: this.userId,
      sessionId,
    });
    if (session === undefined) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const plan = planCompaction(session.events);
    if (plan === undefined) {
      return {
        compacted: false,
        reason: 'Nothing to compact yet — this conversation is short enough to fit.',
      };
    }

    /*
     * The one call this needs, and it is deliberately not a turn: `ask` has no
     * tools, so the provider's "a tool-carrying turn must carry its reasoning"
     * rule does not apply to it, and nothing it does is written to the session.
     * A failed call throws out of here with the conversation untouched.
     */
    const summary = (
      await this.ask(
        compactionPrompt(renderForSummary(plan.summarise), plan.previous),
      )
    ).trim();
    if (summary.length === 0) {
      return {
        compacted: false,
        reason: 'The model returned an empty summary, so nothing was changed.',
      };
    }

    await this.sessionService.appendEvent({
      session,
      event: buildCompactedEvent({
        summary,
        startTime: plan.startTime,
        endTime: plan.endTime,
      }),
    });
    return {compacted: true};
  }

  async deleteSession(sessionId: string, profileId?: string): Promise<void> {
    await this.assertOwned(sessionId, profileId);
    if (this.active?.sessionId === sessionId) {
      this.abortActive();
    }
    await this.sessionService.deleteSession({
      appName: this.appName,
      userId: this.userId,
      sessionId,
    });
  }

  async getTranscript(
    sessionId: string,
    profileId?: string,
  ): Promise<{session: SessionSummary; messages: TranscriptMessage[]}> {
    const entry = await this.assertOwned(sessionId, profileId);
    const events = await this.sessionService.listEvents(sessionId);
    return {session: toSummary(entry), messages: projectTranscript(events)};
  }

  private async sessionProfile(sessionId: string): Promise<string | undefined> {
    const entry = await this.sessionService.getIndexEntry(sessionId);
    return entry?.profileId;
  }

  /**
   * The conversation, if this profile owns it.
   *
   * `undefined` covers both an unknown session and one that belongs to another
   * agent, deliberately: a stale window must not be able to tell the two apart,
   * so guessing an id reveals nothing.
   */
  private async ownedEntry(
    sessionId: string,
    profileId?: string,
  ): Promise<SessionIndexEntry | undefined> {
    const entry = await this.sessionService.getIndexEntry(sessionId);
    if (!entry) {
      return undefined;
    }
    if (profileId !== undefined && entry.profileId !== profileId) {
      return undefined;
    }
    return entry;
  }

  /** The same question, as a refusal for the callers that should throw. */
  private async assertOwned(
    sessionId: string,
    profileId?: string,
  ): Promise<SessionIndexEntry> {
    const entry = await this.ownedEntry(sessionId, profileId);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return entry;
  }

  /** The refusal message, for the turn path that reports rather than throws. */
  private async ownershipProblem(
    sessionId: string,
    profileId?: string,
  ): Promise<string | undefined> {
    const entry = await this.ownedEntry(sessionId, profileId);
    return entry ? undefined : `Unknown session: ${sessionId}`;
  }

  /**
   * Runs one turn. Callers must consume the whole generator.
   *
   * The profile check happens before anything is sent: appending to another
   * agent's conversation is the one wrong the rest of this class refuses.
   *
   * `instruction` is prompt text for this turn only — the desktop companion
   * asking for a shorter answer than the window asks for. It is applied here
   * rather than by the caller because it has to be cleared as reliably as it is
   * set: a caller that set it and forgot to unset it would leave the *window*
   * answering in the pet's voice, and that is a bug nobody would trace back to
   * this line.
   */
  async *run(
    sessionId: string,
    text: string,
    instruction?: string,
    profileId?: string,
  ): AsyncGenerator<AgentUiEvent> {
    this.config =
      instruction === undefined
        ? {...this.config, ...{instruction: undefined}}
        : {...this.config, instruction};
    yield* this.drive(sessionId, {role: 'user', parts: [{text}]}, profileId);
  }

  /**
   * The gates this conversation is still waiting on, read from disk.
   *
   * The in-memory `gateRound` is the fast path, and it is not the truth. A
   * process that restarted, a window that reloaded, and the headless runner
   * looking at a job the app paused on all have the same problem: the gate was
   * raised by an object that no longer exists, so the only place it survives is
   * the conversation itself.
   *
   * That is the same rule the rest of this app follows — the thread on disk is
   * the state machine — and it is what makes an approval card answerable after a
   * relaunch instead of being a button that silently does nothing.
   */
  /**
   * The stored events of a conversation, for something that reads them back.
   *
   * Raw rather than projected: the review wants what was actually said, and the
   * transcript projection is shaped for drawing — it drops reasoning, merges
   * events into messages and attaches tool calls. Both readers want different
   * things from the same log, so the log is what is handed out.
   */
  async eventsFor(
    sessionId: string,
  ): Promise<Awaited<ReturnType<FileSessionService['listEvents']>>> {
    return await this.sessionService.listEvents(sessionId);
  }

  /** What the agent currently remembers, as it would be injected. */
  async memoryText(): Promise<string> {
    return await this.memory.readForPrompt();
  }

  /** How many bytes this agent's memory file holds right now. */
  async memoryBytes(): Promise<number> {
    return await this.memory.bytes();
  }

  /** Adds a fact to memory, as if the agent had called `update_memory`. */
  async remember(section: string, text: string): Promise<void> {
    // `append` is the default and the right one here: accepting a proposal adds
    // a line, and a mode that could rewrite a section would let one accepted
    // suggestion quietly replace everything the agent had learned before it.
    await this.memory.update({section, content: text, mode: 'append'});
  }

  /**
   * Asks the model one question, outside any conversation.
   *
   * A plain request rather than an agent turn: no tools, no session, no events
   * written anywhere. A review that ran through the conversation machinery would
   * appear in the transcript as something the user said, and would be re-reviewed
   * by the next look — a loop that grows.
   *
   * The reply is what the model *said*, not what it thought: thought parts are
   * dropped. Our transport aggregates a turn into one response with the reasoning
   * first (`openai-compat-llm.ts`), so the alternative is an answer with the
   * model's working glued to the front of it — which for the summariser below
   * means a summary that opens by narrating how it was written.
   *
   * A refusal or a network failure throws, and the caller decides what that
   * means; for a review, it means nothing was found.
   */
  async ask(prompt: string, abortSignal?: AbortSignal): Promise<string> {
    return await this.oneShot(prompt, this.config.model, abortSignal);
  }

  /**
   * One question to one model, with the model named by the caller.
   *
   * The parameter survives from when a conversation could pick its own model and
   * the silent-turn recovery had to ask the same one back; it is the configured
   * model at every call site now.
   */
  private async oneShot(
    prompt: string,
    model: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const llm = this.llmFor(model);
    const request = {
      model,
      contents: [{role: 'user', parts: [{text: prompt}]}],
    } as unknown as Parameters<typeof llm.generateContentAsync>[0];

    let text = '';
    for await (const response of llm.generateContentAsync(
      request,
      false,
      abortSignal,
    )) {
      for (const part of response.content?.parts ?? []) {
        if (part.thought === true || typeof part.text !== 'string') {
          continue;
        }
        text += part.text;
      }
    }
    return text;
  }

  /** The model client for the current configuration. */
  private llmFor(model: string = this.config.model): OpenAiCompatLlm {
    return new OpenAiCompatLlm({
      model,
      baseUrl: this.config.baseUrl,
      temperature: this.config.temperature,
      ...(this.config.maxOutputTokens !== undefined
        ? {maxOutputTokens: this.config.maxOutputTokens}
        : {}),
    });
  }

  async pendingGates(sessionId: string): Promise<PendingGate[]> {
    const events = await this.sessionService.listEvents(sessionId);
    return pendingGatesIn(events);
  }

  /**
   * The round to record a decision against.
   *
   * Prefers the round this process opened, and falls back to reading the gates
   * back out of the conversation when it did not open one — which is what a
   * restart, a reload or a second window looks like from here.
   *
   * The derived round is cached exactly like a live one, so a round with several
   * gates still collects all of its decisions before anything is sent: ADK reads
   * the confirmations from the newest message alone, and resuming on the first
   * decision is what leaves a turn with one tool result for two calls.
   */
  private async roundFor(sessionId: string): Promise<GateRound | undefined> {
    if (this.gateRound?.sessionId === sessionId) {
      return this.gateRound;
    }

    const gates = await this.pendingGates(sessionId);
    if (gates.length === 0) {
      return undefined;
    }

    this.gateRound = {
      sessionId,
      gates: new Set(gates.map((gate) => gate.callId)),
      decisions: new Map(),
    };
    return this.gateRound;
  }

  /**
   * Answers a pending `adk_request_confirmation` gate. ADK resumes the paused
   * call when the newest user turn carries a function response whose name is
   * the gate name and whose id is the gate's call id.
   *
   * A gate is only part of the answer when its turn asked about several calls:
   * ADK reads the confirmations from the newest user message alone, so the
   * decisions are held until every gate of the round has one and then sent
   * together. Resuming on the first decision is what left a real turn with one
   * tool result for two tool calls, which the provider refuses.
   *
   * A gate that is not waiting anywhere — answered already, or belonging to a
   * round abandoned by a later turn — is dropped rather than sent: ADK would
   * refuse it as a confirmation for a call it is not asking about, and the
   * window has taken its card down by then.
   */
  async *approve(params: ApproveParams): AsyncGenerator<AgentUiEvent> {
    const round = await this.roundFor(params.sessionId);
    if (!round) {
      return;
    }
    if (!round.gates.has(params.callId)) {
      return;
    }

    round.decisions.set(params.callId, {
      confirmed: params.confirmed,
      ...(params.payload !== undefined ? {payload: params.payload} : {}),
    });
    if (round.decisions.size < round.gates.size) {
      return;
    }

    // Built before the drive, which starts its own round: an undecided gate
    // cannot survive into the message, so the round is read out in full here.
    const parts: Part[] = [...round.gates].map((callId) =>
      confirmationResponse(
        callId,
        round.decisions.get(callId) ?? {confirmed: false},
      ),
    );
    yield* this.drive(params.sessionId, {role: 'user', parts});
  }

  abort(sessionId: string): boolean {
    if (this.active?.sessionId !== sessionId) {
      return false;
    }
    this.abortActive();
    return true;
  }

  /**
   * Whether a turn is in flight.
   *
   * The scheduler asks before it dispatches: this host answers one turn at a
   * time, and a scheduled job that collided with the user's own message would be
   * refused by `drive` and lost. Asking first turns that into "run it in a
   * moment" instead.
   */
  isBusy(): boolean {
    return this.active !== undefined;
  }

  /** The session a turn is running in, when one is. Exposed for the scheduler. */
  activeSessionId(): string | undefined {
    return this.active?.sessionId;
  }

  /** Stops any in-flight turn. Called when the app is quitting. */
  dispose(): void {
    this.abortActive();
  }

  private abortActive(): void {
    this.active?.controller.abort();
    this.active = undefined;
  }

  /** The runner for a model, built on first use and reused afterwards. */
  private runnerFor(model: string): Runner {
    const cached = this.runners.get(model);
    if (cached) {
      return cached;
    }

    const agent = new LlmAgent({
      name: MAIN_AGENT_NAME,
      description: 'Marimo, a local desktop assistant.',
      model: new OpenAiCompatLlm({
        model,
        baseUrl: this.config.baseUrl,
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxOutputTokens,
      }),
      instruction: async () =>
        composeInstruction({
          base: this.config.systemPrompt,
          // Read per request for the same reason as the tools below it: someone
          // editing how they want to be talked to while a turn is running should
          // reach that turn's next request rather than the next turn.
          ...(this.config.preferences !== undefined
            ? {preferences: this.config.preferences}
            : {}),
          // Read per request rather than per turn: the model may have just
          // written to memory, and the next request should already see it.
          memory: await this.memory.readForPrompt(),
          // Whatever the surface that asked for this turn wanted, if there was
          // anything. `run` cleared it on its way in, so a turn that asked for
          // nothing — every turn from the window — carries no trace of the pet's.
          ...(this.config.instruction !== undefined
            ? {instruction: this.config.instruction}
            : {}),
          // Which capabilities the prompt may describe. Read per request for the
          // same reason as memory above: a profile edited in Settings while a
          // turn is in flight should reach that turn's next request rather than
          // the next turn.
          ...(this.config.enabledTools !== undefined
            ? {tools: this.config.enabledTools}
            : {}),
          ...(this.config.enabledSkills !== undefined
            ? {userSkillNames: this.config.enabledSkills}
            : {}),
          // Read from the config on every request, like memory above it: a skill
          // saved midway through a turn is in the very next request that turn
          // makes, which is what makes `/learn` take effect immediately.
          ...(this.config.userSkills !== undefined
            ? {userSkills: this.config.userSkills}
            : {}),
        }),
      tools: createTools(this.config, {
        memory: this.memory,
        model,
        ...(this.webSearch ? {webSearch: this.webSearch} : {}),
        ...(this.jobService ? {jobService: this.jobService} : {}),
        ...(this.discordService ? {discordService: this.discordService} : {}),
        ...(this.deskService ? {deskService: this.deskService} : {}),
        ...(this.skillService ? {skillService: this.skillService} : {}),
        ...(this.mcpServers.length > 0 ? {mcpServers: this.mcpServers} : {}),
        subagent: this.subagentDeps(),
      }),
    });

    const runner = new Runner({
      appName: this.appName,
      agent,
      sessionService: this.sessionService,
      /*
       * A plugin rather than an agent callback, because it has to see the calls
       * of a helper agent too: a subagent that loops burns the same turn's
       * context, and the caller waiting on it has no way to notice.
       */
      plugins: [new RepeatedToolCallPlugin()],
    });
    this.runners.set(model, runner);
    return runner;
  }

  /**
   * How a helper agent is built, when the profile allows one.
   *
   * The child is built by this same function's tools, minus this dependency —
   * which is what makes depth one, rather than a number to compare. It gets the
   * same model, the same tools and the same approval rules, and it cannot see
   * the conversation it was called from.
   */
  private subagentDeps(): SubagentDeps {
    return {
      build: ({name, task}) => {
        const tools = createTools(this.config, {
          memory: this.memory,
          model: this.config.model,
          ...(this.webSearch ? {webSearch: this.webSearch} : {}),
          /*
           * Deliberately *not* the job, Discord or desk services. A helper is a
           * short-lived thing answering one question; giving it the ability to
           * schedule jobs or post to a chat server is reach it was not asked
           * for, and the user has no way to see it coming.
           */
        });
        return new LlmAgent({
          name,
          description: `A helper agent doing: ${task}`,
          model: new OpenAiCompatLlm({
            model: this.config.model,
            baseUrl: this.config.baseUrl,
            temperature: this.config.temperature,
            ...(this.config.maxOutputTokens !== undefined
              ? {maxOutputTokens: this.config.maxOutputTokens}
              : {}),
          }),
          instruction:
            'You are a helper agent. You cannot see the conversation that asked ' +
            'for you and you cannot ask questions back, so work only from the ' +
            'task you were given and say plainly if it is not enough. Answer ' +
            'with the result itself, not with a description of what you did.',
          tools,
        });
      },
      ...(this.onSubagentEvent === undefined
        ? {}
        : {onEvent: this.onSubagentEvent}),
      ...(this.subagentLimits === undefined
        ? {}
        : {limits: this.subagentLimits}),
    };
  }

  private async *drive(
    sessionId: string,
    newMessage: Content,
    profileId?: string,
  ): AsyncGenerator<AgentUiEvent> {
    const messageId = randomUUID();

    // A gap here is refused as a failed turn rather than thrown, because a
    // generator that throws mid-stream is harder for the window to report.
    const ownership = await this.ownershipProblem(sessionId, profileId);
    if (ownership) {
      yield {type: 'turn.failed', sessionId, messageId, message: ownership};
      return;
    }
    if (this.active) {
      yield {
        type: 'turn.failed',
        sessionId,
        messageId,
        message: 'A turn is already running. Wait for it to finish or stop it.',
      };
      return;
    }
    const model = this.config.model;
    const runner = this.runnerFor(model);

    const controller = new AbortController();
    this.active = {sessionId, controller};
    /*
     * A turn is where a round begins, and starting one abandons whatever the
     * last turn was waiting on: the user asked something else, or stopped the
     * paused turn. The gates of this turn are collected as they are yielded.
     */
    this.gateRound = {
      sessionId,
      gates: new Set<string>(),
      decisions: new Map(),
    };
    yield {type: 'turn.started', sessionId, messageId};

    let streamedText = '';
    let streamedReasoning = '';
    let usage: TokenUsage | undefined;
    let failure: {code?: string; message: string} | undefined;
    /** Whether this turn completed with nothing at all the user could see. */
    let silent = false;
    /** The reply a silent turn was rescued with, when the model supplied one. */
    let recovered: string | undefined;
    /*
     * Every event of a turn carries the invocation that produced it, and the
     * recovery below stamps the message it writes with the same one: an event
     * with a different invocation id reads to `pendingGatesIn` as a new turn,
     * and a new turn abandons the gates of this one.
     */
    let invocationId = '';

    try {
      const events = runner.runAsync({
        userId: this.userId,
        sessionId,
        newMessage,
        abortSignal: controller.signal,
        // SSE is what makes the model reply token by token, and it is also what
        // makes ADK hand the provider `stream: true`.
        runConfig: {streamingMode: StreamingMode.SSE},
      });

      for await (const event of events) {
        if (event.invocationId) {
          invocationId = event.invocationId;
        }
        for (const part of event.content?.parts ?? []) {
          // A thought part is the model's reasoning, not its answer. It is
          // streamed into the collapsible reasoning block and persisted with the
          // turn so the next request can echo it back.
          if (part.thought === true) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              if (event.partial === true) {
                streamedReasoning += part.text;
                yield {
                  type: 'reasoning.delta',
                  sessionId,
                  messageId,
                  text: part.text,
                };
              } else if (streamedReasoning.length === 0) {
                streamedReasoning = part.text;
                yield {
                  type: 'reasoning.delta',
                  sessionId,
                  messageId,
                  text: part.text,
                };
              }
            }
            continue;
          }

          if (typeof part.text === 'string' && part.text.length > 0) {
            if (event.partial === true) {
              streamedText += part.text;
              yield {
                type: 'text.delta',
                sessionId,
                messageId,
                text: part.text,
              };
            } else if (streamedText.length === 0) {
              // Non-streaming path: the aggregated event is the only copy of
              // the text, so surface it as one delta.
              streamedText = part.text;
              yield {
                type: 'text.delta',
                sessionId,
                messageId,
                text: part.text,
              };
            }
          }

          const call = part.functionCall;
          if (call) {
            if (call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
              const gate = readGate(call.args);
              // Every gate ADK asks about in this turn belongs to one round, so
              // the answer is sent as one message once they have all been
              // decided. A gate with no id cannot be answered at all, and is
              // left out rather than blocking the round on a decision the
              // window has no card to collect.
              if (call.id) {
                this.gateRound?.gates.add(call.id);
              }
              yield {
                type: 'approval.request',
                sessionId,
                messageId,
                callId: call.id ?? '',
                tool: gate.tool,
                args: gate.args,
                hint: gate.hint,
              };
            } else {
              yield {
                type: 'tool.started',
                sessionId,
                messageId,
                callId: call.id ?? '',
                tool: call.name ?? 'unknown',
                args: call.args ?? {},
              };
            }
          }

          const response = part.functionResponse;
          if (
            response &&
            response.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
            !isConfirmationRefusal(response.response)
          ) {
            yield {
              type: 'tool.finished',
              sessionId,
              messageId,
              callId: response.id ?? '',
              tool: response.name ?? 'unknown',
              ok: !hasError(response.response),
              result: describeToolResult(response.response),
            };
          }
        }

        usage = readUsage(event) ?? usage;

        if (event.errorCode || event.errorMessage) {
          failure = {
            code: event.errorCode,
            message: event.errorMessage ?? 'The model reported an error.',
          };
        }
      }

      /*
       * A completed turn that said nothing. This is the failure the user
       * reported: a small model puts its whole reply in the reasoning channel
       * and emits no content and no tool call, ADK ends the turn there, and
       * every layer above treats "no answer" as a successful turn — so the
       * window draws an empty bubble and the user is left waiting for something
       * that will never arrive. Whitespace counts as nothing: a bubble holding a
       * space is the same silence to the person looking at it.
       *
       * A turn that raised an approval card is excluded: it is not silent, it is
       * waiting, and the card is what the user is meant to look at.
       *
       * Done here, inside the turn, rather than after the `finally` below —
       * `this.active` is the one-turn-at-a-time lock, and a recovery that
       * released it first would let a scheduled job start a conversation turn
       * while this one was still writing to the same session.
       */
      if (
        !controller.signal.aborted &&
        failure === undefined &&
        streamedText.trim().length === 0 &&
        this.raisedNoGate()
      ) {
        silent = true;
        recovered = await this.recoverSilentTurn({
          sessionId,
          invocationId,
          userText: userTextOf(newMessage),
          reasoning: streamedReasoning,
          abortSignal: controller.signal,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failure = {message: describeError(error)};
      }
    } finally {
      this.active = undefined;
    }

    if (controller.signal.aborted) {
      yield {type: 'turn.aborted', sessionId, messageId};
    } else if (failure) {
      yield {
        type: 'turn.failed',
        sessionId,
        messageId,
        code: failure.code,
        message: failure.message,
      };
    } else if (recovered !== undefined) {
      yield {type: 'text.delta', sessionId, messageId, text: recovered};
      yield {type: 'turn.completed', sessionId, messageId, usage};
    } else if (silent) {
      /*
       * Reported as a failed turn rather than as words the model never said.
       * The alternative — writing a sentence into the transcript and letting it
       * read as the agent's reply — is the one thing this app's own rules
       * forbid: never claim something happened that did not.
       */
      yield {
        type: 'turn.failed',
        sessionId,
        messageId,
        message: SILENT_TURN_MESSAGE,
      };
    } else {
      yield {type: 'turn.completed', sessionId, messageId, usage};
    }
    yield {type: 'session.changed', sessionId};
  }

  /** Whether this turn paused on an approval card rather than going quiet. */
  private raisedNoGate(): boolean {
    return (this.gateRound?.gates.size ?? 0) === 0;
  }

  /**
   * Asks the model once more for the answer it thought instead of said.
   *
   * The model's reasoning is handed back to it rather than thrown away, and that
   * is the whole trick: in the observed failure the reasoning ended with the
   * decision to ask the user which recipe they wanted — the answer existed and
   * was simply never emitted. Asking a second time with that reasoning in view
   * recovers it, and a fresh request is cheap next to the turn that was already
   * spent.
   *
   * The recovered words are *stored*, not merely streamed, because the window
   * re-reads the transcript the moment the turn completes — a message that was
   * only streamed would vanish on the reload that follows it. Written as an
   * ordinary model event under this turn's invocation id, it is what the next
   * turn replays as the agent's own last message, which is exactly what it is.
   *
   * Returns `undefined` when there is nothing to show: the caller then reports a
   * failed turn. A model that produces reasoning-only twice in a row is a real
   * signal, and dressing it up as an answer would hide it.
   */
  private async recoverSilentTurn(params: {
    sessionId: string;
    invocationId: string;
    userText: string;
    reasoning: string;
    abortSignal: AbortSignal;
  }): Promise<string | undefined> {
    let answer = '';
    try {
      answer = (
        await this.oneShot(
          silentTurnPrompt(params.userText, params.reasoning),
          this.config.model,
          params.abortSignal,
        )
      ).trim();
    } catch {
      // A failed recovery is not a failed turn of its own: the turn is already
      // over, and all that is left to decide is what the user is told.
      return undefined;
    }
    if (answer.length === 0) {
      return undefined;
    }

    const session = await this.sessionService.getSession({
      appName: this.appName,
      userId: this.userId,
      sessionId: params.sessionId,
    });
    if (session === undefined) {
      return undefined;
    }
    await this.sessionService.appendEvent({
      session,
      event: createEvent({
        author: MAIN_AGENT_NAME,
        invocationId: params.invocationId,
        content: {role: 'model', parts: [{text: answer}]},
        timestamp: Date.now(),
      }),
    });
    return answer;
  }
}

function toSummary(entry: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  workspaceId?: string;
  source?: SessionSource;
}): SessionSummary {
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    messageCount: entry.messageCount,
    ...(entry.workspaceId ? {workspaceId: entry.workspaceId} : {}),
    ...(entry.source ? {source: entry.source} : {}),
  };
}

/**
 * Compares two optional name lists by content.
 *
 * A profile's tool and skill selections arrive as a fresh array on every config
 * update, so an identity comparison would see a change on every keystroke in
 * Settings and abort a running turn for nothing.
 */
function sameList(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

function readUsage(event: AdkEvent): TokenUsage | undefined {
  const usage = event.usageMetadata;
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.promptTokenCount ?? 0,
    completionTokens: usage.candidatesTokenCount ?? 0,
    totalTokens:
      usage.totalTokenCount ??
      (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
  };
}

interface GateDetails {
  tool: string;
  args: unknown;
  hint: string;
}

function readGate(args: unknown): GateDetails {
  if (!args || typeof args !== 'object') {
    return {tool: 'unknown', args: {}, hint: ''};
  }
  const record = args as {
    originalFunctionCall?: {name?: string; args?: unknown};
    toolConfirmation?: {hint?: string};
  };
  return {
    tool: record.originalFunctionCall?.name ?? 'unknown',
    args: record.originalFunctionCall?.args ?? {},
    hint: record.toolConfirmation?.hint ?? '',
  };
}

/**
 * The gates a conversation has been asked and not yet answered.
 *
 * A gate is raised by an ADK function call and settled by a function response
 * carrying the same id, so "still pending" is exactly "asked, and no response
 * with that id since". Reading it out of the event stream rather than out of
 * memory is what lets a card survive a relaunch: the process that raised it is
 * gone, and the conversation is the only thing that is not.
 *
 * **Only the newest invocation counts.** A turn is one invocation, and starting
 * a new one abandons whatever the previous turn was waiting on — the app has
 * always behaved that way, it just had nothing on disk to say so. Without this,
 * a gate the user walked away from would come back as a card every time the
 * window reloaded, and pressing Approve on it would ask ADK to confirm a call
 * belonging to a turn that is over.
 *
 * Note the shape of a real approval: the question is asked in one invocation and
 * answered in the *next* one, because resuming is a new turn carrying the
 * confirmation. That is why this tracks the newest invocation rather than
 * looking for gates with no answer anywhere — after an approval, the newest
 * invocation is the one that answered it, and it has nothing pending.
 *
 * Order is the order the questions were asked, so a round of several gates draws
 * its cards the same way every time it is read.
 */
export function pendingGatesIn(events: readonly AdkEvent[]): PendingGate[] {
  let invocation: string | undefined;
  let asked = new Map<string, PendingGate>();
  let answered = new Set<string>();

  for (const event of events) {
    /*
     * A compaction is not a turn and carries no invocation id. The empty id
     * would read as "a new invocation" below and clear the cards of the turn
     * that is actually waiting — a live approval silently disappearing when
     * somebody compacted the conversation it belongs to.
     */
    if (isCompactedEvent(event)) {
      continue;
    }

    if (event.invocationId !== undefined && event.invocationId !== invocation) {
      invocation = event.invocationId;
      asked = new Map();
      answered = new Set();
    }

    for (const part of event.content?.parts ?? []) {
      const call = part.functionCall;
      if (call?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
        /*
         * A gate with no id cannot be answered — there is nothing for a response
         * to match — so it is left out rather than shown as a card that could
         * never work.
         */
        if (call.id) {
          const gate = readGate(call.args);
          asked.set(call.id, {
            callId: call.id,
            tool: gate.tool,
            args: gate.args,
            hint: gate.hint,
            askedAt: new Date(event.timestamp).toISOString(),
          });
        }
        continue;
      }

      // Any response settles its call, whatever it answers: a refusal is an
      // answer, and so is a tool result that came back after approval.
      const response = part.functionResponse;
      if (response?.id) {
        answered.add(response.id);
      }
    }
  }

  return [...asked.values()].filter((gate) => !answered.has(gate.callId));
}

function hasError(response: unknown): boolean {
  return (
    !!response &&
    typeof response === 'object' &&
    ('error' in (response as Record<string, unknown>) ||
      'errorMessage' in (response as Record<string, unknown>))
  );
}

/**
 * ADK returns this payload instead of running a gated tool, right before it
 * emits the approval gate for the same call. Reporting it as a finished tool
 * would make the UI show a failed call next to the approval dialog, so it is
 * dropped and the call stays visibly pending until the user decides.
 */
function isConfirmationRefusal(response: unknown): boolean {
  if (!response || typeof response !== 'object') {
    return false;
  }
  const error = (response as {error?: unknown}).error;
  return (
    typeof error === 'string' &&
    error.startsWith('This tool call requires confirmation')
  );
}

function describeToolResult(response: unknown): string {
  if (response === undefined || response === null) {
    return '';
  }
  let value: unknown = response;
  if (typeof response === 'object' && 'result' in (response as object)) {
    value = (response as {result: unknown}).result;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as {cause?: unknown}).cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * What the user is told when a turn had nothing to say and could not be rescued.
 *
 * Deliberately not phrased as the agent's reply. It goes out as `turn.failed`
 * and is drawn where every other failure is, because a sentence in the
 * transcript would read as the model having answered, and it did not.
 */
const SILENT_TURN_MESSAGE =
  'The model returned only reasoning and no reply, and a second attempt came ' +
  'back empty too. Try again, or rephrase the request.';

/** How much of a silent turn's reasoning is handed back to the model. */
const MAX_REASONING_ECHO_CHARS = 4_000;

/** The text the user sent this turn, for a turn that has any. */
function userTextOf(content: Content): string {
  return (content.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * The prompt that turns reasoning-only output into an answer.
 *
 * It states the problem plainly and then hands back the two things the model
 * needs to answer from: what the user asked, and what it had already worked out.
 * The reasoning is taken from its tail, because the decision the model failed to
 * voice is at the end of it — the opening of a small model's reasoning is
 * restating the question, which is worth nothing here.
 *
 * The last line matters more than it looks. Without it a small model tends to
 * answer by narrating the recovery ("I see my previous response had no
 * content…"), which is a worse reply than the silence it replaced.
 */
function silentTurnPrompt(userText: string, reasoning: string): string {
  const sections = [
    'Your previous reply to the user contained only private reasoning and no ' +
      'message, so the user saw nothing at all.',
  ];

  if (userText.length > 0) {
    sections.push(`The user's message was:\n"""\n${userText}\n"""`);
  }

  const tail = reasoning.slice(-MAX_REASONING_ECHO_CHARS);
  if (tail.length > 0) {
    sections.push(`What you had worked out:\n"""\n${tail}\n"""`);
  }

  sections.push(
    'Write the reply the user should have received, in your own voice, as plain ' +
      'text. Do not call any tools. If you had decided to ask the user ' +
      'something, ask it now. Do not refer to this instruction, and do not ' +
      'mention that anything went wrong — just answer.',
  );

  return sections.join('\n\n');
}
