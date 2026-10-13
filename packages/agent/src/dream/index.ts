/**
 * Dream-RSI: recording what the agent did, and searching it offline.
 *
 * The name is the paper's — *Recursive Self-Improvement through Evolving Worlds*
 * — and the part of it this package implements is the one that needs no second
 * model and no retraining: **a discovery tree recorded during real work is a
 * simulator of the search space that work explored**, so an exploration policy can
 * be scored against it offline, at the cost of reading a file.
 *
 * Three pieces, and the boundary between them is the design:
 *
 *   `TreeRecorder`   writes the tree. A parent-child log of what the model
 *                    proposed, what the policy allowed, and what came back.
 *   `SearchPolicy`   decides a step. Exploration weight and pruning threshold,
 *                    as a pure function of the history it is handed.
 *   `replay.ts`      re-decides the recorded turns under other settings, with no
 *                    model call and no tool call.
 *
 * `SearchPolicy` is pure on purpose and it is the load-bearing decision in the
 * whole feature. Because it takes history as an argument rather than reading it
 * from anywhere, the live turn and the offline replay call the *same function* —
 * so a setting measured offline is the setting that runs live, by construction
 * rather than by two implementations being kept in step. Everything that would
 * have made the score cleverer had to survive that constraint, which is why the
 * reward is an arithmetic function of the recorded result rather than a model's
 * opinion of it.
 *
 * The other boundary is in the other direction: nothing here touches the
 * filesystem. The recorder takes a `DreamSink`, because `packages/agent` runs in
 * both the window and the headless runner and a recorder that resolved its own
 * paths would be a second thing that has to agree about the user-data directory.
 * The runtime owns the path and implements the sink.
 */
export {callFingerprint, stable} from './call-fingerprint.js';
export {TreeRecorder, truncate} from './recorder.js';
export type {DreamSink, TurnContext} from './recorder.js';
export {describeResult, REWARD_REASONS, REWARD_VALUES, rewardForResult, rewardOf} from './reward.js';
export type {RewardReason} from './reward.js';
export {
  actionStats,
  SearchPolicy,
} from './search.js';
export type {
  ActionStat,
  Refusal,
  RefusalKind,
  SearchPolicySettings,
} from './search.js';
export {
  baselineOf,
  describeReport,
  replayTrees,
  replayTurn,
} from './replay.js';
export type {
  ReplayReport,
  ReplayTurnResult,
} from './replay.js';
export {statsBefore, stepsOf, turnsOf} from './tree-stats.js';
export type {RecordedStep, RecordedTurn} from './tree-stats.js';
export {
  DreamToolPlugin,
  refusalReward,
  repeatWarning,
  statFor,
} from './tool-plugin.js';
export type {DreamToolPluginOptions} from './tool-plugin.js';
