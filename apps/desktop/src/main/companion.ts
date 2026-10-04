/**
 * The floating companion: a marimo that lives on the desktop.
 *
 * A second window — frameless, transparent, above everything — showing the moss
 * ball with a chat bar and the answers appearing above it. It is deliberately
 * *not* a second agent: it shares the main process, the conversation and the
 * capability grants, so asking it something and reading the window later is one
 * thread rather than two that drift apart.
 *
 * Three things make it feel like it is on the desktop rather than in a box, and
 * all three are load-bearing:
 *
 * - **Transparent and frameless**, so there is no rectangle around the moss.
 * - **Click-through where there is nothing to click.** Without this the window
 *   is an invisible rectangle that swallows every click on whatever is behind
 *   it, which is the thing people mean when they say a desktop pet is in the
 *   way. The renderer reports whether the pointer is over something, and the
 *   window stops accepting the mouse when it is not.
 * - **Always on top, on every workspace**, so switching desktops does not lose
 *   it.
 *
 * Geometry is remembered in its own file, like the main window's, because it is
 * the window manager's numbers rather than a user preference — and a preference
 * that has to be repaired when a monitor is unplugged is not a preference.
 */
import {BrowserWindow, screen, shell} from 'electron';

import {
  loadWindowState,
  restoreBounds,
  saveWindowState,
  windowStateOf,
} from './window-state.js';

/** Big enough for a few lines of an answer, small enough to sit in a corner. */
export const COMPANION_WIDTH = 340;
export const COMPANION_HEIGHT = 460;

/** How far from the screen's corner it starts, before anybody moves it. */
const MARGIN = 24;

export interface CompanionOptions {
  /** The file the geometry is kept in. */
  stateFile: string;
  /** The preload script, shared with the main window. */
  preload: string;
  /** Where the renderer lives, when it is not the dev server. */
  htmlPath: string;
  devServerUrl?: string | undefined;
  /** The icon, for the rare platform that shows one. */
  icon?: string | undefined;
}

/**
 * Where it should open the first time.
 *
 * The bottom right, because that is where a companion belongs: out of the way of
 * the window somebody is working in, and beside the clock and the tray where the
 * rest of the background furniture lives. Returned as bounds rather than as
 * constants so it can be clamped to the display's own work area — a corner
 * placement that ignored the taskbar would put the moss underneath it.
 */
export function defaultCompanionBounds(workArea: {
  x: number;
  y: number;
  width: number;
  height: number;
}): {x: number; y: number; width: number; height: number} {
  return {
    x: workArea.x + workArea.width - COMPANION_WIDTH - MARGIN,
    y: workArea.y + workArea.height - COMPANION_HEIGHT - MARGIN,
    width: COMPANION_WIDTH,
    height: COMPANION_HEIGHT,
  };
}

export class Companion {
  private window: BrowserWindow | undefined;
  /** Whether clicks should pass through to whatever is behind. */
  private ignoring = false;

  constructor(private readonly options: CompanionOptions) {}

  isVisible(): boolean {
    return (
      this.window !== undefined &&
      !this.window.isDestroyed() &&
      this.window.isVisible()
    );
  }

  /** Builds the window if it is not up, then shows it. */
  async show(): Promise<void> {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.window.showInactive();
      return;
    }
    await this.create();
  }

  hide(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.window.hide();
    }
  }

  destroy(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = undefined;
  }

  /**
   * Lets clicks pass through, or stops.
   *
   * `forward: true` is what makes the other half possible: with it, the window
   * still receives the mouse *move* events that let the renderer notice the
   * pointer has come back over the moss, so click-through is something the user
   * can leave by moving rather than by a keyboard shortcut.
   */
  setClickThrough(ignore: boolean): void {
    if (this.window === undefined || this.window.isDestroyed()) {
      return;
    }
    if (this.ignoring === ignore) {
      return;
    }
    this.ignoring = ignore;
    this.window.setIgnoreMouseEvents(ignore, {forward: true});
  }

  /** Sends an event to the companion, when it is up. */
  send(channel: string, payload: unknown): void {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  private async create(): Promise<void> {
    const restored = await this.restoredBounds();
    const bounds =
      restored ?? defaultCompanionBounds(screen.getPrimaryDisplay().workArea);

    const window = new BrowserWindow({
      ...bounds,
      // Frameless and transparent: there must be no rectangle around the moss.
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // Not in the taskbar or the window list. It is furniture, not a window
      // somebody alt-tabs to.
      skipTaskbar: true,
      alwaysOnTop: true,
      // Shown without taking focus, so it never steals a keystroke from whatever
      // the user is actually typing in.
      show: false,
      focusable: true,
      ...(this.options.icon === undefined ? {} : {icon: this.options.icon}),
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    /*
     * `floating` rather than plain always-on-top, so it sits above ordinary
     * windows without fighting full-screen ones and system dialogs. And visible
     * on every workspace: a companion that disappears when the user switches
     * desktop is one they have to go and find.
     */
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: false});

    window.once('ready-to-show', () => {
      window.showInactive();
    });
    window.on('closed', () => {
      this.window = undefined;
    });
    // Moved by dragging its own surface, so the position is saved when it stops.
    window.on('moved', () => {
      void saveWindowState(
        this.options.stateFile,
        windowStateOf(window.getNormalBounds()),
      );
    });

    // A link in an answer must never navigate the companion; it opens in the
    // user's browser or not at all.
    window.webContents.setWindowOpenHandler(({url}) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url);
      }
      return {action: 'deny'};
    });

    this.window = window;

    if (
      this.options.devServerUrl !== undefined &&
      this.options.devServerUrl.length > 0
    ) {
      await window.loadURL(`${this.options.devServerUrl}/companion.html`);
    } else {
      await window.loadFile(this.options.htmlPath);
    }
  }

  /** The remembered geometry, if it still describes somewhere reachable. */
  private async restoredBounds(): Promise<
    {x: number; y: number; width: number; height: number} | undefined
  > {
    const stored = await loadWindowState(this.options.stateFile);
    if (stored === undefined) {
      return undefined;
    }
    /*
     * Clamped to this window's own size rather than the main window's floor: the
     * companion is deliberately smaller than the minimum the main window allows,
     * so reusing that floor would refuse every saved position it has.
     */
    const bounds = restoreBounds(
      stored,
      screen.getAllDisplays().map((display) => display.workArea),
    );
    return {
      x: bounds.x ?? 0,
      y: bounds.y ?? 0,
      width: COMPANION_WIDTH,
      height: COMPANION_HEIGHT,
    };
  }
}


