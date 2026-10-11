/**
 * When an idle look at a conversation should actually happen.
 *
 * The review used to be one rule: a minute after the last turn, reset by every
 * new turn. That is right for a conversation that pauses — which is most of them
 * — and wrong for one that does not. A user typing for twenty minutes never
 * leaves the minute of silence the timer is waiting for, so nothing is read back
 * until they stop, and a scheduled job that runs to completion may never leave it
 * at all. A fact stated early is then unremembered for as long as the
 * conversation continues.
 *
 * So there are two delays, and the question this answers is which one applies.
 * The judgement is deliberately *not* here — it is in the threshold, which is a
 * setting, because "propose something mid-conversation" and "wait until I stop"
 * are both reasonable and only the user knows which they want. What is here is
 * the arithmetic, kept pure so the default can be reviewed and so the case that
 * motivated it can be stated as a test rather than as a timer.
 *
 * Two rules worth knowing, because both are silent when broken:
 *
 * **The watermark is a gate, not a hint.** The decision is made from what has not
 * been *read*, not from how long the conversation is. A conversation with four
 * hundred events and nothing new since the last look is a conversation with
 * nothing to review, and counting events instead would re-run the look after
 * every turn of it — a model call each time, to find nothing.
 *
 * **The answer is a word, not a duration.** The caller owns the two numbers, so
 * this file has no opinion about how long a minute is, and a test can assert the
 * decision without asserting a constant it does not own.
 */
export type ReviewDelay = 'idle' | 'shortly';

export interface ReviewDueOptions {
  /** Events stored in the conversation now. */
  total: number;
  /** How many of them the last look already read. */
  reviewed: number;
  /** Unreviewed events past which the look stops waiting. */
  threshold: number;
}

/**
 * Which delay the next look should use.
 *
 * `reviewed` is clamped below at zero: a conversation can be *shorter* than its
 * watermark — the store drops a session's mark when the session is deleted, and
 * a new session reusing the id starts from nothing — and a negative count of
 * unreviewed events must read as "nothing new" rather than as a reason to look.
 *
 * `threshold` is clamped above at one for the same kind of reason. A zero would
 * make every turn of every conversation due, including one whose events have all
 * been read, which is the failure the watermark gate exists to prevent.
 */
export function reviewDelay(options: ReviewDueOptions): ReviewDelay {
  const reviewed = Math.max(0, options.reviewed);
  const unreviewed = Math.max(0, options.total - reviewed);
  return unreviewed >= Math.max(1, options.threshold) ? 'shortly' : 'idle';
}
