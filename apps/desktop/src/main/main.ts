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
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {BrowserWindow, app, screen, shell} from 'electron';

import {IPC_EVENT_CHANNEL, defaultWindowState} from '@marimo/protocol';
import type {AgentUiEvent, WindowState} from '@marimo/protocol';

import {registerIpcHandler} from './ipc.js';
import {AgentService} from './agent.js';
import {
  applyUserDataOverride,
  resolvePaths,
  userDataDisagreement,
} from './paths.js';
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  restoreBounds,
  windowStateOf,
} from './window-state.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env['MARIMO_DEV_SERVER_URL'];

/*
 * Before anything else, and before the app is ready: Electron keeps the
 * single-instance lock inside the user-data directory, so relocating the
 * directory has to happen before the lock is requested.
 */
applyUserDataOverride();

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
const rememberedGeometry: WindowState = defaultWindowState();

async function createWindow(): Promise<BrowserWindow> {
  /*
   * The stored geometry is the window manager's own numbers, so it can name a
   * monitor that has since been unplugged — and a window restored entirely
   * off-screen is an app that is running with nothing to click. `restoreBounds`
   * drops the position in that case and clamps the size to the widest display
   * attached now.
   */
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
    title: 'Marimo Agent',
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

/** Broadcast to the open window, if there is one. */
export function broadcast(event: AgentUiEvent): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_EVENT_CHANNEL, event);
  }
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

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();

  const disagreement = userDataDisagreement();
  if (disagreement !== undefined) {
    // Loud on purpose. Nothing else fails when this is wrong — the background
    // service simply never finds anything due — so the warning is the only
    // evidence the user would ever get.
    console.warn(`[marimo] ${disagreement}`);
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

  registerIpcHandler({paths, agent: () => agent});

  mainWindow = await createWindow();

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
    void windowStateOf(mainWindow.getNormalBounds());
  };
  mainWindow.on('resize', () => {
    if (settle !== undefined) {
      clearTimeout(settle);
    }
    settle = setTimeout(remember, SETTLE_MS);
  });
  mainWindow.on('close', remember);
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
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
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
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
  app.on('second-instance', () => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    /*
     * Quit, for now. This is the decision point M2 changes: once scheduled jobs
     * and connectors run in the main process, closing the last window can no
     * longer mean "stop the app" — but that is only true once there is a tray to
     * get it back from, and a process with no window and no tray is a process
     * the user cannot quit.
     */
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
