/**
 * The tree recorder: what the agent did, as a parent-child log.
 *
 * A turn is a search. The model proposes an action, the controller decides
 * whether it may be taken, the tool answers, and the turn either continues or
 * ends. Recorded as a tree rather than as a transcript, that sequence says
 * something a transcript cannot: *which* branch was worth taking. A transcript
 * shows one path through the work and has no way to represent the actions that
 * were considered and refused, which are exactly the ones a policy change would
 * have allowed.
 *
 * Three decisions shape this file.
 *
 * **A proposal and its execution are two nodes.** The model asking for
 * `read_file` and `read_file` running are different events — between them sits
 * the entire policy — and collapsing them loses the only measurement the feature
 * has. When pruning withholds a call, the proposal is written with
 * `allowed: false` and a `call` node follows it carrying the refusal's reward and
 * no result: the action was considered and not taken, which is visible in the
 * tree rather than inferred from a gap.
 *
 * **Writes are snapshots, appended one per line.** Every flush appends the whole
 * tree as one line rather than rewriting a file or mutating a JSON object in
 * place. That costs bytes and buys the only property that matters for a document
 * written while a turn is running: a process killed mid-turn leaves a prefix of
 * complete lines, so the log is readable up to the last thing that actually
 * happened. An in-place rewrite would leave a truncated object that parses as
 * nothing, and the turn most worth replaying is the one that crashed.
 *
 * **A flush happens when a decision is resolved, not when a node is added.** The
 * two nodes of one call are written together, once the tool has answered, so the
 * snapshot on disk is never a proposal without its outcome — a reader taking the
 * last line always gets a complete step. That is also what keeps the write count
 * to a handful per turn instead of one per node: the sink is the runtime's, and
 * it is the sink that decides how those snapshots reach a file.
 *
 * **Nothing here throws into the caller.** Every method is called from inside a
 * tool callback or the host's event loop, where an exception does not fail the
 * recording — it fails the tool call, and the user sees the agent break because
 * it was taking notes. The sink is handed every snapshot and its own failures are
 * its own; this class tracks the tree and hands it over.
 */
import {randomUUID} from 'node:crypto';

import type {
  DreamNode,
  DreamReward,
  DreamTree,
  SearchPolicySettings,
} from '@marimo/protocol';
import {dreamTreeSchema} from '@marimo/protocol';

import {describeResult} from './reward.js';

/**
 * Where a finished tree goes.
 *
 * An interface rather than a path, because the recorder must not know about the
 * filesystem. `packages/agent` is imported by the window and by the headless
 * runner, and a recorder that opened files itself would be a second thing that
 * has to resolve the same user-data directory in both — which is the class of bug
 * this repository already lists as an invariant. The runtime owns the path and
 * hands over a sink; a test hands over an array.
 */
export interface DreamSink {
  /**
   * One complete snapshot of one turn's tree.
   *
   * Called in order and never concurrently for one turn — one turn at a time is
   * an invariant of the app. A sink that cannot keep up is expected to buffer; a
   * sink that throws is expected to have been written not to.
   */
  append(tree: DreamTree): void;
}

/** What the host hands over when a turn starts. */
export interface TurnContext {
  sessionId: string;
  invocationId: string;
  profileId?: string;
  policy: SearchPolicySettings;
}

/**
 * One turn's tree, as it is being built.
 *
 * Constructed when the host learns the invocation id — the first event of a turn,
 * and the only name a turn has — and completed when the turn ends. The host owns
 * one of these per turn and calls the methods below in the order the events
 * arrive; every method that has nothing to do is safe to call, so the host's call
 * sites do not have to guard.
 */
export class TreeRecorder {
  private readonly nodes: DreamNode[] = [];
  /** By id, so a child's depth is a lookup rather than a scan of the tree. */
  private readonly byId = new Map<string, DreamNode>();
  /** The turn root, which is the parent of the first model step. */
  private readonly rootId: string;
  /** The chain of steps, innermost last: the parent of what happens next. */
  private readonly stepStack: string[] = [];
  private outcome: DreamTree['outcome'] = 'open';
  private readonly startedAt: string;

  constructor(
    private readonly context: TurnContext,
    private readonly sink: DreamSink,
    private readonly options: {
      /**
       * Bytes of a tool result to keep.
       *
       * Read once at construction rather than per node, because it is a setting
       * and a setting that changed mid-turn would produce a tree whose nodes were
       * capped two different ways — which is exactly the kind of inconsistency a
       * replay would faithfully reproduce and a reader could not explain.
       */
      resultBytes: number;
      /** Injected so a test can produce a deterministic document. */
      now?: () => Date;
    },
  ) {
    this.startedAt = this.timestamp();
    this.rootId = this.add({kind: 'turn', parentId: undefined, tool: undefined});
  }

