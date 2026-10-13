/**
 * The step controller, as a pure function of history and two weights.
 *
 * This is where "what to do next" became a decision the app makes rather than
 * one the model makes alone. It used to be implicit in two places at once: the
 * model chose from every granted tool, and `RepeatedToolCallPlugin` refused its
 * third identical call. Neither was configurable and neither could be measured,
 * because neither had anything to measure against — the app recorded no history
 * of what it had tried.
 *
 * Three decisions shape this file.
 *
 * **It is pure.** `score` and `prune` read a stats object and two numbers and
 * return a value; they touch no clock, no disk and no model. That is not tidiness
 * — it is the whole feature. The offline replay in `replay.ts` is the same
 * functions called on a loop over a recorded log, so a policy measured offline is
 * the policy that runs live, by construction rather than by keeping two
 * implementations in step. Every temptation to make the score cleverer has to
 * survive this constraint: a score that needs the model cannot be replayed, and a
 * score that cannot be replayed cannot be tuned.
 *
 * **The exploration bonus is UCB1.** Mean reward plus `w * sqrt(ln N / n)`: the
 * first term is what has worked, the second is what has not been tried enough.
 * The alternative — epsilon-greedy — needs a random number generator, and a
 * controller whose decision depends on a die cannot be compared against itself
 * across two runs of a replay. UCB1 is deterministic given the history, which is
 * what makes "setting A beat setting B on this log" a statement rather than a
 * coin flip.
 *
 * **An unseen action is the interesting case, and it is handled explicitly.**
 * `sqrt(ln N / 0)` is infinity, and infinity would mean the controller always
 * tries the least-visited action — a controller that cannot exploit anything it
 * has learned, because at every step some action has been tried zero times. So an
 * untried action scores the exploration weight itself: at the default `1` it ties
 * with a proven action scoring 1 and loses to nothing, which leaves the opening
 * move to the model. That is the honest reading of the setting. Weight 0 means
 * "an untried action is worth nothing", which is a real strategy — stick to what
 * works — and it is the setting that turns this off.
 */
import type {SearchPolicySettings} from '@marimo/protocol';

/**
 * Re-exported so that `./search.js` is the one place a caller has to look for
 * the two weights — the type is the contract's, but every module that uses the
 * policy imports it from beside the policy.
 */
export type {SearchPolicySettings};

/**
 * How an action refuses to be taken.
 *
 * `undefined` means take it. `'below-threshold'` is the new one — the policy
 * decided this action is not worth offering, and did so before the model could
 * ask for it. `'repeat'` is the old one, unchanged in meaning: this exact call
 * has already been made too many times in this turn to be worth making again.
 *
 * They are separate kinds rather than one refusal sentence because they are
 * different failures with different fixes. A repeat is the model looping and the
 * model can stop; a pruned action is the controller's own opinion and only the
 * user can revisit it.
 */
export type RefusalKind = 'below-threshold' | 'repeat';

export interface Refusal {
  kind: RefusalKind;
  /** What to tell the model, phrased as a tool result rather than as instruction. */
  message: string;
}

/**
 * One action the controller may take, and everything known about it.
 *
 * `visits` and `meanReward` are the two sufficient statistics of this action's
 * history, and they are supplied rather than computed here so that the same
 * policy serves the live turn — where they come from a map this turn has been
 * filling — and the replay, where they are folded out of a recorded tree.
 *
 * Only *allowed* visits count. An action the policy withheld was never tried, so
 * its reward is unknown rather than bad, and counting a refusal as a zero would
 * make pruning self-reinforcing: prune an action once, its mean falls, and it is
 * pruned for the rest of the turn on evidence that consists entirely of the
 * pruning. `seen` counts what the model proposed, including what was withheld,
 * which is what tells the two apart for the exploration term.
 */
export interface ActionStat {
  /** The tool name. The unit a policy decides about, not an individual call. */
  action: string;
  /** How many times this action ran. Refusals are not visits. */
  visits: number;
  /** Mean reward over those visits, on [-1, 1]. Zero when there are none. */
  meanReward: number;
  /**
   * How many times this action was proposed, run or not.
   *
   * Used for one thing: a call that repeats often enough stops being worth
   * making. That count has to include refusals or the rule cannot fire — a
   * refusal that did not count as an attempt would leave the model free to ask
   * forever.
   */
  attempts: number;
}

