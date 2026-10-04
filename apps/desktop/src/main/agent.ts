/**
 * The agent, running in this process.
 *
 * Everything the window can ask an agent to do goes through here: list the
 * agents, list and open conversations, send a message, answer a card, stop a
 * turn. The agent itself lives in `@marimo/runtime`, which is Electron-free and
 * is the same class the headless job runner hosts — this file is the part that
 * is specific to being inside Electron, which is three things:
 *
 * - **Where secrets come from.** Provider keys are decrypted with `safeStorage`,
 *   which only exists here. The runner passes the plain-text reader instead.
 * - **Where web search comes from.** `web_search` needs a browser engine, and
 *   Electron ships one; without it the tool is simply not offered, which is why
 *   this is allowed to be absent.
 * - **Where events go.** A turn is a stream, and this process turns it into
 *   broadcasts the window listens for.
 */
import {
  AgentRuntime,
  mcpSecretFile,
  createJobRunner,
  holdProcessLock,
  JobScheduler,
  JobStore,
  McpManager,
  secretReaderFor,
} from '@marimo/runtime';
import type {ProcessLock} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {PROVIDERS} from '@marimo/protocol';
import type {
  AgentProfile,
  Job,
  McpServer,
  AgentUiEvent,
  McpStatus,
  PendingGate,
  SessionSummary,
  TranscriptMessage,
} from '@marimo/protocol';
import type {JobService} from '@marimo/agent';

import {safeStorageCipher, secretStore} from './secrets.js';
import {BrowserSearchProvider} from './search/search-window.js';

/**
 * How often a dropped MCP server is considered for a reconnect.
 *
 * Not a retry interval — the manager keeps its own backoff and will not dial a
 * server that is inside it. This is only how often it is *asked*, so it can be
 * lazy without a server sitting dead for want of a nudge.
 */
const MCP_RECONCILE_MS = 30_000;

/**
 * How long a conversation has to be quiet before it is read back.
 *
 * A minute. Long enough that a pause for thought is not the end of a
 * conversation, short enough that the user sees the suggestion while they still
 * remember what it is about.
 */
const IDLE_REVIEW_MS = 60_000;

export interface AgentServiceOptions {
  paths: AppPaths;
  /** Where a turn's events are sent. */
  sendEvent: (event: AgentUiEvent) => void;
}

export class AgentService {
  private readonly runtime: AgentRuntime;
  private readonly mcp: McpManager;
  /**
   * Keyless web search, through a hidden window.
   *
   * A plain `fetch` cannot search any more — DuckDuckGo answers a scripted
   * challenge and Mojeek refuses outright — so the search runs in a browser
   * engine, and Electron already ships one. Owned here rather than made per
   * call: it is a window, and a window per search would be a window per search.
   */
  private readonly search = new BrowserSearchProvider();
  /**
   * Scheduled jobs, and the clock that runs them.
   *
   * Owned here so a job is an ordinary turn: it is answered by the agent that
   * owns it, in that agent's conversation, with that agent's tools — and it
   * asks for approval the same way, which is why an unattended run can park on a
   * gate rather than going ahead without one.
   */
  private readonly jobsStore: JobStore;
  private readonly scheduler: JobScheduler;
  /** Held for as long as this process is: "the app is running the jobs". */
  private appLock: ProcessLock | undefined;
  private reconcile: NodeJS.Timeout | undefined;
  /** The pending idle look, reset by each new turn. */
  private idleReview: NodeJS.Timeout | undefined;
  /** Which agent the turn in flight belongs to, for the review that follows. */
  private busyProfileId: string | undefined;
  private stopped = false;

