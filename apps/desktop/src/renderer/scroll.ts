/**
 * Following an answer as it arrives, without taking the page away from somebody
 * who is reading it.
 *
 * The whole of this is one decision, and it is the decision that makes a
 * streaming reply pleasant or infuriating: follow when the view is already at
 * the bottom, and **do not** when it is not. A chat that scrolls to the newest
 * text unconditionally cannot be read while it is being written — every attempt
 * to look back at the previous paragraph is undone a moment later by the next
 * token.
 *
 * The rule is pure and lives here so it can be tested without a browser; the
 * effect that applies it is a few lines in `Transcript`.
 */

/**
 * How close to the bottom counts as being at the bottom.
 *
 * Not zero, because a browser does not land exactly on the boundary — sub-pixel
 * layout and a scrollbar's own rounding leave a pixel or two — and a rule that
 * demanded exactness would stop following after the first scroll.
 */
export const FOLLOW_SLACK_PX = 48;

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether new content should be scrolled into view.
 *
 * `true` when the view is already at the bottom, `false` when somebody has
 * scrolled up to read. The name is deliberately about following rather than
 * about the bottom: the question is not where the view is, but whether the user
 * is still keeping up with it.
 */
export function shouldFollow(geometry: ScrollGeometry): boolean {
  const distance = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return distance <= FOLLOW_SLACK_PX;
}

/**
 * Whether to offer a way back down.
 *
 * Shown once the user is far enough up that they have clearly stopped following,
 * and deliberately further than `FOLLOW_SLACK_PX`: a button that appears the
 * instant somebody scrolls a line is one that flickers in and out while they
 * read. This is a fraction of the view, so it behaves the same on a short window
 * and a tall one.
 */
export function shouldOfferJump(geometry: ScrollGeometry): boolean {
  const distance = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return distance > Math.max(FOLLOW_SLACK_PX * 4, geometry.clientHeight / 2);
}
