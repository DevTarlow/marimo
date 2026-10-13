/**
 * What a tool result was worth, worked out from the result itself.
 *
 * The reward is the load-bearing number of the whole feature and it is worth
 * being explicit about what it is *not*. It is not an opinion about whether the
 * agent did well. It is not a model asked to grade an answer. It is a small
 * arithmetic function of facts already in the tree, and that constraint is the
 * feature rather than a limitation of it: a reward that needed the model could
 * not be recomputed from a log, and a reward that cannot be recomputed from a log
 * makes the replay either impossible or a liar. The replay's entire promise —
 * "these settings would have done this on your real turns, with no model running"
 * — rests on this file being pure.
 *
 * So the scale is coarse and every point on it is defensible from the record:
 *
 *   +1.0  the call ran and returned something
 *   -1.0  the call did not run — it threw, or the policy refused it
 *   -0.5  the call ran and returned nothing
 *
 * `-0.5` rather than `-1` for an empty result, because the two are genuinely
 * different: a refused call is a step the turn spent and learned nothing from,
 * while an empty result is an answer. "No files match that pattern" is a fact,
 * and scoring it as a failure would train the controller away from the tools
 * that tell it when to stop looking. It is still negative, because for the
 * purpose of choosing what to do next, a call that returned nothing moved the
 * turn no further forward than one that failed — while being much less alarming,
 * which is exactly why it gets its own number and its own reason.
 *
 * What is deliberately *not* measured, and why:
 *
 * - **Whether the result was useful.** Unknowable from a string, and every proxy
 *   for it — length, the absence of the word "error" — is a heuristic that would
 *   be wrong in a way nobody could see. A tool that returns a long correct answer
 *   and one that returns a long irrelevant answer score the same here. That is a
 *   real limitation, stated rather than hidden.
 * - **Whether the next step used it.** Recorded as `consumed` on the step, and
 *   deliberately not folded into the reward: it is a fact about a *later* node,
 *   so a reward that depended on it could not be computed at the moment the call
 *   finished — which is when the live policy needs it.
 */
import type {DreamReward} from '@marimo/protocol';

/**
 * The reasons a reward can carry, as a closed set.
 *
 * Closed so that a reader of a log can group by it, and so that adding a new one
 * is a visible change rather than a new string appearing in the data. The
 * `reason` field is a string on the wire, because a document that refused to
 * parse six months of logs over one unrecognised reason would be worse than one
 * that shows it.
 */
export const REWARD_REASONS = {
  /** The call ran and produced something. */
  ran: 'returned a result',
  /** The call ran and produced nothing at all. */
  empty: 'returned nothing',
  /** The call threw, or the tool reported an error. */
  failed: 'failed',
  /** The policy withheld the call. Nothing ran. */
  withheld: 'withheld by policy',
  /** The repeat rule refused the call. Nothing ran. */
  repeated: 'refused as a repeat',
} as const;

export type RewardReason = (typeof REWARD_REASONS)[keyof typeof REWARD_REASONS];

/** The value each reason carries. See the note above for why these numbers. */
export const REWARD_VALUES: Record<RewardReason, number> = {
  [REWARD_REASONS.ran]: 1,
  [REWARD_REASONS.empty]: -0.5,
  [REWARD_REASONS.failed]: -1,
  [REWARD_REASONS.withheld]: -1,
  [REWARD_REASONS.repeated]: -1,
};

export function rewardOf(reason: RewardReason): DreamReward {
  return {value: REWARD_VALUES[reason], reason};
}

/**
 * Reads a tool's result, which arrives as `unknown` at every layer.
 *
 * The shapes below are the ones this app's own tools actually produce, and the
 * ordering is the ordering of certainty: an explicit error is an error whatever
 * else is in the object, and only then does the presence of content count.
 *
 * The empty cases are enumerated rather than tested with a falsiness check, and
 * that is not pedantry. `0` and `false` are results — a line count of zero, a
 * grep that matched nothing, a check that passed — and `if (!result)` scores all
 * three as a failure. That is the bug this function exists to not have.
 */
export function rewardForResult(result: unknown): DreamReward {
  if (result === undefined || result === null) {
    return rewardOf(REWARD_REASONS.empty);
  }

  if (typeof result === 'string') {
    return result.trim().length === 0
      ? rewardOf(REWARD_REASONS.empty)
      : rewardOf(REWARD_REASONS.ran);
  }

  if (typeof result === 'number' || typeof result === 'boolean') {
    return rewardOf(REWARD_REASONS.ran);
  }

  if (Array.isArray(result)) {
    return result.length === 0
      ? rewardOf(REWARD_REASONS.empty)
      : rewardOf(REWARD_REASONS.ran);
  }

  if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    /*
     * Checked before `result`, because ADK wraps a refusal as `{error: ...}` and
     * a thrown tool as `{errorMessage: ...}` — an object that may well also carry
     * a `result` key holding a fragment of what it managed to do. An error with
     * partial output is still an error.
     */
    if (nonEmpty(record['error']) || nonEmpty(record['errorMessage'])) {
      return rewardOf(REWARD_REASONS.failed);
    }
    if ('result' in record) {
      return rewardForResult(record['result']);
    }
    return Object.keys(record).length === 0
      ? rewardOf(REWARD_REASONS.empty)
      : rewardOf(REWARD_REASONS.ran);
  }

  return rewardOf(REWARD_REASONS.ran);
}

/** A field that is present and says something. */
function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return true;
}

/**
 * The result as a string, for the head of it a node keeps.
 *
 * JSON for anything structured, because a `[object Object]` in a log is a node
 * nobody can replay — the arguments and outcomes of this app's tools are mostly
 * objects, and the point of storing the head is to be able to read what happened.
 *
 * A string is passed through unchanged rather than quoted. Most tool results are
 * already prose written for a model to read, and wrapping them in quotes would
 * put a layer of escaping between the reader and the thing they are reading.
 */
export function describeResult(result: unknown): string {
  if (result === undefined || result === null) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    /*
     * A cyclic value cannot be serialised, and a recorder is the last place that
     * should throw: this runs inside a tool callback, so an exception here fails
     * the tool call rather than the logging. The node keeps the fact that there
     * was a result and loses its text, which is the right way round.
     */
    return '[unserialisable result]';
  }
}
