/**
 * Handing work to a helper agent.
 *
 * Every test here runs without a model, a provider or a network, because the run
 * is injected. What is under test is not "does ADK work" but the four things this
 * file decides: what it refuses, how it is bounded, where the child's work lands,
 * and what the parent is told when it goes wrong.
 */
import {describe, expect, it} from 'vitest';

import type {AgentUiEvent} from '@marimo/protocol';

import {createSpawnAgentTool} from './subagent-tool.js';
import type {SubagentEvent, SubagentRun} from './subagent-tool.js';

/** A context with only what the tool reads. */
function context(overrides: {aborted?: AbortSignal} = {}) {
  return {
    functionCallId: 'call-1',
    invocationContext: {
      appName: 'marimo',
      userId: 'user',
      session: {id: 'session-1'},
      // Only its presence is checked; the run is injected.
      sessionService: {},
    },
    ...(overrides.aborted === undefined
      ? {}
      : {abortSignal: overrides.aborted}),
  } as never;
}

/** A run that yields the given events, recording what it was asked. */
function fakeRun(events: SubagentEvent[]): {
  run: SubagentRun;
  calls: Array<{sessionId: string; task: string; name: string}>;
} {
  const calls: Array<{sessionId: string; task: string; name: string}> = [];
  return {
    calls,
    run: (request) => {
      calls.push({
        sessionId: request.sessionId,
        task: request.task,
        name: (request.agent as unknown as {name: string}).name,
      });
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    },
  };
}

/** The child, as the tool will build it. */
function build({name}: {name: string; task: string}) {
  return {name} as never;
}

/** Runs the tool and answers what it returned. */
async function spawn(
  tool: ReturnType<typeof createSpawnAgentTool>,
  args: {name: string; task: string},
  ctx: unknown = context(),
): Promise<string> {
  const execute = (
    tool as unknown as {
      execute: (a: unknown, c: unknown) => Promise<string>;
    }
  ).execute;
  return await execute(args, ctx);
}

function saying(author: string, text: string): SubagentEvent {
  return {author, content: {parts: [{text}]}};
}

describe('the helper tool', () => {
  it('is offered under a name the model can call', () => {
    const tool = createSpawnAgentTool({build, run: fakeRun([]).run});
    expect(tool.name).toBe('spawn_agent');
    // The description has to carry the two things a model gets wrong: that the
    // helper cannot see this conversation, and that it cannot ask anything back.
    expect(tool.description).toMatch(/cannot see this conversation/u);
    expect(tool.description).toMatch(/cannot spawn helpers/u);
  });
});

describe('what it refuses', () => {
  /*
   * The name becomes a label the user reads in their own conversation, so it is
   * refused rather than rewritten: quietly fixing up what the model asked for is
   * how a transcript stops matching what happened.
   */
  it('refuses a name that is not a usable label', async () => {
    const {run, calls} = fakeRun([]);
    const tool = createSpawnAgentTool({build, run});

    const answer = await spawn(tool, {name: 'My Helper!', task: 'do a thing'});

    expect(answer).toMatch(/not a usable helper name/u);
    // And nothing ran: a refusal that still spends the provider's money is not a
    // refusal.
    expect(calls).toEqual([]);
  });

  it('refuses a name that is too long', async () => {
    const tool = createSpawnAgentTool({build, run: fakeRun([]).run});
    const answer = await spawn(tool, {name: 'a'.repeat(40), task: 'x'});
    expect(answer).toMatch(/not a usable helper name/u);
  });

  it('accepts a name with digits and underscores', async () => {
    const {run} = fakeRun([saying('helper_2', 'done')]);
    const tool = createSpawnAgentTool({build, run});
    const answer = await spawn(tool, {name: 'helper_2', task: 'x'});
    expect(answer).toBe('done');
  });

  it('refuses an empty task', async () => {
    const {run, calls} = fakeRun([]);
    const tool = createSpawnAgentTool({build, run});
    const answer = await spawn(tool, {name: 'helper', task: '   '});
    expect(answer).toMatch(/needs a task/u);
    expect(calls).toEqual([]);
  });

  /*
   * Without an invocation there is no conversation to run inside, and no session
   * service to store the child's events in. Refused in words rather than thrown:
   * a tool that throws ends the parent's whole turn, which would turn "the
   * helper could not start" into "your request failed".
   */
  it('refuses outside a conversation instead of throwing', async () => {
    const tool = createSpawnAgentTool({build, run: fakeRun([]).run});
    // A context with no invocation at all.
    expect(await spawn(tool, {name: 'helper', task: 'x'}, {})).toMatch(
      /outside a conversation/u,
    );
  });

  /*
   * The session service is what stores the child's events — and, more to the
   * point, what its approval requests are recorded through. A child without one
   * would run and ask questions nobody could see.
   */
  it('refuses when there is no session service to record the child in', async () => {
    const tool = createSpawnAgentTool({build, run: fakeRun([]).run});
    const answer = await spawn(tool, {name: 'helper', task: 'x'}, {
      invocationContext: {appName: 'marimo', userId: 'u', session: {id: 's'}},
    });
    expect(answer).toMatch(/outside a conversation/u);
  });
});