/**
 * The step controller.
 *
 * Constructed from the two settings and nothing else, so it can be built in a
 * unit test, in the plugin, and once per candidate setting in the replay. The
 * instance holds no history of its own: history is passed to `score` on every
 * call, which is what lets one policy object serve a whole replay where the
 * history is a different tree on every iteration.
 */
export class SearchPolicy {
  /**
   * The repeat count that is refused rather than run.
   *
   * Three, and it is a default rather than a setting, which is a decision worth
   * stating: it is the number `RepeatedToolCallPlugin` has always used, and the
   * note there explains why — the second identical call is allowed through
   * because a repeat is sometimes legitimate, and the third is refused because
   * by then it is a loop. Promoting it to a setting would be a fifth knob whose
   * effect nobody can measure yet; the replay is what would justify it, and the
   * replay does not score repeat counts.
   */
  readonly refuseRepeatAt: number;

  constructor(
    private readonly settings: SearchPolicySettings,
    options: {refuseRepeatAt?: number} = {},
  ) {
    this.refuseRepeatAt = options.refuseRepeatAt ?? 3;
  }

  /** The exploration weight, for a caller that has to record what it ran under. */
  get explorationWeight(): number {
    return this.settings.explorationWeight;
  }

  /** The pruning threshold, recorded beside it for the same reason. */
  get pruningThreshold(): number {
    return this.settings.pruningThreshold;
  }

  /**
   * How attractive one action is, given everything tried so far.
   *
   * Higher is better and the scale is reward-shaped, so a score and a mean
   * reward can be compared — which is what makes the pruning threshold readable
   * as a statement about reward rather than about an internal number whose
   * meaning depends on the exploration weight.
   */
  score(
    stat: ActionStat,
    /**
     * Total visits across every action in this step, which is the `N` in the
     * exploration term. Called `total` rather than `visits` because it is a fact
     * about the step and not about this action, and confusing the two is how the
     * bonus ends up rewarding the wrong thing.
     */
    total: number,
  ): number {
    if (stat.visits === 0) {
      /*
       * Untried. Not infinity — see the note at the top of the file — and not
       * zero either, which would mean an untried action is worthless and the
       * controller could never discover anything. The weight is the honest
       * answer: "this is how much an unknown action is worth to me".
       */
      return this.settings.explorationWeight;
    }

    /*
     * `ln(total)` with `total` at least the visits of this action, so the
     * logarithm is never of less than one. A replay can legitimately ask about a
     * step where the total is smaller than a single action's count — a tree
     * recorded before some other action was tried — and `ln` of a fraction is
     * negative, which would turn the exploration bonus into a penalty for having
     * been tried. The clamp keeps the term non-negative, which is the property
     * that makes it an exploration bonus rather than a correction.
     */
    const bonus =
      this.settings.explorationWeight *
      Math.sqrt(Math.log(Math.max(1, total)) / stat.visits);

    return stat.meanReward + bonus;
  }

  /**
   * Which of the offered actions survive, best first.
   *
   * Returns the input filtered and sorted rather than a single winner, because
   * the model chooses between the actions rather than being told one — the
   * policy narrows the field and the model still decides. That is why this is a
   * tool-set filter and not an argmax: an argmax would replace the agent's
   * judgement with a reward table built from a handful of calls, which on a
   * four-billion-parameter model's first turn is no evidence at all.
   */
  rank(
    stats: readonly ActionStat[],
    options: {total?: number} = {},
  ): ActionStat[] {
    const total =
      options.total ?? stats.reduce((sum, stat) => sum + stat.visits, 0);
    return [...stats]
      .filter((stat) => this.survives(stat))
      .sort((left, right) => {
        const difference = this.score(right, total) - this.score(left, total);
        /*
         * Ties broken by name rather than left to the sort's stability, so that
         * two replays of one log produce byte-identical output. A replay whose
         * result depends on array order is a replay nobody can diff.
         */
        return difference !== 0 ? difference : compareNames(left, right);
      });
  }