  /**
   * The id of the turn's root, for a caller that has to name the tree.
   *
   * Exposed because the host writes the tree's identity into its own log line,
   * and re-deriving it from `nodes[0]` in the caller would be a second place that
   * knows the first node is the root.
   */
  get id(): string {
    return this.rootId;
  }

  /** How many nodes have been recorded, for a caller deciding whether to write. */
  get size(): number {
    return this.nodes.length;
  }

  /**
   * One model request: the step whose children are the actions it proposed.
   *
   * Called once per request, including the first, so a turn with three requests
   * has three step nodes under its root and the proposals hang from those rather
   * than all from the root. That structure is what makes "how deep did this turn
   * go" a question about the tree instead of a count of children.
   *
   * Not flushed: a step exists as soon as the request does, and a snapshot taken
   * here would record a request whose answer has not arrived. The flush that
   * matters is the one when the step resolves.
   */
  step(): string {
    const parent = this.stepStack.at(-1) ?? this.rootId;
    const id = this.add({kind: 'turn', parentId: parent, tool: undefined});
    this.stepStack.push(id);
    return id;
  }

  /**
   * The model asked for a tool call, and the policy has not decided yet.
   *
   * Returns the id of the proposal, which the caller hands back to
   * {@link recordCall} or {@link recordRefusal}. The parent is the current step,
   * so proposals from one model response are siblings — which is what a model
   * emitting two calls at once actually produced.
   *
   * Not flushed, for the reason `step` is not: a proposal is half of a decision.
   */
  propose(params: {
    tool: string;
    callId?: string;
    args?: Record<string, unknown>;
    allowed: boolean;
  }): string {
    const parent = this.stepStack.at(-1) ?? this.rootId;
    return this.add({
      kind: 'propose',
      parentId: parent,
      tool: params.tool,
      ...(params.callId === undefined ? {} : {callId: params.callId}),
      ...(params.args === undefined ? {} : {args: params.args}),
      allowed: params.allowed,
    });
  }

  /**
   * The tool set the model was offered at the current step.
   *
   * Written on the step node rather than as a node of its own, because it is a
   * property of a step rather than an event in it — and because the alternative,
   * one node per tool per step, would triple the size of a log to record a list
   * that is usually identical to the one before it.
   *
   * Why it is recorded at all is the whole reason the replay can say anything
   * about pruning: a tool removed from the menu leaves no proposal behind, since
   * the model cannot ask for what it was not offered. Without this, a policy that
   * withheld everything would produce an empty tree and look identical to a turn
   * where nothing happened.
   */
  offer(tools: readonly string[]): void {
    const current = this.stepStack.at(-1);
    if (current === undefined) {
      return;
    }
    const node = this.byId.get(current);
    if (node === undefined) {
      return;
    }
    /*
     * Kept in the order it arrived rather than sorted. The set is what matters —
     * `SearchPolicy.rank` orders by score and breaks ties by name, so no
     * decision depends on this array's order — and sorting here would be a sort
     * whose result nothing reads, while making the log say something the model
     * was not actually offered.
     *
     * Mutated in place rather than replaced, so the parent link a child already
     * holds stays valid. The node is ours and nothing outside this class reads it
     * before `snapshot` copies it out.
     */
    node.offered = [...tools];
  }

  /**
   * The model produced text rather than a call.
   *
   * Recorded as its own node for one reason: without it, a turn that ended in an
   * answer and a turn that ended in silence have identical trees, and the silent
   * turn is the failure this app keeps a whole guard for. The log has to be able
   * to tell them apart, or the replay cannot report that a policy reduced them.
   */
  answer(text: string): void {
    const parent = this.stepStack.at(-1) ?? this.rootId;
    this.add({
      kind: 'answer',
      parentId: parent,
      tool: undefined,
      result: truncate(text, this.options.resultBytes).text,
    });
    this.flush();
  }

  /**
   * A proposal was refused, so nothing ran.
   *
   * A `call` node with no result and a negative reward, rather than a flag on the
   * proposal, so that a reader counting calls and a policy folding rewards both
   * see the refusal where they are already looking. The `allowed: false` on the
   * proposal is what distinguishes "refused" from "tried and failed" — both score
   * `-1`, and only one of them is evidence about the tool.
   */
  recordRefusal(params: {
    proposalId: string;
    tool: string;
    callId?: string;
    reward: DreamReward;
  }): void {
    this.add({
      kind: 'call',
      parentId: params.proposalId,
      tool: params.tool,
      ...(params.callId === undefined ? {} : {callId: params.callId}),
      reward: params.reward,
      /*
       * Kept empty rather than filled with the refusal sentence: that sentence is
       * what the *model* was told, and the policy regenerates it on every replay.
       * Storing it would put one version's wording into the record of a decision
       * a later version would word differently.
       */
      result: '',
      allowed: false,
    });
    this.flush();
  }

