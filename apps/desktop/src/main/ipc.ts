/**
 * The single IPC entry point.
 *
 * The window can invoke exactly one channel, and every call is checked against
 * the protocol's schema before it reaches a handler. An unknown method or a
 * malformed payload is refused at the boundary, so a renderer bug — or a
 * renderer running something it should not be — cannot reach the agent with
 * half-typed arguments.
 *
 * Errors are thrown rather than returned, because Electron already propagates a
 * rejected `invoke` to the caller: an envelope would be a second error channel
 * to keep in step with the first. The one exception is a turn's *own* refusal,
 * which is not an error in this sense — see `AgentService.send`.
 */
import {app, ipcMain, nativeTheme} from 'electron';

import {
  agentCallSchemas,
  IPC_CALL_CHANNEL,
  PROVIDERS,
  providerIdSchema,
} from '@marimo/protocol';
import type {
  AgentCallMethod,
  AgentCallParams,
  AgentCallResults,
  AppInfo,
  ProviderId,
  PublicSettings,
  ThemeMode,
} from '@marimo/protocol';
import {defaultAvailableModels} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import type {AgentService} from './agent.js';
import {providerSecretStore, safeStorageCipher} from './secrets.js';
import {disable, enable, statusOf} from './service.js';
import type {ServiceContext} from './service.js';

export interface IpcDependencies {
  paths: AppPaths;
  /** The agent, once it has started. Absent if it failed to. */
  agent: () => AgentService | undefined;
  /**
   * The theme the user chose.
   *
   * Injected rather than read from a settings file here, so this module has no
   * opinion about where preferences live. Until Settings exists it answers
   * `system`, which is the default the app ships with anyway.
   */
  themeMode?: () => ThemeMode;
  /**
   * A problem worth showing the user, decided once at startup.
   *
   * Passed in rather than worked out here because it is a fact about the paths
   * this process resolved, and this module's job is answering calls — not
   * deciding what is wrong with the install.
   */
  warning?: string;
  /**
   * Running jobs while the app is closed.
   *
   * Injected rather than built here: it names the app's own binary and decides
   * whether the stored key is one a windowless process could read, and neither
   * is a question about answering IPC calls.
   */
  service?: ServiceContext;
}

/** Every call this app answers, with its result type pinned to the protocol. */
type Handlers = {
  [M in AgentCallMethod]: (
    params: AgentCallParams<M>,
  ) => Promise<AgentCallResults[M]> | AgentCallResults[M];
};