  /**
   * Whether one action is still worth offering the model.
   *
   * The rule is deliberately about *evidence* rather than about the score: an
   * action is pruned when it has been tried and its mean reward is below the
   * threshold. An action nobody has tried has no evidence against it and is never
   * pruned, whatever the threshold — otherwise a threshold of `0`, which is the
   * setting worth measuring, would remove every tool the turn has not used yet,
   * including the one the turn needs.
   */
  survives(stat: ActionStat): boolean {
    if (stat.visits === 0) {
      return true;
    }
    return stat.meanReward >= this.settings.pruningThreshold;
  }

  /**
   * Whether one action may be taken, or why not.
   *
   * The single entry point the live plugin uses, so that the two rules — the
   * repeat limit this class inherited and the threshold it adds — are decided in
   * one place and cannot be applied in one order live and another in a replay.
   *
   * `repeats` is how many times *this exact call* has been made, and it is
   * deliberately not `stat.attempts`. The two are different numbers and confusing
   * them is a real bug rather than a tidiness question: attempting `read_file`
   * three times with three different paths is a model doing its job, while
   * attempting it three times with one path is a loop. `attempts` counts the
   * action; this counts the call.
   *
   * Order matters and this is the order: the repeat rule is checked first, so a
   * call the model has already made three times is reported as a repeat rather
   * than as something the controller withheld. The model can act on the first
   * message and cannot act on the second — one says "stop doing that", the other
   * says "you are not allowed" — and a loop is the case where the actionable
   * sentence is the one worth sending.
   */
  decide(
    stat: ActionStat,
    options: {
      /** How many times this exact call has been attempted, including now. */
      repeats: number;
    },
  ): Refusal | undefined {
    if (options.repeats >= this.refuseRepeatAt) {
      return {
        kind: 'repeat',
        message:
          `[repeated call] Refused: \`${stat.action}\` has now been called ` +
          `${options.repeats} times in this turn with identical arguments, and ` +
          'the result will not change. Stop calling tools and reply to the user ' +
          'with the information you already have. If you cannot answer from it, ' +
          'say what is missing and ask for it.',
      };
    }

    if (!this.survives(stat)) {
      return {
        kind: 'below-threshold',
        message:
          `[withheld] \`${stat.action}\` is not being offered: it has been ` +
          `tried ${stat.visits} time(s) in this turn and averaged ` +
          `${stat.meanReward.toFixed(2)}, below this session's pruning ` +
          'threshold. Use a different tool, or reply with what you already have.',
      };
    }

    return undefined;
  }
}

/**
 * A stable ordering for two actions with the same score.
 *
 * Written out rather than left to `Array.prototype.sort`, whose stability is a
 * guarantee about *equal* comparisons and not about the comparator returning
 * numbers that differ in the last bit. `localeCompare` is deliberately not used:
 * it is locale-dependent, so the same log could replay differently on two
 * machines.
 */
function compareNames(left: ActionStat, right: ActionStat): number {
  return left.action < right.action ? -1 : left.action > right.action ? 1 : 0;
}

/**
 * Folds a list of observed rewards into the statistics the policy reads.
 *
 * The join between "what happened" and "what is known". Written here, beside the
 * policy, rather than in either caller, so that the live turn's running counts
 * and the replay's folded counts are produced by one function — the failure this
 * prevents is subtle and one-directional: a live turn that counted refusals as
 * visits would prune more aggressively than the replay predicts, so the setting
 * a user measured would not be the setting they got.
 */
export function actionStats(
  observations: readonly {
    action: string;
    reward?: number;
    /** Whether the call ran. False for a withheld proposal. */
    ran: boolean;
  }[],
): ActionStat[] {
  const byAction = new Map<
    string,
    {visits: number; reward: number; attempts: number}
  >();

  for (const observation of observations) {
    const entry = byAction.get(observation.action) ?? {
      visits: 0,
      reward: 0,
      attempts: 0,
    };
    entry.attempts += 1;
    if (observation.ran) {
      entry.visits += 1;
      entry.reward += observation.reward ?? 0;
    }
    byAction.set(observation.action, entry);
  }

  return [...byAction.entries()].map(([action, entry]) => ({
    action,
    visits: entry.visits,
    // Zero rather than NaN for an action never run: a mean over no observations
    // is undefined, and a NaN in a comparison silently makes every threshold
    // test false, which would read as "never prune" for the wrong reason.
    meanReward: entry.visits === 0 ? 0 : entry.reward / entry.visits,
    attempts: entry.attempts,
  }));
}