  constructor(private readonly options: AgentServiceOptions) {
    const {paths} = options;

    this.mcp = new McpManager({
      readSecrets: secretReaderFor(paths, (file, label) =>
        secretStore(file, label),
      ),
      clientName: 'marimo-agent',
      clientVersion: '0.1.0',
      // The window redraws a badge from this. It is one field, so it travels
      // whole rather than as a diff the renderer would have to reconcile.
      onStatus: (serverId, status) => {
        options.sendEvent({
          type: 'mcp.status',
          serverId,
          status,
        } as AgentUiEvent);
      },
    });

    this.runtime = new AgentRuntime({
      paths,
      readSecret: async (providerId) => {
        // Asked every time rather than cached: on Linux a keyring that was
        // locked at launch can become usable later in the session, and the
        // difference between "no key" and "cannot read the key" is the
        // difference between two different things the user has to do.
        const store = secretStore(
          paths.providerSecrets[providerId],
          `${PROVIDERS[providerId].label} API key`,
        );
        return await store.read();
      },
      webSearch: this.search,
      mcpServers: () => this.mcp.toolsets(),
      services: () => ({jobService: this.jobService()}),
      /*
       * A helper agent's words, while the turn that asked for it is still
       * awaiting the tool call. The same channel the MCP status events use, for
       * the same reason: a tool call cannot yield into the stream awaiting it,
       * and a helper that says nothing until it finishes is a turn that looks
       * hung.
       */
      onEvent: (event) => {
        options.sendEvent(event);
      },
    });

    this.jobsStore = new JobStore({file: paths.jobs});
    this.scheduler = new JobScheduler({
      store: this.jobsStore,
      runner: createJobRunner({
        runtime: this.runtime,
        jobs: this.jobsStore,
        onEvent: (event) => {
          options.sendEvent(event);
        },
      }),
      onChange: (jobId) => {
        options.sendEvent({type: 'job.changed', jobId});
      },
    });
  }

  /**
   * The job tools, over the same store the scheduler runs from.
   *
   * One store, so a job the agent creates is a job that runs: a second copy of
   * the document would leave the model describing a schedule that the clock had
   * never heard of.
   *
   * Every mutation calls `sync`, which is what tells the scheduler to look now
   * rather than at its next idle tick. A job asked for in a conversation should
   * appear on the clock immediately, not up to thirty seconds later.
   */
  private jobService(): JobService {
    const owns = async (jobId: string, profileId: string): Promise<boolean> => {
      const document = await this.jobsStore.load();
      return document.jobs.some(
        (job) => job.id === jobId && job.profileId === profileId,
      );
    };

    return {
      list: async (profileId) => {
        const document = await this.jobsStore.load();
        return document.jobs.filter((job) => job.profileId === profileId);
      },

      create: async (input) => {
        const {job} = await this.jobsStore.create(input);
        this.scheduler.sync();
        return job;
      },

      /*
       * Ownership is checked rather than assumed. The agent names a job id from
       * its own conversation, and a stale one — or one belonging to another
       * agent — must not be editable through it: the id is the only thing tying
       * the request to a document.
       */
      update: async (jobId, patch, profileId) => {
        if (!(await owns(jobId, profileId))) {
          return null;
        }
        const job = await this.jobsStore.update(jobId, patch);
        if (job !== null) {
          this.scheduler.sync();
        }
        return job;
      },

      remove: async (jobId, profileId) => {
        if (!(await owns(jobId, profileId))) {
          return false;
        }
        const removed = await this.jobsStore.remove(jobId);
        if (removed) {
          this.scheduler.sync();
        }
        return removed;
      },
    };
  }

  /** The settings as they are on disk, for the callers that need to read them. */
  async settings() {
    return await this.runtime.settings();
  }

  /** The settings as they are on disk, for the callers that need to ask. */
  async providers(): Promise<Awaited<ReturnType<AgentRuntime['settings']>>['providers']> {
    return (await this.runtime.settings()).providers;
  }

