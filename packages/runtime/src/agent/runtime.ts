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
  capabilityPresets,
  describeTools,
  MAX_MEMORY_BYTES,
  MemoryStore,
  runReview,
  SAFE_DEFAULT_TOOLS,
} from '@marimo/agent';
import type {
  AdkEvent,
  DeskService,
  DiscordService,
  JobService,
  RecallLookup,
  McpToolsetSource,
  PendingGate,
  Skill,
  SkillService,
  WebSearchProvider,
} from '@marimo/agent';
import {DEFAULT_AGENT_IDENTITY, LOCAL_MODEL_ID} from '@marimo/protocol';
import type {
  AgentProfile,
  AgentUiEvent,
  CatalogEntry,
  CompactResult,
  DismissedMemory,
  MemoryProposal,
  MemoryUsage,
  TranscriptMessage,
  ProfileCatalog,
  ProfilePatch,
  SessionSummary,
  SettingsPatch,
  StoredSettings,
  StoredSkill,
  Workspace,
  WorkspaceState,
} from '@marimo/protocol';
import {reviewDelay} from '@marimo/agent';

import type {AppPaths} from '../paths.js';
import {ProfileStore} from '../profiles.js';
import {MemoryProposalStore} from '../memory-proposals.js';
import {SettingsStore} from '../settings.js';
import {SkillStore} from '../skills.js';
import {WorkspaceStore, workspaceRootFor} from '../workspaces.js';
import {resolveAgentConfig} from './resolve.js';
import {turnInstruction} from './pet-turn.js';

/** The services the app has that the agent's tools can use, if any. */
export interface RuntimeServices {
  jobService?: JobService;
  deskService?: DeskService;
  skillService?: SkillService;
  discordService?: DiscordService;
  /**
   * Recall, when this install has it switched on.
   *
   * **One instance per profile, for the life of the process.** The host drops its
   * cached runner whenever this changes identity, because a runner holds the tool
   * closures it was built with — so a supplier that built a new object per call
   * would rebuild the agent on every turn. It is the same rule the model and the
   * MCP connections follow: stable things are handed in, changing things are
   * notified.
   */
  recallService?: RecallLookup;
}

/**
 * The engine the app carries, as the runtime needs it.
 *
 * Two methods, and deliberately not the supervisor's `status`: this package
 * starts an engine and stops one, and the card that *describes* it belongs to
 * the window that draws the card. An interface here rather than the class,
 * because the two processes answer it differently — the window keeps an engine
 * warm, the runner starts one for the length of a job — and neither answer
 * belongs in this file. It also means no test of this package loads a gigabyte
 * of weights.
 */
export interface LocalModelRunner {
  ensureRunning(): Promise<
    {ok: true; baseUrl: string} | {ok: false; problem: string}
  >;
  stop(): Promise<void>;
}

export interface AgentRuntimeOptions {
  paths: AppPaths;
  /** Present in the window, absent in the runner, which has no browser. */
  webSearch?: WebSearchProvider;
  /**
   * The rest of the app's tools, resolved per profile and folder.
   *
   * The folder is passed because recall's index lives inside it — a service
   * derived from one folder is the wrong service for another, and asking the app
   * to remember what the runtime last asked for would be a second copy of a fact
   * this function already has.
   *
   * May be asynchronous: the supplier reads a setting to decide whether recall
   * exists at all, and a callback that had to be synchronous would push that read
   * into whoever assembled the store.
   */
  services?: (
    profileId: string,
    workspaceRoot?: string,
  ) => RuntimeServices | Promise<RuntimeServices>;
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
  /**
   * The engine the app carries.
   *
   * Absent in a caller that cannot have one — a test, or a command that only
   * reads stored conversations — and in that case a turn is refused with a
   * sentence rather than half-answered.
   */
  localModel?: LocalModelRunner;
  /**
   * The recall engine, so the app can stop it on the way out.
   *
   * Only `stop`: whether it is running, and what it is doing, is the window's
   * business — this package starts nothing and describes nothing, and a runtime
   * that carried a status type would be a second place that could disagree about
   * which engine is up.
   */
  recall?: {stop: () => Promise<void>};
}

/** Either a host ready for a turn, or the sentence explaining why not. */
export type HostResult =
  | {ok: true; host: AgentHost; profile: AgentProfile}
  | {ok: false; problem: string};