describe('where the child runs', () => {
  /*
   * The property that makes approval work at all. A gate is recorded in the
   * conversation it belongs to and the window finds it by reading that
   * conversation's log; a child in its own session would ask a question nobody
   * could see, and the turn would wait for an answer that could never arrive.
   */
  it('runs in the parent conversation, not one of its own', async () => {
    const {run, calls} = fakeRun([saying('helper', 'done')]);
    const tool = createSpawnAgentTool({build, run});

    await spawn(tool, {name: 'helper', task: 'read the logs'});

    expect(calls[0]?.sessionId).toBe('session-1');
    expect(calls[0]?.task).toBe('read the logs');
  });

  it('builds the child under the name it was asked for', async () => {
    const {run, calls} = fakeRun([saying('researcher', 'done')]);
    const tool = createSpawnAgentTool({build, run});
    await spawn(tool, {name: 'Researcher', task: 'x'});
    // Lower-cased, which is what the label in the transcript will show.
    expect(calls[0]?.name).toBe('researcher');
  });
});

describe('what the window sees', () => {
  it('opens, streams and closes a group', async () => {
    const seen: AgentUiEvent[] = [];
    const {run} = fakeRun([
      saying('helper', 'thinking'),
      saying('helper', 'done'),
    ]);
    const tool = createSpawnAgentTool({
      build,
      run,
      onEvent: (event) => seen.push(event),
    });

    await spawn(tool, {name: 'helper', task: 'x'});

    expect(seen.map((event) => event.type)).toEqual([
      'subagent.started',
      'subagent.event',
      'subagent.event',
      'subagent.finished',
    ]);
    expect(seen[0]).toMatchObject({name: 'helper', callId: 'call-1', task: 'x'});
    expect(seen[3]).toMatchObject({name: 'helper', ok: true});
  });

  /*
   * Only the child's own words. ADK emits events for the child's bookkeeping as
   * well, and forwarding those would make the live view say more than the
   * transcript it is a preview of.
   */
  it('forwards the child words and nothing else', async () => {
    const seen: AgentUiEvent[] = [];
    const {run} = fakeRun([
      saying('helper', 'mine'),
      // The parent speaking in the same stream — not the child's to report.
      saying('marimo', 'not mine'),
      // A step with no words at all.
      {author: 'helper', content: {parts: []}},
    ]);
    const tool = createSpawnAgentTool({
      build,
      run,
      onEvent: (event) => seen.push(event),
    });

    await spawn(tool, {name: 'helper', task: 'x'});

    const streamed = seen.filter((event) => event.type === 'subagent.event');
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({text: 'mine'});
  });

  it('closes the group with the reason when the child fails', async () => {
    const seen: AgentUiEvent[] = [];
    const tool = createSpawnAgentTool({
      build,
      onEvent: (event) => seen.push(event),
      run: () =>
        (async function* () {
          throw new Error('the provider refused');
        })(),
    });

    await spawn(tool, {name: 'helper', task: 'x'});

    expect(seen[seen.length - 1]).toMatchObject({
      type: 'subagent.finished',
      ok: false,
      error: 'the provider refused',
    });
  });
});

describe('how it is bounded', () => {
  it('stops at its step budget and says so', async () => {
    const many = Array.from({length: 20}, () => saying('helper', 'tick'));
    const tool = createSpawnAgentTool({
      build,
      run: fakeRun(many).run,
      limits: {maxSteps: 3},
    });

    const answer = await spawn(tool, {name: 'helper', task: 'x'});

    expect(answer).toMatch(/whole budget of 3 steps/u);
  });

  /*
   * A silent cut reads as a complete answer, which is the same failure the tool
   * result cap exists to prevent.
   */
  it('truncates a long answer and says that it did', async () => {
    const long = 'x'.repeat(500);
    const tool = createSpawnAgentTool({
      build,
      run: fakeRun([saying('helper', long)]).run,
      limits: {maxResultChars: 100},
    });

    const answer = await spawn(tool, {name: 'helper', task: 'x'});

    expect(answer).toContain('[cut at 100 characters]');
    expect(answer.length).toBeLessThan(long.length);
  });

  it('answers with the child last words, not its first', async () => {
    const tool = createSpawnAgentTool({
      build,
      run: fakeRun([saying('helper', 'let me look'), saying('helper', 'the answer')]).run,
    });
    expect(await spawn(tool, {name: 'helper', task: 'x'})).toBe('the answer');
  });

  it('says so when the child produced nothing', async () => {
    const tool = createSpawnAgentTool({build, run: fakeRun([]).run});
    expect(await spawn(tool, {name: 'helper', task: 'x'})).toMatch(
      /without producing an answer/u,
    );
  });

  /*
   * The parent's stop has to reach the child. Without this, pressing Stop leaves
   * a helper running and spending, and the turn it belonged to looks finished.
   */
  it('stops the child when the parent is stopped', async () => {
    const parent = new AbortController();
    let sawAbort = false;

    const tool = createSpawnAgentTool({
      build,
      run: (request) =>
        (async function* () {
          parent.abort();
          // The tool aborts its own controller, which is what reaches ADK.
          sawAbort = request.signal.aborted;
          yield saying('helper', 'partial');
        })(),
    });

    await spawn(tool, {name: 'helper', task: 'x'}, context({aborted: parent.signal}));

    expect(sawAbort).toBe(true);
  });

  it('reports a failure as the helper answer rather than throwing', async () => {
    const tool = createSpawnAgentTool({
      build,
      run: () =>
        (async function* () {
          throw new Error('DeepSeek needs an API key.');
        })(),
    });

    const answer = await spawn(tool, {name: 'helper', task: 'x'});

    // The parent's turn continues and can explain itself, rather than the whole
    // request failing because a helper could not start.
    expect(answer).toBe('The helper "helper" did not finish: DeepSeek needs an API key.');
  });
});
