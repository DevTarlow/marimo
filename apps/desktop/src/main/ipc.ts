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

import {agentCallSchemas, IPC_CALL_CHANNEL} from '@marimo/protocol';
import type {
  AgentCallMethod,
  AgentCallParams,
  AgentCallResults,
  AppInfo,
  ThemeMode,
} from '@marimo/protocol';
import type {AppPaths} from '@marimo/runtime';

import type {AgentService} from './agent.js';
import {safeStorageCipher} from './secrets.js';

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

    'profiles.list': async () => await agent().profiles(),

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
