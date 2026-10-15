/**
 * Electron main entry.
 *
 * Responsibilities, in order: relocate app state if the environment asks for it,
 * take the single-instance lock, resolve the paths, register the one IPC
 * handler, and open the window. The window is sandboxed and has no Node access;
 * everything it can do goes through the preload bridge.
 *
 * The single-instance lock is not a convenience. The agent runs one turn at a
 * time, and that guarantee is in-process only — two copies of the app would each
 * believe they were the only one, and would take turns writing the same
 * conversation files. The lock is what makes "one instance" true, and it is why
 * relocating the user-data directory has to happen before it is taken.
 */
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  nativeImage,
  screen,
  shell,
} from 'electron';

import {IPC_EVENT_CHANNEL, defaultWindowState} from '@marimo/protocol';
import type {AgentUiEvent, ThemeMode, WindowState} from '@marimo/protocol';
import {defaultStoredSettings} from '@marimo/runtime';

import {PRODUCT_NAME} from '../shared/product.js';

import {registerIpcHandler} from './ipc.js';
import {Companion} from './companion.js';
import {noticeFor, trayMenu} from './tray.js';
import type {TrayItem} from './tray.js';
import {AgentService} from './agent.js';
import {registerMediaScheme} from './media/decode-window.js';
import {
  applyUserDataPath,
  resolvePaths,
  userDataDisagreement,
} from './paths.js';
import {
  loadWindowState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  restoreBounds,
  saveWindowState,
  windowStateOf,
} from './window-state.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env['MARIMO_DEV_SERVER_URL'];

/*
 * Before anything else, and before the app is ready: Electron keeps the
 * single-instance lock inside the user-data directory, so deciding which
 * directory that is has to happen before the lock is requested. It is decided
 * rather than derived from the app's name, because the app is Marimo and the
 * folder is still `Marimo Agent` — see `applyUserDataPath`.
 */
applyUserDataPath();

/**
 * `MARIMO_OFFSCREEN=1` renders into CPU frames instead of a compositor surface.
 *
 * For a machine with no GPU, where showing a window either fails or paints
 * nothing. It is not how the app is checked — `scripts/smoke.mjs` drives a real
 * window over the DevTools protocol, which is the only way to see what was
 * actually rendered — but it keeps a headless run from needing a display.
 */
const offscreen = process.env['MARIMO_OFFSCREEN'] === '1';

/**
 * The mascot, for the window and taskbar icon.
 *
 * The renderer gets its copy of this through Vite; the main process needs a real
 * path, resolved from `dist/main` back to the app root so it works both in
 * development and in an unpacked build. Packaging will need this PNG beside
 * generated `.ico`/`.icns` copies, so a missing file is tolerated rather than
 * fatal.
 */
const windowIcon = join(moduleDir, '..', '..', 'assets', 'marimo-logo.png');

/**
 * How long a resize or move has to settle before the new geometry is written.
 *
 * Short, because the alternative to waiting is a window that loses its last
 * adjustment: a drag fires an event per pixel, and people reach for the close
 * button a couple of hundred milliseconds after letting go of the edge.
 */
const SETTLE_MS = 200;

let mainWindow: BrowserWindow | undefined;
let agent: AgentService | undefined;

/**
 * The geometry to open with.
 *
 * A constant for now: reading and writing it belongs with the settings store,
 * which lands with the rest of the preferences. The clamping below is already
 * real, because the default is still wrong on a small display.
 */
/**
 * Where the window was left last time.
 *
 * Read once at startup and written whenever it settles. This was a constant for
 * a while — `windowStateOf` computed the geometry and the result was thrown
 * away — so the window opened in the default place on every launch while the
 * code to remember it sat beside it, tested and unused.
 */
let rememberedGeometry: WindowState = defaultWindowState();

/** Where the geometry is kept. */
function windowStatePath(): string {
  return join(resolvePaths().userData, 'window-state.json');
}

