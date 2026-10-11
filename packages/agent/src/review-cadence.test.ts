/**
 * Which delay a conversation's next read-back should use.
 *
 * The cases that matter are the ones a timer cannot express: a long conversation
 * that has all been read is not a reason to look again, and a short one that has
 * not is. Both are asserted here rather than by waiting a minute.
 */
import {describe, expect, it} from 'vitest';

import {reviewDelay} from './review-cadence.js';

const THRESHOLD = 40;

describe('reviewDelay', () => {
  it('waits for quiet while a conversation is still short', () => {
    expect(reviewDelay({total: 12, reviewed: 0, threshold: THRESHOLD})).toBe(
      'idle',
    );
  });

  /*
   * The case the whole file exists for: twenty minutes without a pause. Nothing
   * here is unusual except the length, and the old rule would hold every one of
   * these events until a silence that may never come.
   */
  it('stops waiting once enough has piled up', () => {
    expect(reviewDelay({total: 41, reviewed: 0, threshold: THRESHOLD})).toBe(
      'shortly',
    );
    expect(reviewDelay({total: 900, reviewed: 0, threshold: THRESHOLD})).toBe(
      'shortly',
    );
  });

  /* Exactly at the threshold is due: the number is a count, not a margin. */
  it('treats the threshold itself as due', () => {
    expect(reviewDelay({total: 40, reviewed: 0, threshold: THRESHOLD})).toBe(
      'shortly',
    );
    expect(reviewDelay({total: 39, reviewed: 0, threshold: THRESHOLD})).toBe(
      'idle',
    );
  });

  /*
   * The watermark as a gate. A long conversation that has already been read back
   * to its end has nothing new in it, and a decision made on length instead would
   * spend a model call after every further turn of it.
   */
  it('counts what is unreviewed rather than how long the conversation is', () => {
    expect(reviewDelay({total: 500, reviewed: 500, threshold: THRESHOLD})).toBe(
      'idle',
    );
    expect(reviewDelay({total: 500, reviewed: 480, threshold: THRESHOLD})).toBe(
      'idle',
    );
    expect(reviewDelay({total: 500, reviewed: 460, threshold: THRESHOLD})).toBe(
      'shortly',
    );
  });

  /*
   * A watermark past the end of its conversation is a real state — the mark is
   * keyed by session id and nothing stops an id being reused — and it has to read
   * as "nothing new" rather than as a negative number of events, which would make
   * every such conversation due forever.
   */
  it('treats a watermark past the end as nothing new', () => {
    expect(reviewDelay({total: 3, reviewed: 90, threshold: THRESHOLD})).toBe(
      'idle',
    );
  });

  it('never makes every turn due, however the threshold is set', () => {
    // A zero would defeat the watermark gate entirely, so it is read as one.
    expect(reviewDelay({total: 1, reviewed: 0, threshold: 0})).toBe('shortly');
    expect(reviewDelay({total: 0, reviewed: 0, threshold: 0})).toBe('idle');
  });
});
