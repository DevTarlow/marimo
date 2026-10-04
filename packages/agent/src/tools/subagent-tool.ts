/**
 * Spawning a helper agent.
 *
 * A sub-agent is a *tool call*, not a second conversation. The parent asks for
 * one by name and task, the child runs, and what comes back is the tool result.
 * That framing decides almost everything below.
 *
 * **The child shares the parent's conversation.** This is not tidiness — it is
 * what makes approval work. A gate is recorded in the conversation it belongs to
 * and the window finds it by reading that conversation's log; a child writing to
 * its own session would ask a question nobody could see, and the turn would wait
 * for an answer that could never arrive. Sharing the session means a sub-agent's
 * `write_file` raises exactly the card a parent's would.
 *
 * **Depth is one, by construction.** The child is built without this tool, so
 * recursion is not something a runaway model can talk its way into. A depth limit
 * that is a number to compare is a limit that can be got wrong.
 *
 * **It is bounded three ways.** Steps, wall-clock time, and the size of what it
 * hands back. A sub-agent is the one part of a turn the user cannot watch
 * closely, so it is the one part that most needs a ceiling.
 */
import {Runner} from '@google/adk';
import type {BaseAgent, BaseSessionService, Context} from '@google/adk';
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import type {AgentUiEvent} from '@marimo/protocol';

/** What a spawned agent is allowed to be called. */
export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;

export interface SubagentLimits {
  /** How many events the child may produce before it is stopped. */
  maxSteps: number;
  /** How long it may take. */
  timeoutMs: number;
  /** How much of its answer may reach the parent. */
  maxResultChars: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  /*
   * Events, not turns: one child step is several events (a call, a result, some
   * text), so the number the model would recognise as "steps" is smaller than
   * this looks. Set generously enough that real work finishes and low enough
   * that a loop is caught.
   */
  maxSteps: 60,
  timeoutMs: 5 * 60_000,
  maxResultChars: 8_000,
};

/**
 * One child step, as this file needs to see it.
 *
 * A narrower shape than ADK's event on purpose: the tool reads the author and
 * the text and nothing else, and narrowing it here is what lets the whole of the
 * tool's behaviour — the limits, the attribution, the refusal — be tested
 * without a model, a runner or a provider.
 */
export interface SubagentEvent {
  author?: string;
  content?: {parts?: Array<{text?: string}>};
}

/** Runs a child agent and streams its steps. */
export type SubagentRun = (request: {
  agent: BaseAgent;
  /** The parent's session, so the child's gates land where they can be seen. */
  sessionService: BaseSessionService;
  sessionId: string;
  appName: string;
  userId: string;
  task: string;
  signal: AbortSignal;
}) => AsyncIterable<SubagentEvent>;

/** What the host gives the tool so it can build and follow a child. */
export interface SubagentDeps {
  /**
   * Builds the child.
   *
   * Injected rather than done here, because building an agent means knowing the
   * model, the key and the tool set — all of which belong to the host, and none
   * of which this file should have an opinion about.
   */
  build: (request: {name: string; task: string}) => BaseAgent;
  /** How the child's work reaches the window while it runs. */
  onEvent?: (event: AgentUiEvent) => void;
  limits?: Partial<SubagentLimits>;
  /**
   * How a child is run. Defaults to a real ADK `Runner` over the parent's
   * session; injected by the tests, which is the only reason those tests need no
   * provider.
   */
  run?: SubagentRun;
}

/** The tool's arguments. */
const parameters = z.object({
  name: z
    .string()
    .describe(
      'A short lowercase name for the helper, like "researcher" or ' +
        '"summariser". Used to label its work in the conversation.',
    ),
  task: z
    .string()
    .describe(
      'What the helper should do, in full. It cannot see this conversation, so ' +
        'write it as a complete instruction including anything it needs to know, ' +
        'and say what a good answer looks like.',
    ),
});

export function createSpawnAgentTool(deps: SubagentDeps): FunctionTool {
  const limits: SubagentLimits = {...DEFAULT_SUBAGENT_LIMITS, ...deps.limits};
  const run = deps.run ?? adkRun;

  return new FunctionTool({
    name: 'spawn_agent',
    description:
      'Hand a self-contained piece of work to a helper agent and get its answer ' +
      'back. Use it for work that is separable and would otherwise fill this ' +
      'conversation with detail — reading through many files, researching a ' +
      'question, drafting something long. The helper starts fresh: it cannot see ' +
      'this conversation, and it has the same tools and the same approval rules ' +
      'you do. It cannot ask you anything, so give it everything it needs in ' +
      '`task`. It cannot spawn helpers of its own.',
    parameters,
    execute: async (
      args: {name: string; task: string},
      toolContext?: Context,
    ): Promise<string> =>
      await runSubagent(args, toolContext, {deps, limits, run}),
  });
}

