/**
 * The agent, running.
 *
 * One object that owns everything a turn needs — the settings, the profiles, the
 * skills, the tools, and one `AgentHost` per profile — so that both processes can
 * have an agent without either of them owning the wiring.
 *
 * That "both processes" is the point. The window hosts this in the Electron main
 * process; the headless job runner hosts the same class in a plain Node process
 * with no `app`, no window and no display. The only difference is what the caller
 * supplies: the window passes a `safeStorage`-backed secret reader and a browser
 * for web search, and the runner passes the plain-text reader and nothing else.
 * Neither difference is visible from here.
 *
 * A host is kept per profile rather than rebuilt per turn, because it holds the
 * session service and the conversation state. What *is* rebuilt — the cached ADK
 * runner inside it — happens when the configuration actually changed, decided by
 * a cheap signature rather than by rebuilding every time: a runner built per turn
 * would re-read every skill and rebuild every tool on every message, and a
 * settings change that arrived mid-turn would abort the turn the user is
 * watching.
 */
import {
  AgentHost,
  describeTools,
  MAX_MEMORY_BYTES,
  MemoryStore,
  runReview,
  SAFE_DEFAULT_TOOLS,
} from '@marimo/agent';
import type {
  DeskService,
  DiscordService,
  JobService,
  McpToolsetSource,
  PendingGate,
  Skill,
  SkillService,
  WebSearchProvider,
} from '@marimo/agent';
import {activeProvider} from '@marimo/protocol';
import type {
  AgentProfile,
  AgentUiEvent,
  CatalogEntry,
  MemoryProposal,
  MemoryUsage,
  TranscriptMessage,
  ProfileCatalog,
  ProfilePatch,
  ProviderId,
  SessionSummary,
  SettingsPatch,
  StoredSettings,
  StoredSkill,
} from '@marimo/protocol';

import type {AppPaths} from '../paths.js';
import {ProfileStore} from '../profiles.js';
import type {SecretRead} from '../secrets.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import {SettingsStore} from '../settings.js';
import {SkillStore} from '../skills.js';
import {resolveAgentConfig} from './resolve.js';
import {turnInstruction} from './pet-turn.js';

/** The services the app has that the agent's tools can use, if any. */
export interface RuntimeServices {
  jobService?: JobService;
  deskService?: DeskService;
  skillService?: SkillService;
  discordService?: DiscordService;
}

export interface AgentRuntimeOptions {
  paths: AppPaths;
  /**
   * Reads a provider's key, and says why when it cannot.
   *
   * Injected because the two processes answer it differently and neither answer
   * belongs here: the window decrypts through the OS keychain, and the runner —
   * which has no `app` and therefore no `safeStorage` — reads the plain-text
   * opt-in or reports that it cannot.
   */
  readSecret: (providerId: ProviderId) => Promise<SecretRead>;
  /** Present in the window, absent in the runner, which has no browser. */
  webSearch?: WebSearchProvider;
  /** The rest of the app's tools, resolved per profile. */
  services?: (profileId: string) => RuntimeServices;
  /**
   * The MCP servers that are connected right now.
   *
   * A function rather than a list because servers connect and drop while the app
   * runs, and a turn must be offered what is reachable at that moment rather than
   * what was reachable when the runtime was built.
   */
  mcpServers?: () => readonly McpToolsetSource[];
  /**
   * Where a helper agent's words go while it runs.
   *
   * Out of band, because a tool call cannot yield into the stream that is
   * awaiting it. The window draws them as a labelled group inside the turn; the
   * headless runner passes nothing and simply does not have this view.
   */
  onEvent?: (event: AgentUiEvent) => void;
  appName?: string;
}

/** Either a host ready for a turn, or the sentence explaining why not. */
export type HostResult =
  | {ok: true; host: AgentHost; profile: AgentProfile}
  | {ok: false; problem: string};

