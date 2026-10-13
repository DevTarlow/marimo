import {describe, expect, it} from 'vitest';

import type {BaseTool, Context} from '@google/adk';

import {REWARD_REASONS} from './reward.js';
import {TreeRecorder, type DreamSink} from './recorder.js';
import {DreamToolPlugin} from './tool-plugin.js';

/**
 * The smallest thing that satisfies what the plugin actually reads.
 *
 * Cast rather than constructed, because building a real ADK `Context` means
 * building an `InvocationContext`, a session service and a plugin manager — and
 * every one of those is machinery this plugin never touches. What it reads is two
 * fields, so the test supplies two fields; the cast is the admission that the
 * live wiring is ADK's business and the *logic* is what is under test here.
 */
function context(invocationId: string, functionCallId?: string): Context {
  return {invocationId, functionCallId} as unknown as Context;
}

function tool(name: string): BaseTool {
  return {name} as unknown as BaseTool;
}

function collecting(): {sink: DreamSink; snapshots: import('@marimo/protocol').DreamTree[]} {
  const snapshots: import('@marimo/protocol').DreamTree[] = [];
  return {
    snapshots,
    sink: {
      append: (tree) => {
        snapshots.push(tree);
      },
    },
  };
}

function pluginUnder(
  sink: DreamSink,
  options: {
    explorationWeight?: number;
    pruningThreshold?: number;
  } = {},
): {plugin: DreamToolPlugin; recorder: TreeRecorder} {
  const invocationId = 'inv-1';
  const recorder = new TreeRecorder(
    {
      sessionId: 'session-1',
      invocationId,
      policy: {
        explorationWeight: options.explorationWeight ?? 1,
        pruningThreshold: options.pruningThreshold ?? -1,
      },
    },
    sink,
    {resultBytes: 256},
  );
  const plugin = new DreamToolPlugin({
    recorderFor: (id) => (id === invocationId ? recorder : undefined),
    settings: () => ({
      explorationWeight: options.explorationWeight ?? 1,
      pruningThreshold: options.pruningThreshold ?? -1,
    }),
  });
  return {plugin, recorder};
}

/** Every tool the model would be offered, as `beforeToolSelection` receives them. */
function menu(...names: string[]): Record<string, BaseTool> {
  return Object.fromEntries(names.map((name) => [name, tool(name)]));
}

