/**
 * When a streaming reply should move the view, and when it must not.
 *
 * The failure this prevents is specific and familiar: a chat that scrolls to the
 * newest token unconditionally cannot be read while it is being written, because
 * every attempt to look back at the previous paragraph is undone a moment later.
 */
import {describe, expect, it} from 'vitest';

import {FOLLOW_SLACK_PX, shouldFollow, shouldOfferJump} from '../src/renderer/scroll.js';

/** A viewport 600px tall, holding `height` px of content, scrolled to `top`. */
function view(height: number, top: number): {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
} {
  return {scrollTop: top, scrollHeight: height, clientHeight: 600};
}

describe('following new content', () => {
  it('follows when the view is at the bottom', () => {
    expect(shouldFollow(view(1_000, 400))).toBe(true);
  });

  it('follows when there is nothing to scroll', () => {
    expect(shouldFollow(view(600, 0))).toBe(true);
  });

  /*
   * Not zero. A browser does not land exactly on the boundary — sub-pixel layout
   * and the scrollbar's own rounding leave a pixel or two — and a rule that
   * demanded exactness would stop following the first time anything scrolled.
   */
  it('follows when it is a pixel or two short of the bottom', () => {
    expect(shouldFollow(view(1_000, 399))).toBe(true);
    expect(shouldFollow(view(1_000, 400 - FOLLOW_SLACK_PX))).toBe(true);
  });

  /*
   * The case the whole rule exists for: somebody has scrolled up to read. New
   * text must arrive without the view moving, or they cannot read at all.
   */
  it('does not follow when somebody has scrolled up to read', () => {
    expect(shouldFollow(view(1_000, 100))).toBe(false);
    expect(shouldFollow(view(1_000, 0))).toBe(false);
  });

  it('stops following the moment the scroll goes past the slack', () => {
    expect(shouldFollow(view(1_000, 400 - FOLLOW_SLACK_PX - 1))).toBe(false);
  });

  it('follows again once they scroll back down', () => {
    // The property that makes it usable: it is not a mode to leave, it is a
    // question asked again every time content arrives.
    expect(shouldFollow(view(1_000, 0))).toBe(false);
    expect(shouldFollow(view(1_000, 400))).toBe(true);
  });

  it('keeps following as the content grows while at the bottom', () => {
    // What streaming actually looks like: the height increases and the view is
    // scrolled to the new bottom each time.
    expect(shouldFollow(view(1_000, 400))).toBe(true);
    expect(shouldFollow(view(1_400, 800))).toBe(true);
  });
});

describe('offering a way back down', () => {
  /*
   * Further up than the follow threshold on purpose. A button that appears the
   * instant somebody scrolls a line is one that flickers in and out while they
   * read — which is worse than not offering it.
   */
  it('does not offer it for a small scroll', () => {
    expect(shouldOfferJump(view(1_000, 400))).toBe(false);
    // Still not, right at the edge of following.
    expect(shouldOfferJump(view(1_000, 350))).toBe(false);
  });

  it('offers it once somebody has clearly stopped following', () => {
    expect(shouldOfferJump(view(2_000, 0))).toBe(true);
  });

  /*
   * Measured against the view, not a fixed number of pixels, so a short window
   * and a tall one behave the same way.
   */
  it('scales with the height of the view', () => {
    const short = {scrollTop: 0, scrollHeight: 900, clientHeight: 200};
    const tall = {scrollTop: 0, scrollHeight: 2_000, clientHeight: 1_200};
    // Both are scrolled to the top of their content and both should offer it.
    expect(shouldOfferJump(short)).toBe(true);
    expect(shouldOfferJump(tall)).toBe(true);
  });

  it('never offers it when the view is already at the bottom', () => {
    expect(shouldOfferJump(view(600, 0))).toBe(false);
    expect(shouldOfferJump(view(1_000, 400))).toBe(false);
  });
});
