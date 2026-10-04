/**
 * Where the window opens, given where it was.
 *
 * The interesting cases are all about the machine having changed since the
 * bounds were written: a monitor unplugged, a resolution dropped, or a settings
 * file that never described a window at all. A window restored entirely
 * off-screen is the failure these guard, because the app is then running with
 * nothing to click.
 */
import {describe, expect, it} from 'vitest';

import type {WindowState} from '@marimo/protocol';

import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  restoreBounds,
  windowStateOf,
} from '../src/main/window-state.js';

/** One 1920×1080 display with a taskbar, at the origin. */
const LAPTOP = {x: 0, y: 0, width: 1920, height: 1040};
/** A second display to the left, which is where negative coordinates come from. */
const LEFT = {x: -1600, y: -200, width: 1600, height: 900};

function state(patch: Partial<WindowState> = {}): WindowState {
  return {width: 1180, height: 780, x: null, y: null, ...patch};
}

describe('restoreBounds', () => {
  it('keeps a size and position that still fit the screen', () => {
    const bounds = restoreBounds(state({x: 100, y: 50}), [LAPTOP]);
    expect(bounds).toEqual({width: 1180, height: 780, x: 100, y: 50});
  });

  it('places the first window when there is no position to restore', () => {
    expect(restoreBounds(state(), [LAPTOP])).toEqual({
      width: 1180,
      height: 780,
    });
  });

  it('will not shrink a window below its own minimum', () => {
    // A hand-edited file, or an older build with a smaller floor.
    const bounds = restoreBounds(state({width: 400, height: 300}), [LAPTOP]);
    expect(bounds.width).toBe(MIN_WINDOW_WIDTH);
    expect(bounds.height).toBe(MIN_WINDOW_HEIGHT);
  });

  it('will not open larger than the screen it is opening on', () => {
    // The 4K monitor the window was last on is not the laptop it is starting on.
    const bounds = restoreBounds(state({width: 3800, height: 2100}), [
      {x: 0, y: 0, width: 1366, height: 728},
    ]);
    expect(bounds.width).toBe(1366);
    expect(bounds.height).toBe(728);
  });

  it('centres, rather than restoring, a position on a display that is gone', () => {
    // Saved on the left-hand monitor, started with only the laptop attached: the
    // saved x is off the left edge, and there would be nothing to grab.
    const bounds = restoreBounds(state({x: -1600, y: -200}), [LAPTOP]);
    expect(bounds).toEqual({width: 1180, height: 780});
  });

  it('restores that same position when the monitor is there', () => {
    const bounds = restoreBounds(state({x: -1600, y: -200}), [LAPTOP, LEFT]);
    expect(bounds).toEqual({width: 1180, height: 780, x: -1600, y: -200});
  });

  it('keeps a position that is only half on screen, if enough of it is', () => {
    // Dragging a window most of the way off the right edge is a legitimate place
    // to leave it; the title bar is still reachable.
    const bounds = restoreBounds(state({x: 1800, y: 100}), [LAPTOP]);
    expect(bounds).toEqual({width: 1180, height: 780, x: 1800, y: 100});
  });

  it('centres a position that only clips the corner', () => {
    // 10 px of overlap is not enough to click, let alone drag.
    const bounds = restoreBounds(state({x: 1910, y: 1030}), [LAPTOP]);
    expect(bounds).toEqual({width: 1180, height: 780});
  });

  it('leaves the size alone when no display is known', () => {
    // Should not happen once the app is ready, but clamping to nothing would be
    // a worse answer than opening at the remembered size.
    expect(restoreBounds(state({width: 1024, height: 640}), [])).toEqual({
      width: 1024,
      height: 640,
    });
  });

  it('accepts exactly the minimum size', () => {
    const bounds = restoreBounds(
      state({width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT}),
      [LAPTOP],
    );
    expect(bounds.width).toBe(MIN_WINDOW_WIDTH);
    expect(bounds.height).toBe(MIN_WINDOW_HEIGHT);
  });
});

describe('windowStateOf', () => {
  it('stores the four numbers, rounded', () => {
    // Electron reports fractional bounds on a scaled display, and the settings
    // schema stores integers — a non-integer would fail the block on the next
    // read and cost the user their position.
    expect(
      windowStateOf({x: 10.4, y: -20.6, width: 1024.5, height: 640.4}),
    ).toEqual({x: 10, y: -21, width: 1025, height: 640});
  });

  it('round-trips through restoreBounds unchanged', () => {
    const stored = windowStateOf({x: 12, y: 34, width: 1024, height: 640});
    expect(restoreBounds(stored, [LAPTOP])).toEqual({
      width: 1024,
      height: 640,
      x: 12,
      y: 34,
    });
  });
});