export class AgentRuntime {
  private readonly settingsStore: SettingsStore;
  private readonly profileStore: ProfileStore;
  private readonly skillStore: SkillStore;
  /** The agent's suggestions, waiting for an answer. */
  private readonly proposals: MemoryProposalStore;
  private readonly hosts = new Map<string, AgentHost>();
  /** The configuration each host was last built with, so changes are noticed. */
  private readonly applied = new Map<string, string>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.settingsStore = new SettingsStore(options.paths.settings);
    this.profileStore = new ProfileStore({
      file: options.paths.profiles,
      defaultWorkspaceRoot: options.paths.defaultWorkspace,
      // A brand-new profile starts with an identity and nothing else: every
      // capability is something the user turns on, which is the whole shape of
      // this app. The empty lists are the point, not an oversight.
      defaultIdentity: '',
      /*
       * The safe core, and nothing with reach. A brand-new install can read,
       * remember and search; writing, running commands, fetching an arbitrary
       * URL and spawning helpers are all things the user grants deliberately.
       *
       * The list lives beside the tools themselves so a rename cannot leave it
       * naming something that no longer exists — which would fail silently, as a
       * capability that is simply never offered.
       */
      defaultTools: [...SAFE_DEFAULT_TOOLS],
      defaultSkills: [],
    });
    this.skillStore = new SkillStore({file: options.paths.skills});
    this.proposals = new MemoryProposalStore({
      file: options.paths.memoryProposals,
    });
  }

  /** The settings as they are on disk right now. */
  async settings() {
    return await this.settingsStore.load();
  }

  /**
   * What this install can offer, so the settings screen builds its pick-lists
   * from what exists rather than from a list typed out a second time.
   *
   * The tools are described by *constructing* them, which is the only way the
   * wording is guaranteed to be the wording the model is given — and the only
   * way a renamed tool cannot go on being offered under its old name, which
   * would grant nothing when ticked.
   */
  async catalog(profileId: string): Promise<ProfileCatalog> {
    const profile = await this.profileFor(profileId);
    const workspace = profile?.workspaces.find(
      (entry) => entry.id === profile.activeWorkspaceId,
    );
    const settings = await this.settingsStore.load();

    return {
      tools: describeTools({
        workspaceRoot: workspace?.path ?? this.options.paths.defaultWorkspace,
        model: activeProvider(settings.providers).model,
        ...(this.options.webSearch ? {webSearch: this.options.webSearch} : {}),
        /*
         * The host always builds the helper tool; the profile decides whether
         * this agent may use it, which is what the pick-list is for.
         */
        subagent: true,
        /*
         * And every service this app wires, named explicitly. A tool the host
         * builds but the catalogue omits can never be granted — the switch for
         * it does not exist — so the two have to be kept in step, and the test
         * beside this file compares them.
         */
        jobs: true,
      }),
      skills: await this.skillCatalog(),
    };
  }

  /** The skills a profile can be granted: the ones that ship, plus the user's. */
  private async skillCatalog(): Promise<CatalogEntry[]> {
    const stored = await this.skillStore.load();
    return stored.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
  }

  /**
   * Changes a preference.
   *
   * Hosts are dropped when the change is one an agent was built around — its
   * model, its tool reach, whether it may fetch from the private network — so
   * the next turn is built from what the settings now say rather than from what
   * they said when the host was made.
   */
  async updateSettings(patch: SettingsPatch): Promise<StoredSettings> {
    const before = await this.settingsStore.load();
    const after = await this.settingsStore.patch(patch);

    const rebuild =
      before.providers.active !== after.providers.active ||
      before.temperature !== after.temperature ||
      before.maxOutputTokens !== after.maxOutputTokens ||
      before.allowPrivateNetworkFetch !== after.allowPrivateNetworkFetch ||
      JSON.stringify(before.providers.configs) !==
        JSON.stringify(after.providers.configs);

    if (rebuild) {
      for (const profileId of [...this.hosts.keys()]) {
        this.dropHost(profileId);
      }
    }
    return after;
  }

  async updateProfile(
    profileId: string,
    patch: ProfilePatch,
  ): Promise<AgentProfile> {
    /*
     * A profile whose tools changed has a host holding the old tool set, so the
     * host is dropped rather than updated. It is rebuilt with the new grant on
     * the next turn, which is the same path a first turn takes — a cheaper and
     * better-tested route than pushing a new tool list into a live agent.
     */
    const updated = await this.profileStore.update(profileId, patch);
    this.dropHost(profileId);
    return updated;
  }

  async createProfile(name?: string): Promise<AgentProfile> {
    return await this.profileStore.create(name);
  }

  async selectProfile(profileId: string): Promise<AgentProfile> {
    return await this.profileStore.select(profileId);
  }

  /**
   * Reads a conversation back and proposes what is worth remembering.
   *
   * Answers what it added, so a caller can say so. Does nothing at all when the
   * agent cannot be built — a review is a background nicety, and an
   * unconfigured install has nothing to review *with*.
   *
   * The watermark is moved whether or not anything was found. That is the
   * difference between a feature and a nuisance: "I looked and found nothing" is
   * the answer most of the time, and not recording it means looking again on
   * every idle moment, forever.
   */
  async reviewMemory(
    profileId: string,
    sessionId: string,
  ): Promise<MemoryProposal[]> {
    const settings = await this.settingsStore.load();
    const profile = await this.profileFor(profileId);
    if (profile === undefined) {
      return [];
    }
    const resolved = await resolveAgentConfig({
      settings,
      profile,
      readSecret: this.options.readSecret,
      skills: await this.skillsFor(profile),
    });
    if (!resolved.ok) {
      return [];
    }

    const host = await this.ensureHost(profileId);
    host.updateConfig(resolved.config);

    const events = await host.eventsFor(sessionId);
    const reviewed = events.filter((event) => event.partial !== true).length;
    const from = await this.proposals.reviewedUpTo(sessionId);
    if (reviewed <= from) {
      // Nothing new since last time. Not asking is the common case and the
      // reason the watermark exists.
      return [];
    }

    const memory = await host.memoryText();
    const found = await runReview({
      // Only what has not been read before.
      events: events.slice(from),
      memory,
      ask: async (prompt) => await host.ask(prompt),
    });

    const recorded = await this.proposals.record(
      sessionId,
      reviewed,
      found.map((proposal) => ({
        sessionId,
        profileId,
        section: proposal.section,
        text: proposal.text,
        reason: proposal.reason,
      })),
    );

    // The ids the store assigned, so the window can act on them.
    const added = new Set(found.map((proposal) => proposal.text));
    return recorded.proposals.filter((proposal) => added.has(proposal.text));
  }

  /** The suggestions waiting for this agent. */
  async memoryProposals(profileId?: string): Promise<MemoryProposal[]> {
    const file = await this.proposals.load();
    return profileId === undefined
      ? file.proposals
      : file.proposals.filter((proposal) => proposal.profileId === profileId);
  }

  /**
   * How full this agent's memory is, for the size control in Settings.
   *
   * The file size comes from the agent's own store when one is live, so the bar
   * and the agent's warning are measuring the same file. The *limit* comes from
   * settings rather than from the host: a host is handed its configuration at the
   * start of a turn, so a live one is still holding the previous limit in the
   * moment after the slider moves — and a control that snapped back to its old
   * value while the user was looking at it reads as a control that did not save.
   *
   * A profile with no host yet reads the file directly. Building one to answer
   * would mean dialling an MCP server to draw a bar.
   *
   * The hard cap is a constant of the store rather than a setting, so it is
   * reported from there instead of being recomputed here.
   */
  async memoryUsage(profileId?: string): Promise<MemoryUsage> {
    const settings = await this.settingsStore.load();
    const id = profileId ?? (await this.profileStore.activeProfile()).id;
    const host = this.hosts.get(id);
    if (host) {
      return {
        bytes: await host.memoryBytes(),
        limitBytes: settings.memorySoftLimitBytes,
        capBytes: MAX_MEMORY_BYTES,
      };
    }

    const profile = await this.profileFor(id);
    const workspace =
      profile?.workspaces.find(
        (entry) => entry.id === profile.activeWorkspaceId,
      )?.path ?? this.options.paths.defaultWorkspace;
    const store = new MemoryStore({
      workspaceRoot: workspace,
      softLimitBytes: settings.memorySoftLimitBytes,
      ...(profile !== undefined ? {profileId: profile.id} : {}),
    });
    return {
      bytes: await store.bytes(),
      limitBytes: store.softLimitBytes,
      capBytes: MAX_MEMORY_BYTES,
    };
  }

  /**
   * Accepts a suggestion, writing it into the agent's memory.
   *
   * Removed from the queue whether it is accepted or dismissed: both are
   * answers, and a suggestion that stayed after being refused would be asked
   * again on every look.
   */
  async resolveMemoryProposal(
    proposalId: string,
    accept: boolean,
  ): Promise<{ok: boolean; problem?: string}> {
    const file = await this.proposals.load();
    const proposal = file.proposals.find((entry) => entry.id === proposalId);
    if (proposal === undefined) {
      return {ok: false, problem: 'That suggestion is no longer waiting.'};
    }

    if (accept) {
      const result = await this.host(proposal.profileId);
      if (!result.ok) {
        /*
         * Kept in the queue rather than dropped. The agent cannot be built right
         * now — no key, a bad model — and that is a reason to try again later,
         * not a reason to throw away something the user just agreed to.
         */
        return {ok: false, problem: result.problem};
      }
      await result.host.remember(proposal.section, proposal.text);
    }

    await this.proposals.remove(proposalId);
    return {ok: true};
  }

  /** The catalogue for whichever agent is active, for a window that just opened. */
  async catalogForActive(): Promise<{
    profileId: string;
    catalog: ProfileCatalog;
  }> {
    const profile = await this.profileStore.activeProfile();
    return {profileId: profile.id, catalog: await this.catalog(profile.id)};
  }

  async profiles(): Promise<AgentProfile[]> {
    return await this.profileStore.profiles();
  }

  async activeProfile(): Promise<AgentProfile> {
    return await this.profileStore.activeProfile();
  }

  /** Every conversation, or one agent's. */
  async listSessions(profileId?: string): Promise<SessionSummary[]> {
    const profile = profileId ?? (await this.profileStore.activeProfile()).id;
    const host = await this.ensureHost(profile);
    return await host.listSessions(profile);
  }

  /**
   * Starts a conversation.
   *
   * Deliberately does *not* require a working configuration. A conversation is a
   * file, and the window needs somewhere to put the refusal when the provider is
   * not set up yet — gating this on a resolvable config would mean a fresh
   * install could not open the chat it is supposed to explain itself in.
   *
   * The profile and its folder are stamped on at creation, which is what files
   * the conversation under the right agent and the right folder in the sidebar.
   */
  async createSession(
    profileId: string,
    title?: string,
  ): Promise<SessionSummary | undefined> {
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return undefined;
    }
    const host = await this.ensureHost(profileId);
    return await host.createSession(
      title,
      undefined,
      profileId,
      profile.activeWorkspaceId ?? undefined,
    );
  }

  /**
   * The host for a profile, brought up to date with the settings on disk.
   *
   * Bringing it up to date on the way in — rather than requiring a caller to
   * remember to — is what makes "a capability the user turned off is absent"
   * true on the *next* turn rather than after a restart.
   */
  /**
   * Reads a conversation, which needs no provider at all.
   *
   * Deliberately not `host()`. That resolves the model configuration and refuses
   * without a key — correctly, for a turn — but reading a stored conversation
   * has nothing to do with a model. Going through `host()` made every
   * conversation in the app appear *empty* the moment a key expired, was
   * cleared, or had not been entered yet: the messages were on disk and the
   * window showed nothing, which is indistinguishable from having lost them.
   */
  async transcript(
    profileId: string,
    sessionId: string,
  ): Promise<{messages: TranscriptMessage[]; pending: PendingGate[]}> {
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return {messages: [], pending: []};
    }
    /*
     * The placeholder-config host, which is the same one a turn uses before its
     * configuration is resolved. It has the session service and nothing else,
     * which is exactly what reading needs.
     */
    const host = await this.ensureHost(profileId);
    const {messages} = await host.getTranscript(sessionId, profileId);
    const pending = await host.pendingGates(sessionId);
    return {messages, pending};
  }

  async host(profileId: string): Promise<HostResult> {
    const settings = await this.settingsStore.load();
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return {ok: false, problem: `There is no agent called "${profileId}".`};
    }

    const resolved = await resolveAgentConfig({
      settings,
      profile,
      readSecret: this.options.readSecret,
      skills: await this.skillsFor(profile),
    });
    if (!resolved.ok) {
      return resolved;
    }

    const host = await this.ensureHost(profileId);
    host.updateConfig(resolved.config);
    this.applyMcpServers(host, profileId);

    return {ok: true, host, profile};
  }

  /**
   * Runs one turn, or explains why it cannot.
   *
   * A refusal is reported as a failed turn rather than thrown, because that is
   * what the window already knows how to draw: a message in the conversation
   * saying what is wrong. An exception here would be a blank screen and a
   * console line the user never sees.
   *
   * `origin` is which surface asked — the window or the floating companion —
   * and it is the only thing here that is not in the message. The two share a
   * conversation and a profile, so the pet's shorter answers have to be decided
   * per turn and read from the settings at the moment it starts: a user who
   * moved the length slider while the moss was thinking gets the new length on
   * the next question, not this one.
   */
  async *run(
    profileId: string,
    sessionId: string,
    text: string,
    origin?: 'window' | 'pet',
  ): AsyncGenerator<AgentUiEvent> {
    const result = await this.host(profileId);
    if (!result.ok) {
      yield refusal(sessionId, result.problem);
      return;
    }
    const instruction = turnInstruction(
      origin,
      (await this.settingsStore.load()).companion.answerLength,
    );
    yield* result.host.run(sessionId, text, instruction, profileId);
  }

  async *approve(
    profileId: string,
    params: {sessionId: string; callId: string; confirmed: boolean},
  ): AsyncGenerator<AgentUiEvent> {
    /*
     * No configuration check on purpose. A paused turn is already paid for and
     * already waiting; refusing to *answer* it because the key went missing
     * would strand a conversation that could still be finished — or, worse,
     * declined. The card is the user's to answer either way.
     */
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return;
    }
    const host = await this.ensureHost(profileId);
    yield* host.approve({...params, sessionId: params.sessionId});
  }

  async pendingGates(
    profileId: string,
    sessionId: string,
  ): Promise<PendingGate[]> {
    if (!(await this.profileFor(profileId))) {
      return [];
    }
    const host = await this.ensureHost(profileId);
    return await host.pendingGates(sessionId);
  }

  abort(profileId: string, sessionId: string): boolean {
    return this.hosts.get(profileId)?.abort(sessionId) ?? false;
  }

  /** Whether any agent has a turn in flight. */
  isBusy(): boolean {
    for (const host of this.hosts.values()) {
      if (host.isBusy()) {
        return true;
      }
    }
    return false;
  }

  /** Which agent is mid-turn, for a caller that has to say something about it. */
  busyProfile(): string | undefined {
    for (const [profileId, host] of this.hosts) {
      if (host.isBusy()) {
        return profileId;
      }
    }
    return undefined;
  }

  /** Forgets a profile's host, so the next turn builds one from current state. */
  private dropHost(profileId: string): void {
    const host = this.hosts.get(profileId);
    if (host !== undefined) {
      host.dispose();
      this.hosts.delete(profileId);
      this.applied.delete(profileId);
    }
  }

  dispose(): void {
    for (const host of this.hosts.values()) {
      host.dispose();
    }
    this.hosts.clear();
    this.applied.clear();
  }

  private async profileFor(
    profileId: string,
  ): Promise<AgentProfile | undefined> {
    return (await this.profileStore.profiles()).find(
      (profile) => profile.id === profileId,
    );
  }

  /**
   * The skills a profile carries, in the shape the prompt wants.
   *
   * Filtered by `enabledSkills` rather than passing everything: a skill is
   * prompt text carried on every single request, so one the user switched off is
   * a cost they have already declined to pay.
   */
  private async skillsFor(profile: AgentProfile): Promise<Skill[]> {
    if (profile.enabledSkills.length === 0) {
      return [];
    }
    const stored = await this.skillStore.load();
    const wanted = new Set(profile.enabledSkills);
    return stored
      .filter((skill: StoredSkill) => wanted.has(skill.name))
      .map((skill: StoredSkill) => ({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
      }));
  }

  private async ensureHost(profileId: string): Promise<AgentHost> {
    const existing = this.hosts.get(profileId);
    if (existing) {
      return existing;
    }

    const services = this.options.services?.(profileId) ?? {};
    const host = new AgentHost({
      sessionsDir: this.options.paths.sessions,
      // A placeholder config: `host()` resolves the real one and calls
      // `updateConfig` before any turn runs. Constructing with the settings
      // shape here would mean reading them twice and risking the two reads
      // disagreeing.
      config: {
        apiKey: '',
        baseUrl: '',
        model: '',
        temperature: 0,
        systemPrompt: '',
        profileId,
        workspaceRoot: this.options.paths.defaultWorkspace,
        allowPrivateNetworkFetch: false,
      },
      ...(this.options.appName !== undefined
        ? {appName: this.options.appName}
        : {}),
      ...(this.options.webSearch ? {webSearch: this.options.webSearch} : {}),
      ...(services.jobService ? {jobService: services.jobService} : {}),
      ...(services.deskService ? {deskService: services.deskService} : {}),
      ...(services.skillService ? {skillService: services.skillService} : {}),
      ...(services.discordService
        ? {discordService: services.discordService}
        : {}),
      ...(this.options.onEvent === undefined
        ? {}
        : {onSubagentEvent: this.options.onEvent}),
    });
    host.init();
    this.hosts.set(profileId, host);
    return host;
  }

  /**
   * Hands the host the connected servers, if that set has changed.
   *
   * Compared by a signature of the names rather than by array identity, so a
   * caller that rebuilds its list on every call does not invalidate the runner
   * on every turn. What matters is whether the *model* would see a different
   * tool list.
   */
  private applyMcpServers(host: AgentHost, profileId: string): void {
    const sources = this.options.mcpServers?.() ?? [];
    const signature = sources
      .map(
        (source: McpToolsetSource) =>
          `${source.server.name}(${source.tools
            .map((tool) => tool.name)
            .join(',')})`,
      )
      .join('|');

    if (this.applied.get(profileId) === signature) {
      return;
    }
    this.applied.set(profileId, signature);
    host.setMcpServers(sources);
  }
}

/** A turn that never started, said in the shape the window already draws. */
function refusal(sessionId: string, problem: string): AgentUiEvent {
  return {
    type: 'turn.failed',
    sessionId,
    // No assistant message was ever written, so there is none to point at. The
    // window shows this beside the composer rather than under a bubble.
    messageId: '',
    code: 'not-configured',
    message: problem,
  };
}
