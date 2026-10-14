/**
 * The step controller, wired into a turn that is actually running.
 *
 * `search.ts` decides; this file is how the decision reaches the agent. It is the
 * ADK plugin the host registers, and it does two jobs that are two halves of one
 * thing:
 *
 *   `beforeToolSelection`  narrows the tool set the model is *offered*, from the
 *                          statistics this turn has accumulated.
 *   `beforeToolCallback`   refuses a call the policy will not allow, and records
 *                          what was refused so the next decision knows.
 *
 * The first is the real pruning and the second is the safety net, and it is worth
 * being clear about why both exist. `beforeToolSelection` is load-bearing because
 * it changes what the model can see: a pruned tool is not merely refused, it is
 * absent, so the model spends no tokens proposing it and the turn spends no round
 * trip being told no. `beforeToolCallback` then catches what the first cannot — a
 * call already in flight when the statistics changed, and the repeat rule, which
 * is about a specific call rather than about the tool set. Neither hook alone is
 * sufficient, and the alternative to having both is a model that keeps asking for
 * something the controller has already decided against.
 *
 * ## What this replaced, and what it kept
 *
 * The repeat rule used to live in `RepeatedToolCallPlugin`: count identical calls
 * per invocation, warn on the second, refuse the third. The requirement was that
 * existing logic not be rewritten where it does not need to be, and it does not:
 * the counting, the fingerprint, the escalation and the wording all survive, and
 * `SearchPolicy` now makes the decision they feed. What changed is that the count
 * is one of the inputs to a decision rather than the whole of it — an action that
 * has failed three times and an action that is merely a repeat are both reasons
 * not to take a step, and a controller that could see only the second was blind
 * to the more common one.
 *
 * `RepeatedToolCallPlugin` is untouched and is what runs when the feature is off,
 * so a user who never turns Dream-RSI on runs byte-identical code.
 */
import {BasePlugin, REQUEST_CONFIRMATION_FUNCTION_CALL_NAME} from '@google/adk';
import type {BaseTool, Context, LlmResponse} from '@google/adk';

import type {DreamReward} from '@marimo/protocol';

import {callFingerprint} from './call-fingerprint.js';
import type {TreeRecorder} from './recorder.js';
import {REWARD_REASONS, rewardForResult, rewardOf} from './reward.js';
import {SearchPolicy} from './search.js';
import type {ActionStat, Refusal, SearchPolicySettings} from './search.js';

/**
 * The warning a second identical call earns.
 *
 * Kept from the rule this replaced, and kept at all because of what it is: a tool
 * result is the one channel a small model reliably reads — it is a function
 * response rather than more instruction — so the escalation that actually stops a
 * loop is the one delivered there. The wording names what happened, says a repeat
 * returns the same thing, and offers three ways out.
 */
export function repeatWarning(name: string, count: number): string {
  return (
    `[repeated call] This is call ${count} of \`${name}\` in this turn with the ` +
    'same arguments. A repeat returns the same result, so calling it again is ' +
    'wasted work. Use different arguments, call a different tool, or reply to ' +
    'the user with what you already have.'
  );
}

/**
 * What one turn knows: its policy, its recorder, and what it has watched happen.
 *
 * Per invocation, because that is the unit the statistics are about — a turn.
 * Carrying an action's reward across turns would mean a tool that failed once in
 * a conversation about something else is pruned in the next question, which is a
 * controller that never recovers from one bad call.
 */
interface TurnState {
  policy: SearchPolicy;
  recorder: TreeRecorder;
  /**
   * Tool name → what this turn has seen of it.
   *
   * Keyed by tool rather than by call, because that is the unit a policy decides
   * about: "is `web_search` worth offering" is a question about the tool, while
   * "has this exact call been made" is a different question answered by
   * `attempts` below.
   */
  stats: Map<string, TurnStat>;
  /**
   * Proposal id by ADK's call id, so a finished call attaches to its own parent.
   *
   * ADK's `Context.functionCallId` is the same value in both callbacks — see the
   * `id` it writes into the function response event — so this is a real
   * correlation rather than a guess. Pairing on the tool name and arguments
   * instead would work almost always and fail exactly when a model emits two
   * calls to one tool in one response, which is the case a tree is most
   * interesting for.
   */
  proposals: Map<string, string>;
  /**
   * Call fingerprint → how many times *that exact call* has been attempted.
   *
   * Separate from `stats.attempts`, which counts the tool. The repeat rule is
   * about a loop — the same call with the same arguments — while the policy is
   * about an action, and a single counter cannot answer both: `read_file` twice
   * with different paths is two attempts at one action and no repeat at all.
   */
  repeats: Map<string, number>;
  /**
   * Whether a step has been opened for the request now in flight.
   *
   * Both `beforeModelCallback` and `beforeToolSelection` fire once per request
   * and their order is not part of ADK's contract, so whichever arrives first
   * opens the step and sets this. The next request's response clears it.
   */
  stepped: boolean;
}