  async start(): Promise<void> {
    /*
     * Claimed before anything else, so a headless run that is already in
     * progress knows to leave the jobs alone. Not being able to take it is not a
     * failure: it means a runner got there first, and it will be finished in
     * seconds.
     */
    this.appLock = await holdProcessLock(this.options.paths.appLock);
    await this.applyMcpServers();
    /*
     * Started after the servers, so a job whose prompt needs an MCP tool is not
     * dispatched before that tool exists.
     */
    await this.scheduler.start();
    this.reconcile = setInterval(() => {
      void this.mcp.reconcile();
    }, MCP_RECONCILE_MS);
    // A timer must not be the reason the process stays alive: the app decides
    // when it quits, and an interval holding the loop open would turn a quit
    // into a hang.
    this.reconcile.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcile !== undefined) {
      clearInterval(this.reconcile);
      this.reconcile = undefined;
    }
    this.idleReview = this.clearIdle(this.idleReview);
    this.scheduler.stop();
    await this.appLock?.release();
    this.appLock = undefined;
    await this.mcp.stop();
    this.runtime.dispose();
    this.search.dispose();
  }

  /**
   * Queues a look at what was just said, once things go quiet.
   *
   * Idle rather than immediate, and it is not a nicety: a review costs a model
   * call, and running one at the end of every turn would spend a second request
   * per message and propose things from a conversation that is still going. A
   * minute of silence means the exchange has finished.
   *
   * The timer is reset by each new turn, so a conversation in progress is never
   * reviewed halfway through — and a turn the user is still having is not a
   * conversation they have finished.
   */
  private noteForReview(event: AgentUiEvent): void {
    if (
      event.type !== 'turn.completed' &&
      event.type !== 'turn.failed' &&
      event.type !== 'turn.aborted'
    ) {
      /*
       * A new turn cancels the pending look, because the conversation is not
       * over. Only the turn events carry a session id, and only a turn is a
       * reason to remember which agent is busy.
       */
      if (event.type === 'turn.started') {
        this.idleReview = this.clearIdle(this.idleReview);
      }
      return;
    }

    const sessionId = event.sessionId;
    const profileId = this.busyProfileId;
    this.busyProfileId = undefined;
    if (sessionId.length === 0 || profileId === undefined) {
      return;
    }

    this.idleReview = this.clearIdle(this.idleReview);
    this.idleReview = setTimeout(() => {
      this.idleReview = undefined;
      void this.reviewNow(profileId, sessionId);
    }, IDLE_REVIEW_MS);
    // Not a reason to keep the process alive on its own.
    this.idleReview.unref?.();
  }

  private clearIdle(handle: NodeJS.Timeout | undefined): undefined {
    if (handle !== undefined) {
      clearTimeout(handle);
    }
    return undefined;
  }

  /**
   * Runs the review, and tells the window when something was found.
   *
   * Silent when nothing was — which is most of the time, and the reason this is
   * not a notification.
   */
  private async reviewNow(profileId: string, sessionId: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const found = await this.runtime.reviewMemory(profileId, sessionId);
      if (found.length > 0) {
        this.options.sendEvent({type: 'memory.proposed', count: found.length});
      }
    } catch (error) {
      /*
       * Reported and swallowed. This runs on a timer with nobody waiting, so a
       * throw would be an unhandled rejection in the main process — and a review
       * that failed is not something the user can act on.
       */
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[marimo] the memory review did not finish: ${detail}`);
    }
  }

  /** Re-reads the server list and dials whatever changed. */
  async applyMcpServers(): Promise<void> {
    const settings = await this.runtime.settings();
    await this.mcp.apply(settings.mcpServers);
  }

  /**
   * Adds or replaces a connector, and dials it.
   *
   * The write and the connection are one action, because they are one action to
   * the user: a window that saved the file and left the server unconnected would
   * report success for something that had not happened.
   */
  async setMcpServer(server: McpServer): Promise<McpServer[]> {
    const settings = await this.runtime.settings();
    const next = [
      ...settings.mcpServers.filter((entry) => entry.id !== server.id),
      server,
    ];
    await this.runtime.updateSettings({mcpServers: next});
    await this.applyMcpServers();
    return next;
  }

  async removeMcpServer(serverId: string): Promise<McpServer[]> {
    const settings = await this.runtime.settings();
    const next = settings.mcpServers.filter((entry) => entry.id !== serverId);
    await this.runtime.updateSettings({mcpServers: next});
    await this.applyMcpServers();
    return next;
  }

  /**
   * Stores one of a connector's secrets.
   *
   * Through the same store the provider keys use, which means the same consent
   * rule: on a machine with no keychain this needs the plain-text opt-in, and it
   * refuses rather than silently writing a readable key. A connector secret is
   * exactly as sensitive as an API key, because most of them *are* one.
   */
  async setMcpSecret(
    serverId: string,
    target: 'env' | 'header',
    name: string,
    value: string,
  ): Promise<void> {
    const settings = await this.runtime.settings();
    const store = secretStore(
      mcpSecretFile(this.options.paths, serverId, target, name),
      `the ${name} for this connector`,
    );
    await store.set(value, {allowPlaintext: settings.allowPlaintextApiKey});
  }

  /**
   * Which of a connector's secrets have a value.
   *
   * Names only. The value never crosses to the window — the same rule provider
   * keys follow — so the panel can say "set" without being able to say what.
   */
  async mcpSecretState(server: McpServer): Promise<string[]> {
    const set: string[] = [];
    for (const reference of server.secrets ?? []) {
      const store = secretStore(
        mcpSecretFile(this.options.paths, server.id, reference.target, reference.name),
        `the ${reference.name} for this connector`,
      );
      if (await store.has()) {
        set.push(`${reference.target}:${reference.name}`);
      }
    }
    return set;
  }

  /** Dials a server without saving it, so a wrong command can be found out first. */
  async testMcpServer(
    server: McpServer,
  ): Promise<{ok: boolean; detail: string}> {
    return await this.mcp.test(server);
  }

  /** Every job, for the tray's summary line. */
  async jobs(): Promise<Job[]> {
    const document = await this.jobsStore.load();
    return document.jobs;
  }

  /** The agent's memory suggestions, waiting for an answer. */
  async memoryProposals() {
    return await this.runtime.memoryProposals();
  }

  /** Accepts one into memory, or drops it. */
  async resolveMemoryProposal(proposalId: string, accept: boolean) {
    return await this.runtime.resolveMemoryProposal(proposalId, accept);
  }

  /** Reads a conversation back and proposes what is worth remembering. */
  async reviewMemory(profileId: string, sessionId: string) {
    return await this.runtime.reviewMemory(profileId, sessionId);
  }

  mcpStatuses(): Record<string, McpStatus> {
    return this.mcp.statuses();
  }

  async profiles(): Promise<{
    profiles: AgentProfile[];
    activeProfileId: string;
  }> {
    const profiles = await this.runtime.profiles();
    const active = await this.runtime.activeProfile();
    return {profiles, activeProfileId: active.id};
  }

  async catalog(profileId?: string) {
    return profileId === undefined
      ? await this.runtime.catalogForActive()
      : {profileId, catalog: await this.runtime.catalog(profileId)};
  }

  async selectProfile(profileId: string): Promise<void> {
    await this.runtime.selectProfile(profileId);
  }

  async updateProfile(
    profileId: string,
    patch: Parameters<AgentRuntime['updateProfile']>[1],
  ): Promise<void> {
    await this.runtime.updateProfile(profileId, patch);
  }

  async createProfile(name?: string) {
    const created = await this.runtime.createProfile(name);
    await this.runtime.selectProfile(created.id);
    return created;
  }

  async updateSettings(
    patch: Parameters<AgentRuntime['updateSettings']>[0],
  ): Promise<void> {
    await this.runtime.updateSettings(patch);
  }

  async listSessions(profileId?: string): Promise<SessionSummary[]> {
    return await this.runtime.listSessions(profileId);
  }

  async createSession(profileId: string): Promise<SessionSummary> {
    const session = await this.runtime.createSession(profileId);
    if (session === undefined) {
      throw new Error(`There is no agent called "${profileId}".`);
    }
    return session;
  }

  /**
   * Reads a conversation.
   *
   * Goes to the runtime's own reader rather than resolving the provider first.
   * The version that resolved it returned an empty conversation whenever the key
   * was missing — so an expired key emptied every chat in the window, and the
   * history was on disk the whole time.
   */
  async transcript(
    profileId: string,
    sessionId: string,
  ): Promise<{messages: TranscriptMessage[]; pending: PendingGate[]}> {
    return await this.runtime.transcript(profileId, sessionId);
  }

  /**
   * Starts a turn.
   *
   * Answers as soon as the turn has been *started*, because a turn is a stream
   * and an `invoke` is not: the answer arrives on the event channel. A refusal —
   * a turn already running, no key, an unknown conversation — comes back as
   * `turn.failed` on that same channel, which is the shape the window already
   * draws, so nothing here has to invent a second way to say no.
   */
  async send(
    profileId: string,
    sessionId: string,
    text: string,
  ): Promise<{accepted: boolean}> {
    /*
     * Checked here as well as inside the agent, purely so the answer is
     * synchronous. A send that is going to be refused should be refused in the
     * reply the window is waiting for, not one event later.
     */
    /*
     * Which agent is about to be busy, for the review that follows the turn.
     * Recorded here because this is the last point at which the profile is
     * known: the events a turn emits carry a conversation, not an agent.
     */
    this.busyProfileId = profileId;

    if (this.runtime.isBusy()) {
      this.options.sendEvent({
        type: 'turn.failed',
        sessionId,
        messageId: '',
        code: 'busy',
        message: 'A turn is already running. Wait for it to finish, or stop it.',
      });
      return {accepted: false};
    }

    this.pump(this.runtime.run(profileId, sessionId, text));
    return {accepted: true};
  }

  async approve(
    profileId: string,
    sessionId: string,
    callId: string,
    confirmed: boolean,
  ): Promise<{accepted: boolean}> {
    /*
     * Which agent is about to be busy, for the review that follows the turn.
     * Recorded here because this is the last point at which the profile is
     * known: the events a turn emits carry a conversation, not an agent.
     */
    this.busyProfileId = profileId;

    if (this.runtime.isBusy()) {
      this.options.sendEvent({
        type: 'turn.failed',
        sessionId,
        messageId: '',
        code: 'busy',
        message: 'A turn is already running. Wait for it to finish, or stop it.',
      });
      return {accepted: false};
    }

    this.pump(this.runtime.approve(profileId, {sessionId, callId, confirmed}));
    return {accepted: true};
  }

  abort(profileId: string, sessionId: string): {aborted: boolean} {
    return {aborted: this.runtime.abort(profileId, sessionId)};
  }

  /** Whether any agent is mid-turn. */
  isBusy(): boolean {
    return this.runtime.isBusy();
  }

  /**
   * Drains a turn's events to the window.
   *
   * The generator is consumed to completion in the background: a turn outlives
   * the call that started it, and the window may well have been closed and
   * reopened by the time it finishes.
   *
   * A throw is turned into a `turn.failed` event rather than being left to
   * reject an unawaited promise, which would be an unhandled rejection in the
   * main process — a crash with nothing on screen to explain it.
   */
  private pump(stream: AsyncGenerator<AgentUiEvent>): void {
    void (async () => {
      try {
        for await (const event of stream) {
          if (this.stopped) {
            return;
          }
          this.options.sendEvent(event);
          this.noteForReview(event);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.options.sendEvent({
          type: 'turn.failed',
          sessionId: '',
          messageId: '',
          code: 'internal',
          message: `The turn failed: ${detail}`,
        });
      }
    })();
  }
}

/** Whether an OS keychain is available to encrypt secrets on this machine. */
export function canEncryptSecrets(): boolean {
  return safeStorageCipher.available();
}
