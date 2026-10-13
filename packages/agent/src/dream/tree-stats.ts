/**
 * Reading a discovery tree back into the two things a decision needs.
 *
 * A tree is what happened; a policy reads statistics and a step. This module is
 * the join, and it is deliberately the *only* join: the live turn folds its
 * running map through `actionStats` in `search.ts`, the replay folds a recorded
 * tree through the same function here, and both then call the same `SearchPolicy`.
 * One fold, two sources, and that is what makes an offline measurement a
 * statement about the online behaviour rather than a guess about it.
 *
 * The fold has one rule that is easy to get wrong and expensive when it is:
 * **a withheld proposal is an attempt and not a visit.** Attempts drive the
 * repeat rule, which has to see refusals or a model could ask forever. Visits
 * drive the reward estimate, and a withheld call has no reward — counting it as a
 * zero-reward visit would make pruning self-reinforcing, because the evidence for
 * pruning an action would be the pruning itself.
 */
import type {ActionStat} from './search.js';
import {actionStats} from './search.js';
import type {DreamNode, DreamTree} from '@marimo/protocol';

/**
 * One step of a turn, as the policy saw it when it had to decide.
 *
 * `candidates` is the whole field the model was choosing from at that moment, not
 * only the tool it picked, and that is the field a replay has to have: a policy
 * that prunes cannot be evaluated against a record of only the actions that were
 * taken, because every action it would have withheld is missing from the record
 * by construction. So a step carries what *was* available — recovered from the
 * turn's own history — alongside what was chosen and what came back.
 */
export interface RecordedStep {
  invocationId: string;
  /** The tool the model asked for, when it asked for one. */
  chosen?: string;
  /** What that call was worth, when it ran. Absent for a withheld proposal. */
  reward?: {value: number; reason: string};
  /** False when the policy withheld the proposal. */
  ran: boolean;
  /**
   * Every action the step was deciding between.
   *
   * This is the *menu*: the offered set when the log recorded one, and otherwise
   * the actions the turn has touched so far. It is the field a pruning policy is
   * measured against, because pruning removes things from the menu — including
   * tools the model never reached for, which is exactly the case a proposal list
   * cannot represent.
   */
  candidates: string[];
  /**
   * What this step attempted: one entry per call the model asked for.
   *
   * The field the *history* fold reads, and it is deliberately neither
   * `candidates` nor cumulative. Not `candidates`, because a policy's statistics
   * are about what happened — folding a whole menu would count every tool the
   * model was offered but never used as an attempt with no reward, dragging every
   * mean toward zero. Not cumulative across steps, because a caller asking "what
   * was known before step N" folds the prefix itself, and a list that already
   * contained the prefix would count the first call once, the second twice and
   * the third three times.
   *
   * A withheld step appears here too, with `ran: false` — it was an attempt, and
   * the repeat rule has to be able to see it.
   */
  attempted: {action: string; reward?: number; ran: boolean}[];
}

/** One turn, ready to replay. */
export interface RecordedTurn {
  sessionId: string;
  invocationId: string;
  /** The weights the turn actually ran under, which are the control to beat. */
  policy: {explorationWeight: number; pruningThreshold: number};
  outcome: DreamTree['outcome'];
  steps: RecordedStep[];
}

/**
 * Folds one tree into the ordered steps a replay walks.
 *
 * The order is the order of the `propose` nodes, which is the order the model
 * asked for things — not the order of the `call` nodes, which is the order the
 * policy allowed them. Those differ exactly when pruning fired, and it is the
 * model's order that a replay has to reproduce: a candidate policy cannot be
 * evaluated on a decision sequence that was itself produced by the policy being
 * replaced.
 *
 * Each step's `candidates` is built from the tools *this turn has touched so
 * far*, because that is what a live controller can know. It cannot see a tool the
 * model has not proposed yet, and a replay that let it would be measuring a
 * controller with knowledge the live one does not have.
 */