interface TurnStat {
  /** How many times this action ran. Refusals are not visits. */
  visits: number;
  /** Total reward over those visits, summed rather than averaged. */
  reward: number;
  /** How many times it was proposed, run or not. The repeat rule reads this. */
  attempts: number;
}

/**
 * How many turns' worth of state to keep.
 *
 * A turn is one invocation and this app runs one at a time, so the live entry is
 * the only one that matters. The bound exists so a long-lived window cannot grow
 * a map forever one turn at a time; the oldest is dropped, which is always a
 * finished turn because insertion order is turn order.
 */
const REMEMBERED_INVOCATIONS = 8;

export interface DreamToolPluginOptions {
  /**
   * The recorder for one invocation, made if this is the first callback of the
   * turn to ask for one.
   *
   * A builder rather than a lookup, and that is the fix for a bug worth naming.
   * It used to be a lookup into a map the *host* filled when the first event of
   * the turn arrived — and a model request happens before any event does, so on
   * the first step of every turn there was nothing in the map and the step was
   * silently never recorded: no `step` node, no proposals, no refusals. A turn
   * that proposed a tool and then answered recorded a tree beginning with the
   * *second* request, and the replay read a turn nobody had.
   *
   * A plugin callback is where the invocation id first exists, and the context
   * it is handed carries the session id as well — so the plugin can ask for a
   * recorder at exactly the moment one is needed, while the host keeps ownership
   * of the sink, the path and the policy. `undefined` still means "this turn is
   * not being watched", which is the feature being off.
   */
  openRecorder: (context: {
    invocationId: string;
    sessionId: string;
  }) => TreeRecorder | undefined;
  /**
   * The policy settings in force *now*.
   *
   * Read per turn rather than captured at construction, for the reason the host
   * reads its own config per request: a user who moves the exploration slider
   * while the agent is thinking should get the new weight on the next turn, and a
   * plugin holding a copy from startup would hold the old one until the app
   * restarted.
   */
  settings: () => SearchPolicySettings;
  /** Injected so a test can produce deterministic output. */
  now?: () => Date;
}

/**
 * The plugin the runner registers when Dream-RSI is on.
 *
 * Registered *instead of* `RepeatedToolCallPlugin`, not beside it. Two plugins
 * both deciding whether a call may proceed would be two answers to one question,
 * and the first to return a value short-circuits the rest — so which one won
 * would depend on registration order rather than on anything anybody chose.
 */
export class DreamToolPlugin extends BasePlugin {
  private readonly turns = new Map<string, TurnState>();

  constructor(private readonly options: DreamToolPluginOptions) {
    super('dream_search_policy');
  }

  /**
   * One model request is about to be made, so a step begins.
   *
   * This hook is the only place a *request* is visible to a plugin — it is
   * invoked by the request processor that also does the pruning — and a step is
   * exactly a request. Recording it here rather than in the host's event loop is
   * what keeps the plugin self-contained: the host constructs a recorder and
   * finishes it, and everything between is the plugin's, which means there is one
   * place that knows the shape of a tree.
   */
  override async beforeModelCallback(params: {
    callbackContext: Context;
  }): Promise<undefined> {
    const state = this.turn(params.callbackContext);
    if (state === undefined || state.stepped) {
      return undefined;
    }

    /*
     * Once per request, not once per tool selection. Both callbacks fire per
     * request and their order is not something to depend on, so a step is opened
     * only if this request has not already opened one — and the next request
     * clears the flag when its own response arrives.
     */
    state.stepped = true;
    /*
     * Wrapped, because this runs inside the model's own request path and a
     * recorder that threw here would fail the turn rather than the recording. The
     * user would see the agent break because it was taking notes.
     */
    try {
      state.recorder.step();
    } catch {
      // A tree that cannot be built is a tree nobody gets. The turn continues.
    }
    return undefined;
  }