  /**
   * A tool call finished, and this is what came back.
   *
   * The result is capped and its true length recorded beside it, so a node that
   * is not the whole story says so. Invisible truncation is the failure this
   * app's rules name explicitly for tool results, and a log is a tool result that
   * has been through several more hands.
   */
  recordCall(params: {
    proposalId: string;
    tool: string;
    callId?: string;
    result: unknown;
    reward: DreamReward;
  }): void {
    const described = describeResult(params.result);
    const capped = truncate(described, this.options.resultBytes);
    this.add({
      kind: 'call',
      parentId: params.proposalId,
      tool: params.tool,
      ...(params.callId === undefined ? {} : {callId: params.callId}),
      result: capped.text,
      resultBytes: described.length,
      reward: params.reward,
      allowed: true,
    });
    this.flush();
  }

  /**
   * How the turn ended.
   *
   * `'open'` is not something a caller passes: a tree still being written is the
   * absence of an ending. The host calls this exactly once, on the way out of the
   * turn, whichever way the turn went.
   */
  finish(outcome: Exclude<DreamTree['outcome'], 'open'>): void {
    this.outcome = outcome;
    this.flush();
  }

  /**
   * Writes the current tree out, whatever state it is in.
   *
   * Public because a caller may want a tree durable without the turn being over,
   * and because a turn abandoned by a crash is better represented by its last
   * flush than by nothing.
   */
  flush(): void {
    this.sink.append(this.snapshot());
  }

  /**
   * The tree as it stands, validated before it leaves.
   *
   * Parsed through the schema rather than cast, and that is a deliberate cost:
   * this document is the input to a replay, so a tree that does not validate is
   * one a replay would read *wrongly* rather than refuse — and a silently misread
   * tree produces a policy comparison that is simply wrong. A parse failure here
   * is a bug in this file, and it should surface where the node is built rather
   * than a week later in an offline report.
   */
  snapshot(): DreamTree {
    return dreamTreeSchema.parse({
      version: 1,
      sessionId: this.context.sessionId,
      ...(this.context.profileId === undefined
        ? {}
        : {profileId: this.context.profileId}),
      invocationId: this.context.invocationId,
      startedAt: this.startedAt,
      outcome: this.outcome,
      policy: {
        explorationWeight: this.context.policy.explorationWeight,
        pruningThreshold: this.context.policy.pruningThreshold,
      },
      nodes: this.nodes,
    });
  }

  /**
   * Adds one node to the tree in memory.
   *
   * Deliberately not a flush. Adding a node is half of an event — a proposal
   * without its call, a step without its answer — and the callers that complete
   * an event are the ones that flush. See the note at the top of the file.
   */
  private add(params: {
    kind: DreamNode['kind'];
    parentId: string | undefined;
    tool: string | undefined;
    callId?: string;
    args?: Record<string, unknown>;
    result?: string;
    resultBytes?: number;
    reward?: DreamReward;
    allowed?: boolean;
  }): string {
    const id = randomUUID();
    const parent = params.parentId;
    const parentNode =
      parent === undefined ? undefined : this.byId.get(parent);
    const node: DreamNode = {
      id,
      ...(parent === undefined ? {} : {parentId: parent}),
      kind: params.kind,
      depth: parentNode === undefined ? 0 : parentNode.depth + 1,
      invocationId: this.context.invocationId,
      ...(params.tool === undefined ? {} : {tool: params.tool}),
      ...(params.callId === undefined ? {} : {callId: params.callId}),
      ...(params.args === undefined ? {} : {args: params.args}),
      ...(params.result === undefined ? {} : {result: params.result}),
      ...(params.resultBytes === undefined
        ? {}
        : {resultBytes: params.resultBytes}),
      ...(params.reward === undefined ? {} : {reward: params.reward}),
      allowed: params.allowed ?? true,
      at: this.timestamp(),
    };
    this.nodes.push(node);
    this.byId.set(id, node);
    return id;
  }

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

/**
 * The head of a string, with the cap visible when it bites.
 *
 * The marker is not decoration. A reader — a person or a replay — comparing two
 * nodes has to be able to see that one of them is not the whole result, and a
 * silent cut produces a node that looks like a short answer. `resultBytes` beside
 * it carries the true length, so the marker says *that* it was cut and the field
 * says from how much.
 */
export function truncate(
  text: string,
  limit: number,
): {text: string; truncated: boolean} {
  if (limit <= 0) {
    return {text: '', truncated: text.length > 0};
  }
  if (text.length <= limit) {
    return {text, truncated: false};
  }
  return {text: `${text.slice(0, limit)}…`, truncated: true};
}
