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
import {stat} from 'node:fs/promises';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from 'electron';
import type {OpenDialogOptions} from 'electron';

import {agentCallSchemas, IPC_CALL_CHANNEL} from '@marimo/protocol';
import type {
  AgentCallMethod,
  AgentCallParams,
  AgentCallResults,
  AppInfo,
  PublicSettings,
  ThemeMode,
} from '@marimo/protocol';
import type {AppPaths} from '@marimo/runtime';

import {attachableFiles} from './attach.js';
import type {AgentService} from './agent.js';
import {safeStorageCipher} from './secrets.js';
import type {Companion} from './companion.js';
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
  /** Told after a settings write, so anything holding a copy can re-read. */
  onSettingsChanged?: () => void;
  /**
   * The floating companion, when one has been created.
   *
   * A getter rather than the window itself, because the tray and the window can
   * each turn it off and on, and a caller holding a destroyed window would be
   * holding the wrong one.
   */
  companion?: () => Companion | undefined;
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
   * No credential is here and none can be: the app holds no model key, and the
   * only secrets it keeps are connector tokens, which never cross this boundary.
   */
  async function publicSettings(): Promise<PublicSettings> {
    const service = dependencies.agent();
    if (service === undefined) {
      throw new Error('The agent is not running.');
    }
    const settings = await service.settings();
    const profiles = await service.profiles();
    const readiness = await modelReadiness(service);

    return {
      ...settings,
      modelReady: readiness.ok,
      ...(readiness.problem === undefined
        ? {}
        : {modelProblem: readiness.problem}),
      profiles: profiles.profiles,
      activeProfileId: profiles.activeProfileId,
    };
  }

  /**
   * Whether this install could answer a question right now.
   *
   * A fact only this process has: the model needs no key and no address, so what
   * decides it is whether the weights and the engine are where the app looks and
   * whether an engine started. A window that guessed would open a chat on a
   * machine that cannot reply.
   *
   * The engine is *not* started to answer this: the question is asked every time
   * the settings are read, and loading a gigabyte of weights to report on them
   * would be a spinner on every turn.
   */
  async function modelReadiness(
    service: AgentService,
  ): Promise<{ok: boolean; problem?: string}> {
    const status = await service.model.status();
    if (status.state === 'failed') {
      return {ok: false, problem: status.detail ?? 'The model did not start.'};
    }
    if (!status.modelPresent) {
      return {
        ok: false,
        problem: `The model file is not where the app looks for it: ${status.modelPath}`,
      };
    }
    if (!status.enginePresent) {
      return {
        ok: false,
        problem: `The model engine is not where the app looks for it: ${status.enginePath}`,
      };
    }
    return {ok: true};
  }

  /** Both halves of what the window needs after an agent changes. */
  async function profileState(service: AgentService) {
    const {profiles, activeProfileId} = await service.profiles();
    return {profiles, activeProfileId};
  }

  /**
   * Asks the user for a folder, with the OS's own picker.
   *
   * `undefined` means they closed it. The parented form is used when there is a
   * window to parent to, because a modal dialog attached to nothing can end up
   * behind the window it was opened from.
   */
  async function pickFolder(): Promise<string | undefined> {
    const options: OpenDialogOptions = {
      title: 'Choose a folder to work in',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory'],
      defaultPath: await startFolder(),
    };
    const parent = BrowserWindow.getFocusedWindow();
    const result =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    return result.canceled ? undefined : result.filePaths[0];
  }

  /**
   * Where the picker opens: the folder already in use, else the OS default.
   *
   * The folder in use rather than the home directory, because the common case is
   * adding a second project beside the first.
   */
  async function startFolder(): Promise<string> {
    const service = dependencies.agent();
    if (service !== undefined) {
      const {workspaces, activeWorkspaceId} = await service.workspaces();
      const active = workspaces.find((entry) => entry.id === activeWorkspaceId);
      if (active !== undefined) {
        return active.path;
      }
    }
    return dependencies.paths.defaultWorkspace;
  }

  /** A folder the window named directly has to exist and be a directory. */
  async function requireDirectory(path: string): Promise<void> {
    const stats = await stat(path).catch(() => undefined);
    if (stats === undefined || !stats.isDirectory()) {
      throw new Error(`Not a folder: ${path}`);
    }
  }

  /**
   * Asks for files, in the folder this conversation works in.
   *
   * The dialog opens there, and the chosen paths are then judged by
   * `attachableFiles` — a native picker cannot be confined to a folder, so the
   * offer is the dialog and the decision is the function beside this one. An
   * empty list means the user closed the dialog, which is an answer rather than
   * a failure.
   */
  async function pickFiles(root: string): Promise<string[]> {
    const options: OpenDialogOptions = {
      title: 'Attach files',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections'],
      defaultPath: root,
    };
    const parent = BrowserWindow.getFocusedWindow();
    const result =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    return result.canceled ? [] : result.filePaths;
  }

  const handlers: Handlers = {
    'files.pick': async (params) => {
      const service = agent();
      const folder = await service.conversationFolder(
        params.profileId,
        params.sessionId,
      );
      if (folder === undefined) {
        throw new Error(
          'This conversation has no folder yet. Load one, then attach files ' +
            'from it.',
        );
      }
      const picked = await pickFiles(folder);
      return {...(await attachableFiles(folder, picked)), folder};
    },

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
      dependencies.onSettingsChanged?.();
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

    'memory.proposals': async () => ({
      proposals: await agent().memoryProposals(),
    }),

    'memory.usage': async (params) =>
      await agent().memoryUsage(params.profileId),

    'memory.resolve': async (params) =>
      await agent().resolveMemoryProposal(params.proposalId, params.accept),

    'mcp.setSecret': async (params) => {
      await agent().setMcpSecret(
        params.serverId,
        params.target,
        params.name,
        params.value,
      );
      const settings = await agent().settings();
      const server = settings.mcpServers.find(
        (entry) => entry.id === params.serverId,
      );
      return {
        set: server === undefined ? [] : await agent().mcpSecretState(server),
      };
    },

    'companion.status': () => ({
      visible: dependencies.companion?.()?.isVisible() ?? false,
    }),

    'companion.setVisible': async (params) => {
      const window = dependencies.companion?.();
      if (window === undefined) {
        return {visible: false};
      }
      if (params.visible) {
        await window.show();
      } else {
        window.hide();
      }
      return {visible: window.isVisible()};
    },

    'companion.pointer': (params) => {
      /*
       * `enabled` is ANDed here rather than trusted to have been applied by the
       * renderer: this runs on every mouse move, and a window that stopped
       * forwarding the setting would make the whole surface dead to the mouse —
       * an unclickable pet with nothing on screen to explain why.
       */
      dependencies
        .companion?.()
        ?.setClickThrough(params.enabled && !params.over);
      return {ok: true};
    },

    'service.status': async () =>
      dependencies.service === undefined
        ? {installed: false, definitionPath: ''}
        : await statusOf(dependencies.service),

    'service.enable': async () =>
      dependencies.service === undefined
        ? {installed: false, notes: [], failures: []}
        : await enable(dependencies.service),

    'service.disable': async () =>
      dependencies.service === undefined
        ? {installed: false, notes: [], failures: []}
        : await disable(dependencies.service),

    /*
     * The model the app runs itself.
     *
     * A read and two buttons, rather than a settings patch that starts
     * something: a write that quietly spawned an engine would report success for
     * work it had not done. The status is asked for every time the card is
     * drawn, so a failure that has since been fixed stops being reported.
     */
    'localModel.status': async () => await agent().model.status(),

    /*
     * Started and stopped explicitly, which is what the buttons are for. Neither
     * is awaited into a timeout: a start loads a gigabyte of weights, and the
     * card shows what the supervisor is doing while it does — `starting` is one
     * of its states for exactly this reason.
     */
    'localModel.start': async () => {
      await agent().model.ensureRunning();
      return await agent().model.status();
    },

    'localModel.stop': async () => {
      await agent().model.stop();
      return await agent().model.status();
    },

    'profiles.list': async () => await agent().profiles(),

    'profiles.catalog': async () => await agent().catalog(),

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

    /* The folders every agent works in. */
    'workspaces.list': async () => await agent().workspaces(),

    /*
     * Loads a folder. With no path the picker is the only thing that can answer,
     * and a cancelled picker is not a failure: it answers the unchanged list and
     * says so, so the window does not draw an error for a closed dialog.
     */
    'workspaces.add': async (params) => {
      const path = params.path ?? (await pickFolder());
      if (path === undefined) {
        return {...(await agent().workspaces()), added: false};
      }
      await requireDirectory(path);
      return {...(await agent().addWorkspace(path)), added: true};
    },

    'workspaces.select': async (params) =>
      await agent().selectWorkspace(params.workspaceId),

    'workspaces.rename': async (params) =>
      await agent().renameWorkspace(params.workspaceId, params.name),

    'workspaces.remove': async (params) => ({
      ...(await agent().removeWorkspace(params.workspaceId)),
      removed: true,
    }),

    /*
     * Opens the folder in whatever the OS uses for directories.
     *
     * Looked up by id here rather than taken from the window: the only paths this
     * can open are the ones already in the document, so a renderer cannot use it
     * to reveal an arbitrary corner of the disk.
     */
    'workspaces.open': async (params) => {
      const workspace = await agent().workspace(params.workspaceId);
      return {opened: (await shell.openPath(workspace.path)) === ''};
    },

    'sessions.list': async (params) => ({
      sessions: await agent().listSessions(params.profileId),
    }),

    'sessions.create': async (params) => ({
      session: await agent().createSession(params.profileId),
    }),

    'sessions.get': async (params) =>
      await agent().transcript(params.profileId, params.sessionId),

    'sessions.move': async (params) => ({
      session: await agent().moveSession(
        params.profileId,
        params.sessionId,
        params.workspaceId,
      ),
    }),

    'sessions.rename': async (params) => ({
      session: await agent().renameSession(
        params.profileId,
        params.sessionId,
        params.title,
      ),
    }),

    'sessions.compact': async (params) =>
      await agent().compact(params.profileId, params.sessionId),

    'sessions.delete': async (params) => {
      await agent().deleteSession(params.profileId, params.sessionId);
      return {deleted: true};
    },

    'chat.send': async (params) =>
      await agent().send(
        params.profileId,
        params.sessionId,
        params.text,
        params.origin,
      ),

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
      if (
        typeof method !== 'string' ||
        !Object.hasOwn(agentCallSchemas, method)
      ) {
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