async function createWindow(): Promise<BrowserWindow> {
  /*
   * The stored geometry is the window manager's own numbers, so it can name a
   * monitor that has since been unplugged — and a window restored entirely
   * off-screen is an app that is running with nothing to click. `restoreBounds`
   * drops the position in that case and clamps the size to the widest display
   * attached now.
   */
  // Freshly read rather than taken from the constant above, which is the
  // default until the async read in `bootstrap` has happened.
  rememberedGeometry = (await loadWindowState(windowStatePath())) ?? rememberedGeometry;

  const bounds = restoreBounds(
    rememberedGeometry,
    screen.getAllDisplays().map((display) => display.workArea),
  );

  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // Matches the dark theme's page background, so the first paint is not a
    // white flash before the renderer has decided its colours.
    backgroundColor: '#0b0d10',
    title: PRODUCT_NAME,
    ...(existsSync(windowIcon) ? {icon: windowIcon} : {}),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(moduleDir, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      ...(offscreen ? {offscreen: true} : {}),
    },
  });

  // An offscreen window has no surface to show.
  if (!offscreen) {
    window.once('ready-to-show', () => {
      window.show();
    });
  }

  // A link in a rendered message must never navigate the app window: it opens in
  // the user's browser or not at all.
  window.webContents.setWindowOpenHandler(({url}) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return {action: 'deny'};
  });

  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(join(moduleDir, '..', 'renderer', 'index.html'));
  }

  return window;
}

/**
 * Broadcast to every window that can draw it.
 *
 * **Two windows, and the companion is not a decoration of the main one.** An
 * event that reaches only the main window is not merely late in the pet — the
 * pet is *built* from this stream. It has no transcript of its own to fall back
 * on: bubbles are drawn from `turn.started` and `text.delta`, and the few stored
 * messages above them are re-read when `turn.completed` arrives. A companion
 * that hears nothing therefore looks completely healthy and completely silent,
 * and the conversation it is sharing is visibly progressing in the other window
 * — which is exactly the report that found this. It went unnoticed because the
 * pet's *calls* all work: it can create a conversation, send a turn, and list
 * what was said. Only the answers were missing.
 *
 * Also where the tray and the notifications learn what happened, because this is
 * the one place every event passes through: a job finishing, a connector coming
 * up, a turn starting. Hanging the tray off it means the menu cannot go stale
 * because somebody forgot to call a refresh somewhere.
 */
export function broadcast(event: AgentUiEvent): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_EVENT_CHANNEL, event);
  }
  // Through the companion's own sender, which is already how it is written to —
  // and which tolerates a pet that has not been created yet.
  companion?.send(IPC_EVENT_CHANNEL, event);

  switch (event.type) {
    case 'job.changed':
      void refreshJobs();
      return;
    case 'mcp.status':
    case 'turn.started':
    case 'turn.completed':
    case 'turn.failed':
    case 'turn.aborted':
      refreshTray();
      break;
    default:
      break;
  }

  maybeNotify(event);
}

/**
 * Writes a PNG of the window and exits.
 *
 * Moved to `scripts/smoke.mjs`. Capturing belongs to the check that needs the
 * image, not to the app: this file had a `--capture` flag for a while, and it
 * was a hook that could fail — `capturePage` does not work without a GPU — in
 * code that ships. The smoke script drives a window over the DevTools protocol
 * instead, which needs nothing from the app.
 */

/** A problem to show the user, decided while the app starts. */
let startupWarning: string | undefined;

/**
 * The theme preference, kept in step with the settings file.
 *
 * A plain variable because `app.info` is answered synchronously and the settings
 * store is not — so the value is refreshed whenever the file changes rather than
 * read on every call.
 */
let storedThemeMode: ThemeMode = 'system';

/** Re-reads the preference, and tells the window if it moved. */
async function refreshThemeMode(): Promise<void> {
  if (agent === undefined) {
    return;
  }
  try {
    const settings = await agent.settings();
    const next = settings.appearance.theme;
    if (next !== storedThemeMode) {
      storedThemeMode = next;
      broadcast({type: 'theme.changed', mode: next});
    }
  } catch {
    // A settings file that cannot be read leaves the last known answer in
    // place, which is better than the window losing its colours over it.
  }
}

/**
 * The tray, when there is one.
 *
 * Its existence is what makes closing the window not mean quitting, so it is
 * also what `close` and `window-all-closed` consult before deciding.
 */
let tray: Tray | undefined;
/**
 * The floating companion, once one has been built.
 *
 * Built at startup rather than on first use, because "has the user switched this
 * on" has to be answered before anything can decide whether to show it — and the
 * window it builds is cheap when it is hidden.
 */
let companion: Companion | undefined;

/**
 * Pushes the companion's settings at the window that has to obey them.
 *
 * Two owners, one file. `alwaysOnTop` is the window manager's business and is
 * applied to the `BrowserWindow` here; the other three are how the renderer
 * draws and what it asks for, and reach it as an event. Both happen on the same
 * path, so a settings write cannot take effect in one place and not the other.
 *
 * Called after every settings write as well as at startup: the pet window is a
 * separate document from the settings screen, so nothing over there has a return
 * value to read.
 */