  /**
   * The model answered rather than calling a tool.
   *
   * Worth a node for one reason: without it a turn that ended in an answer and a
   * turn that ended in silence have identical trees, and the silent turn is the
   * failure this app keeps a whole guard for. A replay that could not tell them
   * apart could not report that a policy reduced them.
   *
   * The `partial` guard is load-bearing. In SSE mode ADK callbacks this once per
   * streamed chunk, so an unguarded version would record a nine-word answer as
   * nine answer nodes — and the tree's own shape would then depend on how the
   * model happened to chunk its tokens. The final, non-partial response is
   * emitted once and carries the whole text.
   */
  override async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<undefined> {
    const {callbackContext, llmResponse} = params;
    if (llmResponse.partial === true) {
      return undefined;
    }

    const state = this.turn(callbackContext);
    if (state === undefined) {
      return undefined;
    }
    state.stepped = false;

    const parts = llmResponse.content?.parts ?? [];
    const calling = parts.some((part) => part.functionCall !== undefined);
    if (calling) {
      return undefined;
    }
    const text = parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text.length > 0) {
      try {
        state.recorder.answer(text);
      } catch {
        // Same rule as the step above: the recording never fails the turn.
      }
    }
    return undefined;
  }

  /**
   * Narrows the tools the model is offered, which is where pruning takes effect.
   *
   * Returns `undefined` when nothing is pruned, and that matters: the processor
   * only writes `allowedTools` when a plugin returns a record, and an empty record
   * is a *different* thing from no record — it is a request with no tools at all.
   * A turn that has just started must leave the model its full set, so the honest
   * answer for "I am pruning nothing" is to say nothing.
   */
  override async beforeToolSelection(params: {
    callbackContext: Context;
    tools: Readonly<Record<string, BaseTool>>;
  }): Promise<Readonly<Record<string, BaseTool>> | undefined> {
    const state = this.turn(params.callbackContext);
    if (state === undefined) {
      return undefined;
    }

    const offered = Object.keys(params.tools);
    /*
     * Every offered tool is a candidate, including ones this turn has not touched:
     * a tool with no history has no evidence against it and survives every
     * threshold. That is what makes an empty statistics map keep the whole set
     * rather than drop it.
     */
    const kept = state.policy
      .rank(offered.map((name) => statFor(name, state.stats)))
      .map((stat) => stat.action);
    const filtered: Record<string, BaseTool> = {};
    for (const name of kept) {
      const tool = params.tools[name];
      if (tool !== undefined) {
        filtered[name] = tool;
      }
    }

    /*
     * A turn with nothing left to offer falls back to the unfiltered set rather
     * than to an empty one. Returning `{}` would leave the model with no tools and
     * no explanation, which is the silent-turn failure this app already guards
     * against from the other end; the controller having run out of actions it
     * likes is not a reason to give the model a request it cannot answer.
     */
    const narrowed =
      Object.keys(filtered).length === 0
        ? offered
        : kept.filter((name) => params.tools[name] !== undefined);

    /*
     * The *unfiltered* set is what the tree records, and that is the single most
     * important line in this file.
     *
     * Recording what was actually offered would be the obvious thing and it would
     * quietly make the whole replay useless. A tool this policy pruned is absent
     * from the offered set, so a log built from it would say the tool did not
     * exist — and a replay could then never ask the one question the feature
     * exists to answer, which is what a *different* threshold would have offered.
     * Off-policy evaluation needs the whole action space the turn had, not the
     * part of it one setting approved of.
     *
     * So the log holds the world and the narrowing is left out of it. The `rank`
     * call above is still what decides the turn; this is what the turn is
     * measured against later.
     */
    state.recorder.offer(offered);

    return narrowed.length === offered.length ? undefined : filtered;
  }

  /**
   * Decides one call, and records it either way.
   *
   * The order of the three things here is the order they have to happen in.
   * Count first, because both rules read the count and a decision made before
   * counting would be about the previous call. Then decide. Then record, because
   * the tree's node says what the decision *was* — writing it before deciding
   * would require knowing the answer.
   */
  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const {tool, toolArgs, toolContext} = params;
    /*
     * Not counted and not recorded, exactly as the rule this replaced did not
     * count it. `adk_request_confirmation` is the model asking the user a
     * question, not the model calling a tool: the turn is pausing, not looping,
     * and two rounds of the same question are two different calls with two
     * different ids.
     */
    if (tool.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
      return undefined;
    }

    const callId = toolContext.functionCallId;
    const state = this.turn(toolContext);
    if (state === undefined) {
      return undefined;
    }

    const {stat, repeats} = this.count(state, tool.name, toolArgs);
    const refusal = state.policy.decide(stat, {repeats});

    if (refusal === undefined) {
      const proposalId = state.recorder.propose({
        tool: tool.name,
        ...(callId === undefined ? {} : {callId}),
        args: toolArgs,
        allowed: true,
      });
      if (callId !== undefined) {
        state.proposals.set(callId, proposalId);
      }
      return undefined;
    }

    const reward = refusalReward(refusal);
    const proposalId = state.recorder.propose({
      tool: tool.name,
      ...(callId === undefined ? {} : {callId}),
      args: toolArgs,
      allowed: false,
    });
    state.recorder.recordRefusal({
      proposalId,
      tool: tool.name,
      ...(callId === undefined ? {} : {callId}),
      reward,
    });
    /*
     * Returned as `error` rather than `result` on purpose: the call did not
     * happen, and marking it failed is what makes the window draw it as a call
     * that was refused instead of one that quietly returned something odd.
     */
    return {error: refusal.message};
  }

  /**
   * Scores what came back, and writes it to the tree under its proposal.
   *
   * Read, never counted: `beforeToolCallback` already counted this call, and
   * counting again here would make the second call look like the third — the bug
   * the rule this replaced carries a comment about, preserved deliberately.
   */
  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const {tool, toolContext, result} = params;
    if (tool.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
      return undefined;
    }

    const state = this.turn(toolContext);
    if (state === undefined) {
      return undefined;
    }

    const reward = rewardForResult(result);
    this.noteResult(state, tool.name, reward);

    const callId = toolContext.functionCallId;
    const proposalId =
      callId === undefined ? undefined : state.proposals.get(callId);
    if (proposalId !== undefined && callId !== undefined) {
      state.proposals.delete(callId);
      state.recorder.recordCall({
        proposalId,
        tool: tool.name,
        callId,
        result,
        reward,
      });
    }

    /*
     * The second identical call gets the warning appended — the escalation that
     * usually stops a loop one call before the refusal does. Deliberately still
     * delivered here rather than folded into the policy: that is a message to the
     * model, and the policy's job is to decide rather than to phrase.
     *
     * The result is passed through untouched when there is no warning. A tool
     * result is what the model acts on, and rewriting it is the one thing here
     * that could change behaviour rather than observe it.
     */
    const stat = state.stats.get(tool.name);
    const warning =
      stat !== undefined && stat.attempts === state.policy.refuseRepeatAt - 1
        ? repeatWarning(tool.name, stat.attempts)
        : undefined;

    return warning === undefined ? undefined : withWarning(result, warning);
  }

  /**
   * The policy and recorder for this invocation.
   *
   * Returns `undefined` when no recorder can be had, which is the feature being
   * off for this turn. Checked through the recorder rather than through a second
   * flag so there is one source of truth for "is this turn being watched" — and
   * the plugin being registered at all is already the outer answer.
   *
   * Takes the callback's `Context` rather than an id, because the two names a
   * recorder is built from — the invocation and the session — are both on it.
   * Deriving the session anywhere else would mean the host guessing which
   * conversation a turn belonged to, and it does not have to: ADK hands it to
   * every callback that can ask.
   */
  private turn(context: Context): TurnState | undefined {
    const invocationId = context.invocationId;
    const cached = this.turns.get(invocationId);
    if (cached !== undefined) {
      return cached;
    }

    const recorder = this.options.openRecorder({
      invocationId,
      sessionId: context.sessionId,
    });
    if (recorder === undefined) {
      return undefined;
    }

    const state: TurnState = {
      policy: new SearchPolicy(this.options.settings()),
      recorder,
      stats: new Map(),
      proposals: new Map(),
      repeats: new Map(),
      stepped: false,
    };
    this.turns.set(invocationId, state);
    while (this.turns.size > REMEMBERED_INVOCATIONS) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.turns.delete(oldest);
    }
    return state;
  }

  /**
   * Records one more attempt, and answers with both counts a decision needs.
   *
   * Two numbers rather than one, because the two rules genuinely read different
   * things. `repeats` is keyed by the call's fingerprint — the tool name and its
   * exact arguments — and is what the repeat rule reads. `stat` is folded over the
   * tool and is what the policy reads. A version of this that returned one
   * counter would refuse a model for calling `read_file` three times on three
   * different files, which is not a loop.
   */
  private count(
    state: TurnState,
    tool: string,
    args: Record<string, unknown>,
  ): {stat: ActionStat; repeats: number} {
    const entry = state.stats.get(tool) ?? {visits: 0, reward: 0, attempts: 0};
    const fingerprint = callFingerprint(tool, args);
    const repeats = (state.repeats.get(fingerprint) ?? 0) + 1;
    state.repeats.set(fingerprint, repeats);
    state.stats.set(tool, {...entry, attempts: entry.attempts + 1});
    return {stat: statFor(tool, state.stats), repeats};
  }

  /** Records that a call ran, and what it was worth. */
  private noteResult(
    state: TurnState,
    action: string,
    reward: DreamReward,
  ): void {
    const entry = state.stats.get(action) ?? {visits: 0, reward: 0, attempts: 0};
    state.stats.set(action, {
      ...entry,
      visits: entry.visits + 1,
      reward: entry.reward + reward.value,
    });
  }
}