async function runSubagent(
  args: {name: string; task: string},
  toolContext: Context | undefined,
  parts: {deps: SubagentDeps; limits: SubagentLimits; run: SubagentRun},
): Promise<string> {
  const {deps, limits, run} = parts;
  const name = args.name.trim().toLowerCase();
  if (!SUBAGENT_NAME_PATTERN.test(name)) {
    /*
     * Refused rather than fixed up. The name is a label the user will read in
     * their conversation, and quietly rewriting what the model asked for is how
     * a transcript stops matching what happened.
     */
    return (
      `"${args.name}" is not a usable helper name. Use lowercase letters, ` +
      'digits and underscores, starting with a letter, up to 32 characters.'
    );
  }

  const task = args.task.trim();
  if (task.length === 0) {
    return 'A helper needs a task. Say what it should do.';
  }

  /*
   * Without an invocation there is no conversation to run inside, and no session
   * service to store the child's events in. Refused in words rather than thrown:
   * a tool that throws ends the parent's turn, which would turn "the helper
   * could not start" into "your whole request failed".
   */
  const invocation = toolContext?.invocationContext;
  const sessionService = invocation?.sessionService;
  if (invocation === undefined || sessionService === undefined) {
    return 'A helper cannot be started outside a conversation.';
  }
  const sessionId = invocation.session.id;

  /*
   * The child gets the same session service and the same session id, so its
   * events are stored beside the parent's and — the reason that matters — its
   * approval requests are visible to the window. A child in its own conversation
   * would ask a question nobody could see, and the turn would wait forever for
   * an answer that could never arrive.
   */
  const callId = toolContext?.functionCallId ?? name;
  const started = Date.now();
  const controller = new AbortController();

  deps.onEvent?.({
    type: 'subagent.started',
    sessionId,
    callId,
    name,
    task,
  });

  let steps = 0;
  let answer = '';
  let stopped: string | undefined;

  /* The parent's abort must reach the child, or "stop" leaves it running. */
  const relay = (): void => {
    controller.abort();
  };
  toolContext?.abortSignal?.addEventListener('abort', relay, {once: true});

  const timer = setTimeout(() => {
    stopped = `The helper ran for longer than ${describeDuration(limits.timeoutMs)} and was stopped.`;
    controller.abort();
  }, limits.timeoutMs);

  try {
    for await (const event of run({
      agent: deps.build({name, task}),
      sessionService,
      sessionId,
      appName: invocation.appName,
      userId: invocation.userId,
      task,
      signal: controller.signal,
    })) {
      steps += 1;
      const text = textOf(event);
      if (text.length > 0 && event.author === name) {
        answer = text;
      }

      /*
       * The child's words, as it writes them. Only its words: its tool calls are
       * in the stored conversation and in the parent's result, and forwarding a
       * second copy of the machinery would be a live view that says more than
       * the transcript it is a preview of.
       */
      if (text.length > 0 && event.author === name) {
        deps.onEvent?.({type: 'subagent.event', sessionId, callId, name, text});
      }

      if (steps >= limits.maxSteps) {
        stopped = `The helper used its whole budget of ${String(limits.maxSteps)} steps and was stopped.`;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    /*
     * A refusal from the provider is the ordinary way a child fails — no key, a
     * rate limit — and it is reported as the helper's answer rather than thrown.
     * A tool that throws ends the parent's turn, which would turn "the helper
     * could not start" into "your whole request failed".
     */
    if (stopped === undefined) {
      stopped = error instanceof Error ? error.message : String(error);
    }
  } finally {
    clearTimeout(timer);
    toolContext?.abortSignal?.removeEventListener('abort', relay);
    deps.onEvent?.({
      type: 'subagent.finished',
      sessionId,
      callId,
      name,
      ok: stopped === undefined,
      ms: Date.now() - started,
      ...(stopped === undefined ? {} : {error: stopped}),
    });
  }

  if (stopped !== undefined) {
    return `The helper "${name}" did not finish: ${stopped}`;
  }
  if (answer.trim().length === 0) {
    return `The helper "${name}" finished without producing an answer.`;
  }
  return truncate(answer.trim(), limits.maxResultChars);
}

function textOf(event: {content?: {parts?: Array<{text?: string}>}}): string {
  const parts = event.content?.parts ?? [];
  return parts
    .map((part) => part.text ?? '')
    .filter((text) => text.length > 0)
    .join('');
}

/** Cut to the ceiling, and say so — a silent cut reads as a complete answer. */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n[cut at ${String(max)} characters]`;
}

function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${String(minutes)} minutes` : `${String(Math.round(ms / 1000))} seconds`;
}

/**
 * The real thing: an ADK `Runner` over the parent's own session.
 *
 * Sharing the session id is what puts the child's events in the parent's
 * conversation, which is where its approval requests have to be for the window
 * to find them — and where its words are read back, attributed, once the turn
 * ends.
 */
async function* adkRun(request: {
  agent: BaseAgent;
  sessionService: BaseSessionService;
  sessionId: string;
  appName: string;
  userId: string;
  task: string;
  signal: AbortSignal;
}): AsyncGenerator<SubagentEvent> {
  const runner = new Runner({
    appName: request.appName,
    agent: request.agent,
    sessionService: request.sessionService,
  });

  for await (const event of runner.runAsync({
    userId: request.userId,
    sessionId: request.sessionId,
    newMessage: {role: 'user', parts: [{text: request.task}]},
    abortSignal: request.signal,
  })) {
    yield event as SubagentEvent;
  }
}
