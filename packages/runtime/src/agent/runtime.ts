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
import {AgentHost} from '@marimo/agent';
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
import type {
  AgentProfile,
  AgentUiEvent,
  ProviderId,
  SessionSummary,
  StoredSkill,
} from '@marimo/protocol';

import type {AppPaths} from '../paths.js';
import {ProfileStore} from '../profiles.js';
import type {SecretRead} from '../secrets.js';
import {SettingsStore} from '../settings.js';
import {SkillStore} from '../skills.js';
import {resolveAgentConfig} from './resolve.js';

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
      defaultTools: [],
      defaultSkills: [],
    });
    this.skillStore = new SkillStore({file: options.paths.skills});
  }

  /** The settings as they are on disk right now. */
  async settings() {
    return await this.settingsStore.load();
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
   */
  async *run(
    profileId: string,
    sessionId: string,
    text: string,
  ): AsyncGenerator<AgentUiEvent> {
    const result = await this.host(profileId);
    if (!result.ok) {
      yield refusal(sessionId, result.problem);
      return;
    }
    yield* result.host.run(sessionId, text, profileId);
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