export function registerIpcHandler(dependencies: IpcDependencies): void {
  const themeMode = dependencies.themeMode ?? ((): ThemeMode => 'system');

  /** The agent, or a thrown sentence naming what went wrong at startup. */
  const agent = (): AgentService => {
    const service = dependencies.agent();
    if (service === undefined) {
      throw new Error(
        'The agent did not start. Check the app log, then reopen Marimo Agent.',
      );
    }
    return service;
  };

  /**
   * The settings a window may see.
   *
   * The key itself never crosses this boundary — only whether there is one, per
   * provider, and whether this machine could encrypt it. A renderer that could
   * read the key would make every XSS in the chat a key disclosure.
   */
  async function publicSettings(): Promise<PublicSettings> {
    const service = dependencies.agent();
    if (service === undefined) {
      throw new Error('The agent is not running.');
    }
    const settings = await service.settings();

    const providerKeys = {} as Record<ProviderId, boolean>;
    for (const id of providerIdSchema.options) {
      providerKeys[id] = await providerSecretStore(
        dependencies.paths,
        id,
        `${PROVIDERS[id].label} API key`,
      ).has();
    }

    const profiles = await service.profiles();
    return {
      ...settings,
      hasApiKey:
        !PROVIDERS[settings.providers.active].requiresApiKey ||
        providerKeys[settings.providers.active],
      providerKeys,
      encryptionAvailable: safeStorageCipher.available(),
      availableModels: defaultAvailableModels()[settings.providers.active],
      profiles: profiles.profiles,
      activeProfileId: profiles.activeProfileId,
      // The folder an agent with none of its own would work in. Shown rather
      // than hidden: the agent is confined to *something*, and a window that
      // implied it had no file access at all would be lying in the other
      // direction.
      defaultWorkspace: dependencies.paths.defaultWorkspace,
    };
  }

  /** Both halves of what the window needs after an agent changes. */
  async function profileState(service: AgentService) {
    const {profiles, activeProfileId} = await service.profiles();
    return {profiles, activeProfileId};
  }

  const handlers: Handlers = {
    'app.info': (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions['electron'] ?? '',
      chrome: process.versions['chrome'] ?? '',
      node: process.versions['node'] ?? '',
      platform: process.platform,
      userData: dependencies.paths.userData,
      // Asked every time rather than cached: on Linux a keyring that was locked
      // at launch can become usable later in the session, and the answer decides
      // whether the window can offer to run jobs while the app is closed.
      secretsEncrypted: safeStorageCipher.available(),
      ...(dependencies.warning === undefined
        ? {}
        : {warning: dependencies.warning}),
      themeMode: themeMode(),
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    }),

    'settings.set': async (params) => {
      await agent().updateSettings(params.patch);
      return {settings: await publicSettings()};
    },

    'settings.setApiKey': async (params) => {
      const settings = await agent().settings();
      const providerId = params.provider ?? settings.providers.active;
      const store = providerSecretStore(
        dependencies.paths,
        providerId,
        `${PROVIDERS[providerId].label} API key`,
      );
      /*
       * The consent flag reaches the write here, and this is the only place it
       * can: it decides whether a process with no keychain — the headless job
       * runner — will be able to read what was just stored.
       */
      await store.set(params.apiKey, {
        allowPlaintext: settings.allowPlaintextApiKey,
      });
      return {settings: await publicSettings()};
    },

    'mcp.set': async (params) => {
      const servers = await agent().setMcpServer(params.server);
      return {servers, statuses: agent().mcpStatuses()};
    },

    'mcp.remove': async (params) => {
      const servers = await agent().removeMcpServer(params.serverId);
      return {servers, statuses: agent().mcpStatuses()};
    },

    /*
     * Dials a server that has not been saved, so somebody can find out that a
     * command is wrong before committing to it — which is the difference between
     * a typo they fix and a connector that "does not work".
     */
    'mcp.test': async (params) => await agent().testMcpServer(params.server),

    'service.status': async () =>
      dependencies.service === undefined
        ? {installed: false, keysReadable: false, definitionPath: ''}
        : await statusOf(dependencies.service),

    'service.enable': async () =>
      dependencies.service === undefined
        ? {installed: false, notes: [], failures: []}
        : await enable(dependencies.service),

    'service.disable': async () =>
      dependencies.service === undefined
        ? {installed: false, notes: [], failures: []}
        : await disable(dependencies.service),

    'profiles.list': async () => await agent().profiles(),

    'profiles.catalog': async () => (await agent().catalog()).catalog,

    'profiles.update': async (params) => {
      await agent().updateProfile(params.profileId, params.patch);
      return await profileState(agent());
    },

    'profiles.create': async (params) => {
      const agent0 = agent();
      const created = await agent0.createProfile(params.name);
      // Switched to straight away: somebody who adds an agent wants to be
      // looking at it, not at the one they were on.
      await agent0.selectProfile(created.id);
      return await profileState(agent0);
    },

    'profiles.select': async (params) => {
      const service = agent();
      await service.selectProfile(params.profileId);
      return await profileState(service);
    },

    'settings.get': async () => ({settings: await publicSettings()}),

    'sessions.list': async (params) => ({
      sessions: await agent().listSessions(params.profileId),
    }),

    'sessions.create': async (params) => ({
      session: await agent().createSession(params.profileId),
    }),

    'sessions.get': async (params) =>
      await agent().transcript(params.profileId, params.sessionId),

    'chat.send': async (params) =>
      await agent().send(params.profileId, params.sessionId, params.text),

    'chat.approve': async (params) =>
      await agent().approve(
        params.profileId,
        params.sessionId,
        params.callId,
        params.confirmed,
      ),

    'chat.abort': async (params) =>
      agent().abort(params.profileId, params.sessionId),

    'mcp.statuses': async () => agent().mcpStatuses(),
  };

  ipcMain.handle(
    IPC_CALL_CHANNEL,
    async (_event, method: unknown, params: unknown): Promise<unknown> => {
      if (typeof method !== 'string' || !Object.hasOwn(agentCallSchemas, method)) {
        throw new Error(`Unknown IPC method: ${String(method)}`);
      }

      const key = method as AgentCallMethod;
      const parsed = agentCallSchemas[key].safeParse(params ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) =>
            issue.path.length > 0
              ? `${issue.path.join('.')}: ${issue.message}`
              : issue.message,
          )
          .join('; ');
        throw new Error(`Invalid parameters for ${key}: ${detail}`);
      }

      const handler = handlers[key] as (
        params: unknown,
      ) => Promise<unknown> | unknown;
      return await handler(parsed.data);
    },
  );
}