/**
 * The statistics the policy reads for one action.
 *
 * A named function rather than a method, because a caller outside this file — a
 * test, and the offered-set filter above — needs the same answer, and a second
 * implementation would be a second answer to "how much has this action been
 * worth".
 *
 * An action with no entry is *untried*, not bad: zero visits, zero mean, zero
 * attempts, which `SearchPolicy` reads as "no evidence" and never prunes.
 */
export function statFor(
  action: string,
  stats: ReadonlyMap<string, TurnStat>,
): ActionStat {
  const entry = stats.get(action);
  if (entry === undefined) {
    return {action, visits: 0, meanReward: 0, attempts: 0};
  }
  return {
    action,
    visits: entry.visits,
    // Zero rather than NaN for an action never run: a mean over no observations
    // is undefined, and a NaN in a comparison makes every threshold test false —
    // which reads as "never prune" for entirely the wrong reason.
    meanReward: entry.visits === 0 ? 0 : entry.reward / entry.visits,
    attempts: entry.attempts,
  };
}

/**
 * The reward for a refusal, told apart by kind.
 *
 * Both are `-1` in value — a step that produced nothing is a step that produced
 * nothing — but they carry different reasons, and the reason is what a replay
 * groups by when it reports how much of a turn's budget each rule consumed. The
 * distinction matters more than the number.
 */