async function refreshCompanionSettings(): Promise<void> {
  if (agent === undefined || companion === undefined) {
    return;
  }
  try {
    const {companion: next} = await agent.settings();
    if (JSON.stringify(next) === JSON.stringify(companion.currentSettings())) {
      return;
    }
    companion.applySettings(next);
    broadcast({type: 'companion.changed', settings: next});
  } catch {
    // The same rule the theme follows: an unreadable settings file leaves the
    // last known answer in place rather than taking the pet down with it.
  }
}

/**
 * Whether the user has been told that closing the window leaves the app
 * running.
 *
 * Said once. Repeating it is a notification people learn to dismiss, and the one
 * they then dismiss is an approval request.
 */
let toldAboutTray = false;

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();

  const disagreement = userDataDisagreement();
  if (disagreement !== undefined) {
    /*
     * Loud on purpose, and shown in the window as well as logged. Nothing else
     * fails when this is wrong — the background service simply never finds
     * anything due — so this warning is the only evidence the user would ever
     * get, and a console line is evidence nobody in a packaged app can see.
     */
    console.warn(`[marimo] ${disagreement}`);
    startupWarning = disagreement;
  }

  /*
   * The agent starts before the window, and a failure here does not stop the
   * window opening. A broken settings file, an unreadable profile or a server
   * that will not dial must leave the user with an app they can fix — the
   * alternative is a process with no window and nothing to click, which is the
   * one failure a desktop app cannot recover from.
   */
  agent = new AgentService({paths, sendEvent: broadcast});
  try {
    await agent.start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[marimo] the agent failed to start:', detail);
    await agent.stop().catch(() => undefined);
    agent = undefined;
  }

  registerIpcHandler({
    paths,
    agent: () => agent,
    /*
     * The preference as stored, read fresh each time rather than cached: the
     * window can change it, and a cached answer would leave the theme switch
     * disagreeing with the file it just wrote.
     */
    themeMode: () => storedThemeMode,
    /*
     * Re-read after a settings write, since that is where the theme can change.
     * A callback rather than an event: the write happens in the IPC handler, and
     * inventing a broadcast for something with exactly one producer would be a
     * second mechanism for the same fact.
     */
    onSettingsChanged: () => {
      void refreshThemeMode();
      void refreshCompanionSettings();
    },
    companion: () => companion,
    ...(startupWarning === undefined ? {} : {warning: startupWarning}),
    service: {
      paths,
      // The app's own binary. Asked to be Node by the unit, this is the same
      // process image the runner runs as.
      execPath: process.execPath,
      appPath: app.getAppPath(),
      home: homedir(),
      // Resolved now and written into the definition rather than read when the
      // timer fires: a service started at login may not have these.
      configHome:
        process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
      // Read per call rather than captured: the provider can change while the
      // app is open, and a copy taken here would answer about the one that was
      // active when the window opened.
      readSettings: async () =>
        agent === undefined ? defaultStoredSettings() : await agent.settings(),
    },
  });

  /*
   * The tray comes before the window, and before anything can be closed. What
   * makes closing a window safe is that there is a tray to reopen it from, so
   * creating it afterwards would leave a moment where closing meant quitting —
   * and closing is exactly what a user does in the first second.
   */
  createTray();

  /*
   * Opened hidden when the OS started this at login. A window in somebody's face
   * every morning is one they turn the feature off to escape.
   */
  // On by default, because a companion nobody can find is one nobody uses —
  // and off is one tick away in the tray.
  const companionEnabled = true;

  companion = new Companion({
    stateFile: join(paths.userData, 'companion-state.json'),
    preload: join(moduleDir, '..', 'preload', 'index.cjs'),
    htmlPath: join(moduleDir, '..', 'renderer', 'companion.html'),
    ...(devServerUrl === undefined ? {} : {devServerUrl}),
    ...(existsSync(windowIcon) ? {icon: windowIcon} : {}),
  });
  /*
   * Before it is shown, so the window is built the way the user asked rather
   * than at the defaults and corrected a frame later.
   */
  await refreshCompanionSettings();
  if (companionEnabled) {
    await companion.show();
  }

  const startedHidden = process.argv.includes('--hidden');
  mainWindow = await createWindow();
  if (startedHidden) {
    mainWindow.hide();
  }

  await refreshJobs();
  await refreshThemeMode();

  /*
   * Remember where it ends up.
   *
   * `getNormalBounds` rather than `getBounds`, so a window the user maximised
   * still records the size it would return to: storing the maximised rectangle
   * would make "restore" mean "open at full size, un-maximised".
   *
   * The write is debounced because a drag fires an event per pixel and the same
   * value would be written each time.
   */
  let settle: NodeJS.Timeout | undefined;
  const remember = (): void => {
    if (settle !== undefined) {
      clearTimeout(settle);
      settle = undefined;
    }
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      return;
    }
    void saveWindowState(
      windowStatePath(),
      windowStateOf(mainWindow.getNormalBounds()),
    );
  };
  mainWindow.on('resize', () => {
    if (settle !== undefined) {
      clearTimeout(settle);
    }
    settle = setTimeout(remember, SETTLE_MS);
  });
  mainWindow.on('close', (event) => {
    remember();
    /*
     * The close button hides rather than quits, which is what a tray-resident
     * app is. Held back only while there is a tray and the user has not actually
     * asked to quit — and the user is told once, because an app that appears to
     * ignore its own close button is one people kill from a task manager.
     */
    if (staysResident() && !quitting) {
      event.preventDefault();
      mainWindow?.hide();
      explainResidency();
      refreshTray();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

/**
 * Whether the app should stay running with no window.
 *
 * True whenever there is a tray to get it back from. Without one, closing the
 * window has to mean quitting: a process with no window and no way to reach it
 * is one the user can only kill from a task manager.
 */
function staysResident(): boolean {
  return tray !== undefined;
}

/** Whether the app comes back after a login. */
function startAtLogin(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    // A platform that cannot answer is one where the switch has nothing to show,
    // and "off" is the honest reading of that.
    return false;
  }
}

function setStartAtLogin(on: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: on,
    /*
     * Started hidden. A login that opens a window in somebody's face every
     * morning is one they turn off again — and the flag is what the start-up
     * path reads to decide.
     */
    args: ['--hidden'],
  });
  refreshTray();
}