export function stepsOf(tree: DreamTree): RecordedStep[] {
  const callsByCallId = new Map<string, DreamNode>();
  for (const node of tree.nodes) {
    if (node.kind === 'call' && node.callId !== undefined) {
      callsByCallId.set(node.callId, node);
    }
  }

  /*
   * The offered set per step, when the log recorded one. A step node carries it,
   * so the lookup is by the proposal's parent — which is what makes this survive
   * a turn whose requests came in any order.
   */
  const offeredByStep = new Map<string, string[]>();
  for (const node of tree.nodes) {
    if (node.kind === 'turn' && node.offered !== undefined) {
      offeredByStep.set(node.id, node.offered);
    }
  }

  const proposals = tree.nodes
    .filter((node) => node.kind === 'propose')
    .sort(byRecordedOrder);

  /*
   * The actions the turn has touched, which is the whole menu for a log recorded
   * before the offered set existed. It grows as the turn does, because a live
   * controller cannot see a tool the model has not proposed yet and a replay must
   * not let it either.
   */
  const known = new Set<string>();
  const steps: RecordedStep[] = [];

  for (const proposal of proposals) {
    if (proposal.tool === undefined) {
      /*
       * A proposal with no tool is the model answering rather than calling
       * anything. It is not a step — there is no action to decide about — and it
       * is the signal that the turn is over.
       */
      continue;
    }
    known.add(proposal.tool);

    const call =
      proposal.callId === undefined
        ? undefined
        : callsByCallId.get(proposal.callId);

    const offered =
      proposal.parentId === undefined
        ? undefined
        : offeredByStep.get(proposal.parentId);

    steps.push({
      invocationId: tree.invocationId,
      chosen: proposal.tool,
      ...(call?.reward === undefined ? {} : {reward: call.reward}),
      // A proposal that was withheld has no call node at all, which is how the
      // two are told apart without a second flag to keep in step.
      ran: call !== undefined,
      candidates: [...(offered ?? known)].sort(),
      attempted: [
        {
          action: proposal.tool,
          ...(call?.reward === undefined ? {} : {reward: call.reward.value}),
          ran: call !== undefined,
        },
      ],
    });
  }

  return steps;
}

/**
 * The whole log as turns, ready to replay.
 *
 * A tree with no steps is dropped rather than kept as an empty turn. It is a real
 * shape — a turn that answered immediately, or one that failed before any tool
 * was called — and it would contribute nothing to a policy comparison except a
 * division by zero in an average.
 */
export function turnsOf(trees: readonly DreamTree[]): RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  for (const tree of trees) {
    const steps = stepsOf(tree);
    if (steps.length === 0) {
      continue;
    }
    turns.push({
      sessionId: tree.sessionId,
      invocationId: tree.invocationId,
      policy: tree.policy,
      outcome: tree.outcome,
      steps,
    });
  }
  return turns;
}

/**
 * The statistics a step's decision is made from.
 *
 * `upTo` is exclusive, so a caller asks "what was known *before* step N" rather
 * than "what is known including it". Off-by-one here is the difference between a
 * replay that reproduces the original decision and one that has already seen its
 * outcome — and the second is not obviously wrong, it just makes every policy
 * look better than it is.
 *
 * Folds `attempted` rather than `candidates`, because this is what happened
 * rather than what was on offer. See the note on `RecordedStep`.
 */
export function statsBefore(
  steps: readonly RecordedStep[],
  upTo: number,
): ActionStat[] {
  const observations: {action: string; reward?: number; ran: boolean}[] = [];
  for (const step of steps.slice(0, upTo)) {
    observations.push(...step.attempted);
  }
  return actionStats(observations);
}

/**
 * A stable order for nodes that share a timestamp.
 *
 * Timestamps are ISO strings from one process, so they are usually distinct; when
 * they are not — two proposals in one model response, written in the same
 * millisecond — the array order is the recorded order, and `sort` keeps it. This
 * exists so that is a decision rather than an accident of the sort implementation.
 */
function byRecordedOrder(left: DreamNode, right: DreamNode): number {
  return left.at < right.at ? -1 : left.at > right.at ? 1 : 0;
}