export function refusalReward(refusal: Refusal): DreamReward {
  return rewardOf(
    refusal.kind === 'repeat'
      ? REWARD_REASONS.repeated
      : REWARD_REASONS.withheld,
  );
}

/**
 * The result with the warning appended to whatever the model reads.
 *
 * The shape here is not the one the event ends up with. `result` is the value the
 * tool itself returned — for a `FunctionTool` that is the plain string its
 * `execute` produced — and ADK wraps it into `{result: ...}` afterwards. So a
 * string is the common case and has to be handled first: spreading one into an
 * object turns the text into character-indexed keys, which is what an earlier
 * version of this did and the test caught it replacing the result with nothing
 * but the warning.
 *
 * An `error` result keeps its key. A failed call reported as a success would
 * misdescribe what happened, and the model would act on a result it never got.
 */
function withWarning(
  result: unknown,
  warning: string,
): Record<string, unknown> | undefined {
  // A tool that threw has an error the caller is about to be told about, and a
  // warning about repetition is not worth overwriting it.
  if (result === undefined || result === null) {
    return undefined;
  }

  if (typeof result === 'string') {
    return result.length > 0
      ? {result: `${result}\n\n${warning}`}
      : {result: warning};
  }

  if (typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    for (const key of ['result', 'error', 'errorMessage'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return {...record, [key]: `${value}\n\n${warning}`};
      }
    }
    return {...record, result: warning};
  }

  return {result: warning};
}