/** Creates the tray, and the icon it needs. */
function createTray(): void {
  if (tray !== undefined) {
    return;
  }
  const icon = nativeImage.createFromPath(windowIcon);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({width: 22, height: 22}));
  tray.setToolTip(PRODUCT_NAME);
  // A click on the icon is the gesture people try first; on Windows and Linux a
  // menu on left-click is the convention, so both do the same thing here.
  tray.on('click', () => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
    refreshTray();
  });
  refreshTray();
}

/** Rebuilds the tray menu from what is true now. */
function refreshTray(): void {
  if (tray === undefined) {
    return;
  }
  const items: TrayItem[] = trayMenu({
    windowVisible: mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible(),
    startAtLogin: startAtLogin(),
    jobs: jobsForTray(),
    busy: agent?.isBusy() ?? false,
    connectors: agent?.mcpStatuses() ?? {},
    companionVisible: companion?.isVisible() ?? false,
  });

  tray.setContextMenu(
    Menu.buildFromTemplate(
      items.map((item) =>
        item.type === 'separator'
          ? {type: 'separator' as const}
          : {
              label: item.label ?? '',
              ...(item.enabled === undefined ? {} : {enabled: item.enabled}),
              ...(item.checked === undefined
                ? {}
                : {type: 'checkbox' as const, checked: item.checked}),
              ...(item.id === undefined
                ? {}
                : {click: () => void onTrayCommand(item.id ?? '')}),
            },
      ),
    ),
  );
}

/** The jobs the tray summarises. Read synchronously, so it is cached. */
let trayJobs: Awaited<ReturnType<AgentService['jobs']>> = [];
function jobsForTray(): typeof trayJobs {
  return trayJobs;
}

/** Refreshes the cached summary the tray draws from. */
async function refreshJobs(): Promise<void> {
  if (agent === undefined) {
    trayJobs = [];
    return;
  }
  try {
    trayJobs = await agent.jobs();
    refreshTray();
  } catch {
    // A jobs file that cannot be read is reported in the window; the tray
    // showing a stale count for a moment is better than it disappearing.
  }
}

async function onTrayCommand(id: string): Promise<void> {
  switch (id) {
    case 'toggle-window':
      if (mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        showWindow();
      }
      refreshTray();
      return;
    case 'toggle-companion':
      if (companion?.isVisible() === true) {
        companion.hide();
      } else {
        await companion?.show();
      }
      refreshTray();
      return;
    case 'settings':
      showWindow();
      /*
       * The window owns what it is looking at, so "open Settings" is a message
       * to it rather than a navigation this process performs.
       */
      broadcast({type: 'window.openSettings'});
      return;
    case 'start-at-login':
      setStartAtLogin(!startAtLogin());
      return;
    case 'quit':
      quitting = true;
      await shutdown();
      app.quit();
      return;
    default:
      return;
  }
}

