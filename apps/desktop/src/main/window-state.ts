/**
 * Where the window should open, given where it was last time.
 *
 * Pure functions over rectangles, so the two decisions worth arguing about can be
 * tested without an Electron process: how big the window may be, and whether the
 * monitor it was on still exists.
 *
 * It exists because the stored bounds are the window manager's own numbers and
 * cannot be trusted by the time they are read back. They may describe a display
 * that has been unplugged, a resolution that has changed, or — after a
 * hand-edited settings file — nothing that was ever a window. Opening a window
 * entirely off-screen is the failure this prevents, and it is a bad one: the app
 * is running and there is nothing to click.
 */
import type {WindowState} from '@marimo/protocol';

/** The same floor the window itself declares, so a restored size obeys it. */
export const MIN_WINDOW_WIDTH = 900;
export const MIN_WINDOW_HEIGHT = 560;

/**
 * How much of the window has to be on a display to keep the saved position.
 *
 * A window whose corner is technically inside a screen but whose title bar is
 * not still cannot be dragged, so "one pixel of overlap" is not enough to be
 * usable. 48 px is comfortably more than a title bar and comfortably less than a
 * reasonable window.
 */
const MIN_VISIBLE = 48;

/** A display's usable rectangle, in the same coordinates Electron reports. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The bounds to hand a `BrowserWindow`; `x`/`y` absent means "place it". */
export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/**
 * The bounds to open with.
 *
 * The size is clamped into the range the window can actually be: never below its
 * own minimum, and never larger than the largest display's work area, because a
 * window saved on a 4K monitor and reopened on a laptop would otherwise be
 * bigger than the screen with nothing to grab. The position is kept only when
 * enough of the window would land on a display that exists now; otherwise it is
 * dropped, which is Electron's own "centre it".
 */
export function restoreBounds(
  state: WindowState,
  workAreas: readonly WorkArea[],
): WindowBounds {
  const widest = workAreas.reduce(
    (most, area) => Math.max(most, area.width),
    0,
  );
  const tallest = workAreas.reduce(
    (most, area) => Math.max(most, area.height),
    0,
  );

  const width = clamp(
    state.width,
    MIN_WINDOW_WIDTH,
    // With no displays known — which should not happen once the app is ready,
    // but must not become a zero-width window if it does — the size is left
    // alone rather than clamped to nothing.
    widest > 0 ? Math.max(widest, MIN_WINDOW_WIDTH) : state.width,
  );
  const height = clamp(
    state.height,
    MIN_WINDOW_HEIGHT,
    tallest > 0 ? Math.max(tallest, MIN_WINDOW_HEIGHT) : state.height,
  );

  if (state.x === null || state.y === null) {
    return {width, height};
  }
  const candidate = {x: state.x, y: state.y, width, height};
  if (!workAreas.some((area) => visibleOn(candidate, area))) {
    // The monitor it was on is gone. Centring is the only placement that is
    // right on whatever screen the user is actually looking at.
    return {width, height};
  }
  return candidate;
}

/**
 * The part of a window state worth storing.
 *
 * Called on every settled resize and move, so it is written as the smallest thing
 * that round-trips: the four numbers, and nulls where the platform reported
 * nothing.
 */
export function windowStateOf(bounds: {
  width: number;
  height: number;
  x: number;
  y: number;
}): WindowState {
  return {
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  };
}

/** Whether enough of the window is inside this work area to be usable. */
function visibleOn(
  window: {x: number; y: number; width: number; height: number},
  area: WorkArea,
): boolean {
  const horizontal = overlap(
    window.x,
    window.x + window.width,
    area.x,
    area.x + area.width,
  );
  const vertical = overlap(
    window.y,
    window.y + window.height,
    area.y,
    area.y + area.height,
  );
  return (
    horizontal >= Math.min(MIN_VISIBLE, window.width) &&
    vertical >= Math.min(MIN_VISIBLE, window.height)
  );
}

/** How far two intervals overlap; zero when they do not. */
function overlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Reads a window's remembered geometry.
 *
 * `undefined` for a file that is absent, unreadable, or not a rectangle — all
 * three mean the same thing to a caller, which is "open where you would have
 * opened anyway". A window that refused to appear because its geometry file was
 * corrupt would be a worse failure than one that forgot where it was.
 */
export async function loadWindowState(
  file: string,
): Promise<WindowState | undefined> {
  const {readFile} = await import('node:fs/promises');
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const candidate = parsed as Partial<Record<keyof WindowState, unknown>>;
    const numbers = (['width', 'height', 'x', 'y'] as const).map(
      (key) => candidate[key],
    );
    if (!numbers.every((value) => typeof value === 'number')) {
      return undefined;
    }
    return windowStateOf(
      parsed as {width: number; height: number; x: number; y: number},
    );
  } catch {
    return undefined;
  }
}

/**
 * Writes a window's geometry, so the next launch opens where this one was left.
 *
 * Written to a sibling and renamed, like every other document this app owns: a
 * crash midway through must not leave a half-file where the position was, because
 * the reader would then find nothing and the window would jump back to the
 * default — which is exactly the behaviour this exists to prevent.
 */
export async function saveWindowState(
  file: string,
  state: WindowState,
): Promise<void> {
  const {mkdir, rename, writeFile} = await import('node:fs/promises');
  const {dirname} = await import('node:path');
  try {
    await mkdir(dirname(file), {recursive: true});
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch {
    // A geometry file that cannot be written is not worth an error the user
    // cannot act on: the window still works, it just opens in the default place
    // next time.
  }
}