export class AgentRuntime {
  private readonly settingsStore: SettingsStore;
  private readonly profileStore: ProfileStore;
  /**
   * The folders every agent works in.
   *
   * Built from the profiles store's legacy fields when the document does not
   * exist yet: a `profiles.json` written before folders were install-wide holds
   * the only copy, and it is handed over here so the two stores never disagree
   * about which folders exist.
   */
  private readonly workspaceStore: WorkspaceStore;
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
      // A brand-new profile starts with the app's identity and no capabilities:
      // every one of those is something the user turns on, which is the whole
      // shape of this app. The empty lists are the point, not an oversight.
      //
      // The identity is seeded rather than left blank because an agent with no
      // persona at all is not "unconfigured" — it is one whose replies have no
      // stated idea of who they are for, and the user has no text to edit back
      // to. It stays editable, and Settings resets it to this same constant.
      defaultIdentity: DEFAULT_AGENT_IDENTITY,
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
      /*
       * And no *user* skills, which is all this list can name.
       *
       * The app's own prompt is not gated here: the operating protocol is
       * unconditional and the memory and knowledge skills follow the tools just
       * granted, so a fresh agent carries the app's rules without anyone having
       * to switch them on. This empty list means "no `/learn` skills of mine",
       * which is the only thing a profile's `enabledSkills` decides.
       */
      defaultSkills: [],
    });
    this.workspaceStore = new WorkspaceStore({
      file: options.paths.workspaces,
      defaultWorkspaceRoot: options.paths.defaultWorkspace,
      /*
       * The folders a pre-workspaces profiles file holds, read through the
       * profile store rather than by parsing that file a second time: it is the
       * same document, and two parsers for it is two chances to disagree.
       */
      adoptLegacy: async () => {
        const legacy = await this.profileStore.legacyWorkspaces();
        if (legacy === undefined) {
          return undefined;
        }
        const workspaces = legacy.flatMap((entry) => entry.workspaces);
        const active =
          legacy.find((entry) => entry.activeWorkspaceId !== null)
            ?.activeWorkspaceId ?? null;
        return {workspaces, activeWorkspaceId: active};
      },
      // Only after the document holding them exists, so a crash in between
      // leaves the folders where they were.
      onAdopted: async () => {
        await this.profileStore.clearLegacy();
      },
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
   * Not per profile: the tools are the install's, the folder they are described
   * against is the current one, and which of them an agent may use is a grant on
   * the profile rather than a difference in the catalogue. It used to take a
   * profile id, back when each profile named its own folder.
   *
   * The tools are described by *constructing* them, which is the only way the
   * wording is guaranteed to be the wording the model is given — and the only
   * way a renamed tool cannot go on being offered under its old name, which
   * would grant nothing when ticked.
   */
  async catalog(): Promise<ProfileCatalog> {
    const workspaceRoot =
      workspaceRootFor(await this.workspaceStore.load()) ??
      this.options.paths.defaultWorkspace;
    const settings = await this.settingsStore.load();

    const tools = describeTools({
      workspaceRoot,
      model: LOCAL_MODEL_ID,
      ...(this.options.webSearch ? {webSearch: this.options.webSearch} : {}),
      /*
       * The switch for recall exists exactly when recall does, which is the rule
       * the comment below is about: a tool the host builds but the catalogue omits
       * can never be granted, and one the catalogue lists but the host cannot
       * build grants nothing when it is ticked.
       */
      ...(settings.recall.enabled ? {recall: true} : {}),
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
    });

    return {
      tools,
      skills: await this.skillCatalog(),
      /*
       * The same tools in three sizes, narrowed to the ones this install has.
       * The narrowing happens here rather than in the window so that whichever
       * screen offers a preset can write the list it was handed, and a name no
       * tool answers to never reaches a profile.
       */
      presets: capabilityPresets(tools.map((tool) => tool.name)),
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
   * Hosts are dropped when the change is one an agent was built around — how
   * literal its wording is, whether it may fetch from the private network — so
   * the next turn is built from what the settings now say rather than from what
   * they said when the host was made.
   *
   * The model used to be in that list, and it cannot be any more: there is one
   * model, so nothing a settings write can do changes what a host is built with.
   */
  async updateSettings(patch: SettingsPatch): Promise<StoredSettings> {
    const before = await this.settingsStore.load();
    const after = await this.settingsStore.patch(patch);

    const rebuild =
      before.temperature !== after.temperature ||
      before.maxOutputTokens !== after.maxOutputTokens ||
      before.allowPrivateNetworkFetch !== after.allowPrivateNetworkFetch;

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
    const profile = await this.profileFor(profileId);
    if (profile === undefined) {
      return [];
    }
    /*
     * The same host a turn would get: the review reads the memory of the folder
     * this conversation works in, so what it proposes belongs to the project the
     * conversation is about.
     */
    const resolved = await this.host(profileId, sessionId);
    if (!resolved.ok) {
      return [];
    }
    const host = resolved.host;

    const events = await host.eventsFor(sessionId);
    const reviewed = events.filter((event) => event.partial !== true).length;
    const from = await this.proposals.reviewedUpTo(sessionId);
    if (reviewed <= from) {
      // Nothing new since last time. Not asking is the common case and the
      // reason the watermark exists.
      return [];
    }

    const memory = await host.memoryText();
    /*
     * What this agent has already been told no about. Read from the same document
     * the proposals live in, so a refusal and the queue it came from cannot
     * disagree — and scoped to the profile, because a fact refused in one agent's
     * conversation is not a refusal by the person in another's.
     */
    const refused = (await this.proposals.load()).dismissed
      .filter((entry) => entry.profileId === profileId)
      .map((entry) => ({text: entry.text}));
    const found = await runReview({
      // Only what has not been read before.
      events: events.slice(from),
      memory,
      refused,
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
        reviewEvents: settings.memoryReviewEvents,
      };
    }

    const profile = await this.profileFor(id);
    /*
     * The current folder, not the open conversation's: this answers a question
     * about the *agent* — how full its memory is — and Settings has no idea
     * which chat the window happens to be showing.
     */
    const workspace =
      workspaceRootFor(await this.workspaceStore.load()) ??
      this.options.paths.defaultWorkspace;
    const store = new MemoryStore({
      workspaceRoot: workspace,
      softLimitBytes: settings.memorySoftLimitBytes,
      ...(profile !== undefined ? {profileId: profile.id} : {}),
    });
    return {
      bytes: await store.bytes(),
      limitBytes: store.softLimitBytes,
      capBytes: MAX_MEMORY_BYTES,
      reviewEvents: settings.memoryReviewEvents,
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
      /*
       * Built for the conversation that proposed it rather than for whichever
       * one is current: the fact was learned in a project, and that is the
       * folder whose memory has to hold it.
       */
      const result = await this.host(
        proposal.profileId,
        proposal.sessionId ?? undefined,
      );
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

    /*
     * A refusal is recorded with the agent it was refused in. The fact may be
     * exactly what this same agent is told later — the user can refuse a
     * *suggestion* and then say the thing themselves — and that is fine: the
     * refusal only silences the reviewer, never `update_memory`.
     */
    await this.proposals.remove(
      proposalId,
      accept ? undefined : {profileId: proposal.profileId, text: proposal.text},
    );
    return {ok: true};
  }

  /**
   * What the user has refused, newest last.
   *
   * Read for the memory panel rather than for the reviewer, so it answers with
   * the whole list and lets the caller group it: the dialog shows how many
   * judgements are being carried, and that is a number about the app's behaviour
   * rather than about one agent.
   */
  async dismissedMemory(): Promise<DismissedMemory[]> {
    return (await this.proposals.load()).dismissed;
  }

  /** Forgets every refusal, so the reviewer may propose them again. */
  async forgetDismissedMemory(): Promise<DismissedMemory[]> {
    return (await this.proposals.clearDismissed()).dismissed;
  }

  /**
   * How far the memory review has read a conversation.
   *
   * Asked so the idle timer can choose between waiting for the conversation to
   * end and reading it back in stretches. Deliberately built on `ensureHost`
   * rather than `host`: this runs at the end of every turn, and `host` starts the
   * model engine — which is seconds of work to answer a question about a counter.
   *
   * `total` counts the events the review counts — the settled ones — because a
   * partial event is not something anything should be reading, and the two
   * numbers have to be in the same units as the threshold they are compared
   * against.
   */
  async reviewProgress(
    profileId: string,
    sessionId: string,
  ): Promise<{reviewed: number; total: number}> {
    const host = await this.ensureHost(profileId);
    const events = await host.eventsFor(sessionId);
    const total = events.filter((event) => event.partial !== true).length;
    const reviewed = await this.proposals.reviewedUpTo(sessionId);
    return {reviewed, total};
  }

  /**
   * How long the idle timer should wait before reading this conversation back.
   *
   * Here rather than in the window because the threshold is a setting and this is
   * the layer that already reads settings — the app that arms the timer asks one
   * question and gets a number, and never learns that there were two rules behind
   * it. The two delays are passed in because they are the *caller's* judgement:
   * ten seconds rather than a minute is about what else is running on the machine,
   * which is the app's business rather than the agent's.
   */
  async reviewDelayFor(
    profileId: string,
    sessionId: string,
    delays: {idleMs: number; shortlyMs: number},
  ): Promise<number> {
    const settings = await this.settingsStore.load();
    const progress = await this.reviewProgress(profileId, sessionId);
    return reviewDelay({
      total: progress.total,
      reviewed: progress.reviewed,
      threshold: settings.memoryReviewEvents,
    }) === 'shortly'
      ? delays.shortlyMs
      : delays.idleMs;
  }

  async profiles(): Promise<AgentProfile[]> {
    return await this.profileStore.profiles();
  }

  async activeProfile(): Promise<AgentProfile> {
    return await this.profileStore.activeProfile();
  }

  /**
   * The folders this install works in, for the rail.
   *
   * Every call that changes one answers with the whole list, so a window never
   * has to merge a single entry into a copy of its own — the order and the
   * current folder are decided in one place.
   */
  async workspaces(): Promise<WorkspaceState> {
    const file = await this.workspaceStore.load();
    return {
      workspaces: file.workspaces,
      activeWorkspaceId: file.activeWorkspaceId,
    };
  }

  /** Loads a folder and makes it current. */
  async addWorkspace(path: string, name?: string): Promise<WorkspaceState> {
    await this.workspaceStore.add(path, name);
    return await this.workspaces();
  }

  /** Makes a folder the one a new conversation is filed under. */
  async selectWorkspace(workspaceId: string): Promise<WorkspaceState> {
    await this.workspaceStore.select(workspaceId);
    return await this.workspaces();
  }

  async renameWorkspace(
    workspaceId: string,
    name: string,
  ): Promise<WorkspaceState> {
    await this.workspaceStore.rename(workspaceId, name);
    return await this.workspaces();
  }

  /**
   * Forgets a folder.
   *
   * Documents are *not* dropped for it: a host holds the session service and the
   * conversation state, and disposing one would kill a turn that is running in
   * entirely another folder. Nothing about a folder removal changes where an
   * in-flight turn is writing; the next turn resolves its own folder anyway.
   */
  async removeWorkspace(workspaceId: string): Promise<WorkspaceState> {
    await this.workspaceStore.remove(workspaceId);
    return await this.workspaces();
  }

  /** One folder by id, for the caller that opens it in the file manager. */
  async workspaceById(workspaceId: string): Promise<Workspace | undefined> {
    return await this.workspaceStore.byId(workspaceId);
  }

  /**
   * The folder a conversation works in — where its file tools are confined.
   *
   * The same two facts a turn resolves through: the folder the conversation was
   * filed under, falling back to the current one. Attaching a file is judged
   * against *this*, because the point of attaching it is that the agent can read
   * it, and a file outside the root the turn runs in is one that `read_file`
   * would refuse — after the user had already watched it appear in the message.
   *
   * Worth the method rather than a second derivation in the window: the two
   * answers have to be the same one, and they differ the moment browsing the
   * rail selects another folder.
   */
  async conversationFolder(
    profileId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const host = await this.ensureHost(profileId);
    const filed = await host.sessionWorkspaceId(sessionId);
    return workspaceRootFor(await this.workspaceStore.load(), filed);
  }

  /**
   * Re-files a conversation, or unfiles it with `null`.
   *
   * The placeholder-config host, for the same reason `transcript` uses one:
   * filing a conversation has nothing to do with a model, and a missing key must
   * not be able to stop it.
   */
  async setSessionWorkspace(
    profileId: string,
    sessionId: string,
    workspaceId: string | null,
  ): Promise<SessionSummary> {
    const host = await this.ensureHost(profileId);
    return await host.setSessionWorkspace(
      sessionId,
      workspaceId ?? undefined,
      profileId,
    );
  }

  async renameSession(
    profileId: string,
    sessionId: string,
    title: string,
  ): Promise<SessionSummary> {
    const host = await this.ensureHost(profileId);
    return await host.renameSession(sessionId, title, profileId);
  }

  /**
   * Replaces the older part of a conversation with a summary.
   *
   * Resolved through `host()` rather than `ensureHost()`, which is the opposite
   * of what the calls above do and deliberately so: those write metadata a
   * conversation can be filed or named without a model. This one *asks the
   * model*, so it needs the real configuration, and an engine that is not up has
   * to come back as the sentence the window already knows how to draw rather
   * than as a request to an empty endpoint.
   */
  async compact(profileId: string, sessionId: string): Promise<CompactResult> {
    const resolved = await this.host(profileId, sessionId);
    if (!resolved.ok) {
      throw new Error(resolved.problem);
    }
    return await resolved.host.compact(sessionId, profileId);
  }

  /** Deletes a conversation, aborting a run in it if there is one. */
  async deleteSession(profileId: string, sessionId: string): Promise<void> {
    const host = await this.ensureHost(profileId);
    await host.deleteSession(sessionId, profileId);
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
   * file, and the window needs somewhere to put the refusal when the engine is
   * not up — gating this on a resolvable config would mean a fresh install could
   * not open the chat it is supposed to explain itself in.
   *
   * The profile and the *current* folder are stamped on at creation, which is
   * what files the conversation under the right agent and the right group in the
   * rail. It is recorded once rather than followed: a conversation that keeps
   * running after another folder is selected is what lets the rail be browsed
   * while an answer streams.
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
      profileId,
      (await this.workspaceStore.activeWorkspaceId()) ?? undefined,
    );
  }

  /**
   * Reads a conversation, which needs no model at all.
   *
   * Deliberately not `host()`. That resolves the model configuration and refuses
   * without a running engine — correctly, for a turn — but reading a stored
   * conversation has nothing to do with a model. Going through `host()` made
   * every conversation in the app appear *empty* whenever the engine could not be
   * started: the messages were on disk and the window showed nothing, which is
   * indistinguishable from having lost them.
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

  /**
   * One conversation's stored events and title, for the recall indexer.
   *
   * Raw events rather than the projected transcript, because the indexer renders
   * its own text from them — reasoning and tool payloads left out — and the
   * projection is shaped for drawing. Deliberately not `host()`: indexing a chat
   * has nothing to do with a model, and a conversation whose engine is not up
   * must still be findable by meaning.
   */
  async conversationFor(
    profileId: string,
    sessionId: string,
  ): Promise<{title: string; events: AdkEvent[]}> {
    const host = await this.ensureHost(profileId);
    const events = await host.eventsFor(sessionId);
    const summary = (await host.listSessions(profileId)).find(
      (entry) => entry.id === sessionId,
    );
    return {title: summary?.title ?? '', events};
  }

  /**
   * The host for a profile, working in the folder a conversation is filed under,
   * and brought up to date with the settings on disk.
   *
   * The session id is optional because not every caller has a conversation: the
   * catalogue and the memory readout are about the agent, and answer against the
   * current folder. A turn always has one, and that is what decides where its
   * file tools are confined — the conversation remembers its own folder, so
   * browsing the rail cannot move a turn that is already running.
   *
   * Bringing it up to date on the way in — rather than requiring a caller to
   * remember to — is what makes "a capability the user turned off is absent"
   * true on the *next* turn rather than after a restart.
   */
  async host(profileId: string, sessionId?: string): Promise<HostResult> {
    const settings = await this.settingsStore.load();
    const profile = await this.profileFor(profileId);
    if (!profile) {
      return {ok: false, problem: `There is no agent called "${profileId}".`};
    }

    /*
     * The engine, before the configuration that points at it.
     *
     * Deliberately first: starting it takes seconds, and a resolution that
     * happened before it was up would produce a configuration with no address
     * and a refusal the user cannot act on. Starting it *here* rather than in a
     * caller is what makes the two processes the same code — the window and the
     * headless runner both arrive at `host`, and neither has to know that the
     * model is a process.
     */
    const engine = await this.startEngine();
    if (!engine.ok) {
      return engine;
    }

    /*
     * The host next, because it is what reads the conversation index — and a
     * placeholder-config host is exactly what `transcript` and `approve`
     * already build. Resolving the configuration first would mean reading the
     * folder before knowing which conversation is asking.
     */
    const host = await this.ensureHost(profileId);
    const filed =
      sessionId === undefined
        ? undefined
        : await host.sessionWorkspaceId(sessionId);
    const workspaceRoot = workspaceRootFor(
      await this.workspaceStore.load(),
      filed,
    );

    const resolved = await resolveAgentConfig({
      settings,
      profile,
      skills: await this.skillsFor(profile),
      ...(workspaceRoot === undefined ? {} : {workspaceRoot}),
      ...(engine.baseUrl === undefined ? {} : {engineBaseUrl: engine.baseUrl}),
    });
    if (!resolved.ok) {
      return resolved;
    }

    host.updateConfig(resolved.config);
    this.applyMcpServers(host, profileId);
    /*
     * Recall is handed over here rather than in `ensureHost`, because whether it
     * is on is a *setting* and this is the one place that has read it. A setting
     * the user turned off leaves the host with nothing, which is how a capability
     * switched off becomes absent rather than discouraged — and the tool list the
     * model is offered is rebuilt from that on the next turn.
     */
    host.setRecallService(
      settings.recall.enabled
        ? (await this.options.services?.(profileId, workspaceRoot))
            ?.recallService
        : undefined,
    );

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
    const result = await this.host(profileId, sessionId);
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

  /**
   * Lets go of everything, including the engine if this process started one.
   *
   * Asynchronous because stopping a process is, and awaited by both callers on
   * their way out: the app before it quits, and the runner before it exits. A
   * child still loading weights when its parent disappears is a gigabyte of
   * memory and a spinning fan with no window left to explain it — which is
   * exactly the failure the pid file is the second line of defence against.
   */
  async dispose(): Promise<void> {
    for (const host of this.hosts.values()) {
      host.dispose();
    }
    this.hosts.clear();
    this.applied.clear();
    await this.options.localModel?.stop();
    // Its own engine, and gigabytes of nobody's business if it is left behind —
    // 400 MB of weights and a fan with no window to explain them.
    await this.options.recall?.stop();
  }

  /**
   * Starts the app's own engine.
   *
   * Answers with the live address, or with the sentence explaining why not —
   * a fact about the install, discovered before the turn starts rather than
   * halfway through it.
   */
  private async startEngine(): Promise<
    {ok: true; baseUrl?: string} | {ok: false; problem: string}
  > {
    const runner = this.options.localModel;
    if (runner === undefined) {
      /*
       * A caller with no engine — a test, or a command that only reads stored
       * conversations. Said plainly rather than resolved against some assumed
       * address, which would send a conversation to whatever happens to be
       * listening on that port.
       */
      return {
        ok: false,
        problem:
          'The built-in model runs inside the app, and this process has no ' +
          'engine to start it with.',
      };
    }

    const started = await runner.ensureRunning();
    return started.ok
      ? {ok: true, baseUrl: started.baseUrl}
      : {ok: false, problem: started.problem};
  }

  private async profileFor(
    profileId: string,
  ): Promise<AgentProfile | undefined> {
    return (await this.profileStore.profiles()).find(
      (profile) => profile.id === profileId,
    );
  }

  /**
   * The user's skills a profile carries, in the shape the prompt wants.
   *
   * Filtered by `enabledSkills` rather than passing everything: a skill is
   * prompt text carried on every single request, so one the user switched off is
   * a cost they have already declined to pay. The built-in skills are not here
   * at all — `composeInstruction` picks those up from the profile's tools.
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

    /*
     * Awaited, and the folder is deliberately not passed: this is the host a
     * caller builds before it knows which conversation is asking — reading a
     * transcript, filing a session — and recall's tools are chosen when a turn
     * runs, where `host()` has both.
     */
    const services = (await this.options.services?.(profileId)) ?? {};
    const host = new AgentHost({
      sessionsDir: this.options.paths.sessions,
      // A placeholder config: `host()` resolves the real one and calls
      // `updateConfig` before any turn runs. Constructing with the settings
      // shape here would mean reading them twice and risking the two reads
      // disagreeing.
      config: {
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
      /*
       * The deletion sync, resolved lazily because the folder to purge from is
       * the one the *service* would have indexed into — and a service is built
       * from a setting this callback must read at the moment a chat is deleted,
       * not at the moment the host was made. The active folder is the honest
       * guess: another folder's index is settled by its own next refresh, which
       * drops any session that is no longer in the list.
       */
      onSessionsDeleted: async (sessionIds) => {
        const root = workspaceRootFor(await this.workspaceStore.load());
        const recall = (await this.options.services?.(profileId, root))
          ?.recallService;
        /*
         * Best effort, and deliberately swallowed. The conversation is already
         * deleted by the time this runs, and an index that cannot be rewritten —
         * a read-only folder, a full disk — must not turn a deletion that
         * happened into an error the window reports. The stale vectors are
         * dropped by that index's next refresh anyway, which is the backstop the
         * pruning in `refreshIndex` exists to be.
         */
        try {
          await recall?.forgetSessions?.(sessionIds);
        } catch (failure) {
          console.log(
            '[marimo] the deleted conversation could not be dropped from the recall index:',
            failure,
          );
        }
      },
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