describe('DreamToolPlugin', () => {
  it('records a call and its result as a proposal under a step', async () => {
    const {sink, snapshots} = collecting();
    const {plugin} = pluginUnder(sink);
    const context1 = context('inv-1', 'call-1');

    await plugin.beforeModelCallback({callbackContext: context1});
    await plugin.beforeToolCallback({
      tool: tool('read_file'),
      toolArgs: {path: 'notes.md'},
      toolContext: context1,
    });
    await plugin.afterToolCallback({
      tool: tool('read_file'),
      toolArgs: {path: 'notes.md'},
      toolContext: context1,
      result: {result: 'the contents'},
    });

    const tree = snapshots.at(-1);
    const kinds = tree?.nodes.map((node) => node.kind);
    expect(kinds).toEqual(['turn', 'turn', 'propose', 'call']);
    const call = tree?.nodes.find((node) => node.kind === 'call');
    // The reward is derived from the result, not supplied — which is what makes
    // the whole thing replayable.
    expect(call?.reward?.value).toBe(1);
    expect(call?.reward?.reason).toBe(REWARD_REASONS.ran);
    expect(tree?.nodes.find((node) => node.kind === 'propose')?.allowed).toBe(true);
  });

  it('refuses the third identical call and records the refusal', async () => {
    const {sink, snapshots} = collecting();
    const {plugin} = pluginUnder(sink);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const callContext = context('inv-1', `call-${String(attempt)}`);
      await plugin.beforeModelCallback({callbackContext: callContext});
      await plugin.beforeToolCallback({
        tool: tool('web_search'),
        toolArgs: {query: 'the same thing'},
        toolContext: callContext,
      });
      // Nothing runs for the refused one, so no `afterToolCallback` follows it —
      // which is exactly the shape a refusal has in a real turn.
      if (attempt < 3) {
        await plugin.afterToolCallback({
          tool: tool('web_search'),
          toolArgs: {query: 'the same thing'},
          toolContext: callContext,
          result: {result: 'something'},
        });
      }
    }

    const tree = snapshots.at(-1);
    const refused = tree?.nodes.filter(
      (node) => node.kind === 'call' && node.allowed === false,
    );
    expect(refused).toHaveLength(1);
    expect(refused?.[0]?.reward?.reason).toBe(REWARD_REASONS.repeated);
  });

  it('does not count different arguments as a repeat', async () => {
    const {sink} = collecting();
    const {plugin} = pluginUnder(sink);

    for (const path of ['a.md', 'b.md', 'c.md']) {
      const callContext = context('inv-1', `call-${path}`);
      await plugin.beforeModelCallback({callbackContext: callContext});
      const response = await plugin.beforeToolCallback({
        tool: tool('read_file'),
        toolArgs: {path},
        toolContext: callContext,
      });
      // Refusing `read_file` three times on three different files would be
      // refusing a model for doing its job — the bug that made the repeat count
      // and the action's own statistics two separate numbers.
      expect(response).toBeUndefined();
    }
  });

  it('warns on the second identical call without refusing it', async () => {
    const {sink} = collecting();
    const {plugin} = pluginUnder(sink);

    const first = context('inv-1', 'call-1');
    await plugin.beforeModelCallback({callbackContext: first});
    await plugin.beforeToolCallback({
      tool: tool('read_file'),
      toolArgs: {path: 'a.md'},
      toolContext: first,
    });
    await plugin.afterToolCallback({
      tool: tool('read_file'),
      toolArgs: {path: 'a.md'},
      toolContext: first,
      result: {result: 'contents'},
    });

    const second = context('inv-1', 'call-2');
    await plugin.beforeToolCallback({
      tool: tool('read_file'),
      toolArgs: {path: 'a.md'},
      toolContext: second,
    });
    const warned = await plugin.afterToolCallback({
      tool: tool('read_file'),
      toolArgs: {path: 'a.md'},
      toolContext: second,
      result: {result: 'contents'},
    });

    expect(warned?.['result']).toContain('[repeated call]');
    expect(warned?.['result']).toContain('call 2 of');
  });

  it('takes a failing tool off the menu once the threshold excludes it', async () => {
    const {sink, snapshots} = collecting();
    const {plugin} = pluginUnder(sink, {pruningThreshold: 0});

    // First call runs and fails, which is what earns the evidence.
    const first = context('inv-1', 'call-1');
    await plugin.beforeModelCallback({callbackContext: first});
    await plugin.beforeToolSelection({
      callbackContext: first,
      tools: menu('shell', 'read_file'),
    });
    await plugin.beforeToolCallback({
      tool: tool('shell'),
      toolArgs: {command: 'false'},
      toolContext: first,
    });
    await plugin.afterToolCallback({
      tool: tool('shell'),
      toolArgs: {command: 'false'},
      toolContext: first,
      result: {error: 'exit 1'},
    });

    // The next request offers the model a smaller menu, which is the real
    // pruning: an absent tool is one the model cannot ask for at all.
    const second = context('inv-1', 'call-2');
    const narrowed = await plugin.beforeToolSelection({
      callbackContext: second,
      tools: menu('shell', 'read_file'),
    });

    expect(Object.keys(narrowed ?? {})).toEqual(['read_file']);
    // The log records the *unfiltered* world, so a replay can still ask what a
    // different threshold would have offered.
    const step = snapshots
      .at(-1)
      ?.nodes.filter((node) => node.offered !== undefined)
      .at(-1);
    expect(step?.offered).toEqual(['shell', 'read_file']);
  });

  it('leaves the menu alone when nothing is pruned', async () => {
    const {sink} = collecting();
    const {plugin} = pluginUnder(sink);
    const callContext = context('inv-1', 'call-1');

    // `undefined` rather than an empty record: an empty record is a model with
    // no tools, which is a different thing from a model with all of them.
    const answer = await plugin.beforeToolSelection({
      callbackContext: callContext,
      tools: menu('shell', 'read_file'),
    });
    expect(answer).toBeUndefined();
  });

  it('ignores the confirmation call entirely', async () => {
    const {sink, snapshots} = collecting();
    const {plugin} = pluginUnder(sink);
    const callContext = context('inv-1', 'call-1');

    const response = await plugin.beforeToolCallback({
      tool: tool('adk_request_confirmation'),
      toolArgs: {tool: 'shell'},
      toolContext: callContext,
    });

    // It is the model asking the user a question, not the model calling a tool:
    // the turn is pausing, not looping.
    expect(response).toBeUndefined();
    expect(snapshots).toHaveLength(0);
  });

  it('records the answer when the model replies without calling anything', async () => {
    const {sink, snapshots} = collecting();
    const {plugin} = pluginUnder(sink);
    const callContext = context('inv-1', 'call-1');

    await plugin.beforeModelCallback({callbackContext: callContext});
    await plugin.afterModelCallback({
      callbackContext: callContext,
      llmResponse: {
        content: {parts: [{text: 'Here is your answer.'}]},
      },
    });

    // Without this node a turn that answered and a turn that went silent have
    // identical trees, and silence is the failure this app keeps a whole guard
    // for.
    expect(snapshots.at(-1)?.nodes.some((node) => node.kind === 'answer')).toBe(true);
  });

  it('ignores a streamed chunk so one answer is not recorded nine times', async () => {
    const {sink, snapshots} = collecting();
    const {plugin} = pluginUnder(sink);
    const callContext = context('inv-1', 'call-1');

    await plugin.beforeModelCallback({callbackContext: callContext});
    for (const chunk of ['Here ', 'is ', 'your ', 'answer.']) {
      await plugin.afterModelCallback({
        callbackContext: callContext,
        llmResponse: {partial: true, content: {parts: [{text: chunk}]}},
      });
    }
    expect(snapshots).toHaveLength(0);

    // The final, non-partial response carries the whole text and is the only one
    // that becomes a node.
    await plugin.afterModelCallback({
      callbackContext: callContext,
      llmResponse: {content: {parts: [{text: 'Here is your answer.'}]}},
    });
    const answers = snapshots
      .at(-1)
      ?.nodes.filter((node) => node.kind === 'answer');
    expect(answers).toHaveLength(1);
  });

  it('does nothing at all for a turn it has no recorder for', async () => {
    const {snapshots} = collecting();
    const plugin = new DreamToolPlugin({
      recorderFor: () => undefined,
      settings: () => ({explorationWeight: 1, pruningThreshold: 0}),
    });

    await plugin.beforeToolSelection({
      callbackContext: context('other-turn'),
      tools: menu('shell'),
    });
    const response = await plugin.beforeToolCallback({
      tool: tool('shell'),
      toolArgs: {},
      toolContext: context('other-turn'),
    });

    expect(response).toBeUndefined();
    expect(snapshots).toHaveLength(0);
  });
});