/** Brings the window back, rebuilding it if it was closed. */
function showWindow(): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

/**
 * Tells the user, once, that closing the window left the app running.
 *
 * Said once because a notification people learn to dismiss is one they will also
 * dismiss when it is an approval request. And said at all because the
 * alternative is an app that appears to ignore the close button — which is the
 * behaviour people describe as "it would not quit" and resolve by killing it.
 */
function explainResidency(): void {
  if (toldAboutTray || !Notification.isSupported()) {
    return;
  }
  toldAboutTray = true;
  new Notification({
    title: `${PRODUCT_NAME} is still running`,
    body: 'It keeps to its schedule in the background. Use the tray icon to bring it back, or to quit.',
  }).show();
}

/**
 * Shows a notification for something that needs the user.
 *
 * The rule lives in `tray.ts` and is deliberately narrow: *needs you*, not
 * *happened*.
 */
function maybeNotify(event: AgentUiEvent): void {
  if (!Notification.isSupported()) {
    return;
  }
  /*
   * Only when the window is not in front of them. A notification for something
   * already on screen is noise, and it is the noise that teaches people to
   * dismiss the ones that matter.
   */
  if (mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    return;
  }
  const notice = noticeFor(event as {type: string});
  if (notice === undefined) {
    return;
  }
  const shown = new Notification({title: notice.title, body: notice.body});
  shown.on('click', () => {
    showWindow();
  });
  shown.show();
}

/**
 * Stops the agent before the process goes.
 *
 * Awaited rather than fired and forgotten, because the agent holds MCP child
 * processes and a half-written conversation: quitting out from under it leaves
 * both behind. Idempotent, because `window-all-closed` and `before-quit` can
 * both arrive.
 */
let shuttingDown = false;

/**
 * Whether the user asked to quit, as opposed to closing a window.
 *
 * The distinction the whole of the tray behaviour rests on: with a tray, closing
 * the window leaves the app running, and only an explicit quit ends it. Without
 * this flag every `close` would be read as "the user is finished".
 */
let quitting = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  companion?.destroy();
  companion = undefined;
  const service = agent;
  agent = undefined;
  await service?.stop().catch((error: unknown) => {
    console.error('[marimo] the agent did not stop cleanly:', error);
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  // Another copy owns the user-data directory. Hand over and leave, rather than
  // racing it for the same conversation files.
  app.quit();
} else {
  /*
   * Before anything is ready, and deliberately: Electron reads a custom scheme's
   * privileges once, while it builds the URL request factory inside the ready
   * sequence. A call after that is a warning nobody reads and a scheme that
   * stays non-standard — which for `marimo-media://` means a video whose seeks
   * never arrive, or a frame that taints the canvas it is drawn into.
   */
  registerMediaScheme();

  /*
   * Launching the app again brings the window back.
   *
   * `showWindow` rather than focusing what is there, because with a tray the
   * window may have been *closed* — `mainWindow` is then undefined, and the
   * version of this that only focused an existing window did nothing at all.
   * That is the most likely way somebody tries to get back to a resident app:
   * they click the launcher again, and an app that appears not to start is one
   * they conclude is broken.
   */
  app.on('second-instance', () => {
    showWindow();
    refreshTray();
  });

  app.on('window-all-closed', () => {
    /*
     * Staying up is the point of a tray-resident app, and it is only safe
     * *because* of the tray: a process with no window and no way to reach it is
     * one the user can only kill from a task manager. So the tray's existence is
     * what decides, rather than a constant.
     */
    if (staysResident() && !quitting) {
      return;
    }
    void shutdown().then(() => {
      app.quit();
    });
  });

  /*
   * Every other way out — a signal, a menu, `app.quit()` from anywhere — arrives
   * here, and the agent has to be stopped before the process goes: it holds MCP
   * child processes and a conversation that may be mid-write.
   *
   * The quit is held once while that happens and then allowed through. The
   * `shuttingDown` flag is what makes that terminate rather than loop: the second
   * pass finds the work already done and lets the quit proceed.
   */
  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return;
    }
    event.preventDefault();
    void shutdown().then(() => {
      app.quit();
    });
  });

  void app.whenReady().then(bootstrap);
}
