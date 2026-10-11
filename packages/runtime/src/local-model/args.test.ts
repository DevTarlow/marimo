/**
 * The command line, asserted as data.
 *
 * This is where every mistake the model can make at start-up actually lives: a
 * flag that is not what llama.cpp expects is a process that exits with a usage
 * message, and a missing `--jinja` is worse — the engine runs perfectly and the
 * agent is offered no tools at all, because the model's chat template is the only
 * thing that turns its `<tool_call>` block into a call this app can see. Neither
 * is visible from a test that starts a real server, and one of them cannot be seen
 * from the window at all.
 *
 * The whole argv below was run against the pinned engine with the real weights
 * before it was written here — `--jinja`, the quantized cache and `--flash-attn
 * on` together at 16K, with a tool call coming back structured. The assertions are
 * what keeps that from drifting.
 */
import {LOCAL_MODEL_ID} from '@marimo/protocol';
import {describe, expect, it} from 'vitest';

import {engineArgs} from './args.js';

function args(overrides: Partial<Parameters<typeof engineArgs>[0]> = {}) {
  return engineArgs({
    engine: '/opt/model/engine/llama-server',
    model: '/opt/model/Qwen3.5-4B-Q4_K_M.gguf',
    port: 8137,
    contextSize: 16384,
    thinking: false,
    ...overrides,
  });
}

describe('engineArgs', () => {
  it('is the whole command line, in the order the engine documents', () => {
    expect(args()).toEqual([
      '--model',
      '/opt/model/Qwen3.5-4B-Q4_K_M.gguf',
      '--alias',
      LOCAL_MODEL_ID,
      '--host',
      '127.0.0.1',
      '--port',
      '8137',
      '--ctx-size',
      '16384',
      '--n-gpu-layers',
      '99',
      '--flash-attn',
      'on',
      '--cache-type-k',
      'q8_0',
      '--cache-type-v',
      'q8_0',
      '--parallel',
      '1',
      '--jinja',
      '--no-webui',
      '--chat-template-kwargs',
      '{"enable_thinking":false}',
    ]);
  });

  /*
   * The one flag the whole feature depends on, named by its own test so that
   * deleting it fails here rather than in a conversation where the agent
   * cheerfully refuses to use any of its tools.
   */
  it('always asks the engine to apply the model template', () => {
    expect(args({thinking: true})).toContain('--jinja');
  });

  it('binds to loopback and never to a network address', () => {
    const argv = args();
    expect(argv[argv.indexOf('--host') + 1]).toBe('127.0.0.1');
  });

  it('names the model with the app’s own id, not the file', () => {
    const argv = args();
    expect(argv[argv.indexOf('--alias') + 1]).toBe(LOCAL_MODEL_ID);
    expect(argv[argv.indexOf('--alias') + 1]).not.toContain('.gguf');
  });

  it('runs one request at a time, like the app does', () => {
    const argv = args();
    expect(argv[argv.indexOf('--parallel') + 1]).toBe('1');
  });

  /*
   * All layers, always, and there is no CPU value to fall back to: the app ships
   * GPU engine builds only and refuses to start without a device. A `0` here would
   * be a model running on a processor, which is the configuration this app
   * deliberately does not have.
   */
  it('offloads every layer, and has no CPU setting to fall back to', () => {
    const argv = args();
    expect(argv[argv.indexOf('--n-gpu-layers') + 1]).toBe('99');
  });

  /*
   * The cache is halved, and it is halved *because* flash attention is on: an
   * engine that resolved `auto` to `off` would store the cache at f16 and quietly
   * use the memory this saves — which on a 4 GB card is the difference between the
   * bigger tier fitting and not.
   */
  it('quantizes both halves of the cache and turns flash attention on', () => {
    const argv = args();
    expect(argv[argv.indexOf('--cache-type-k') + 1]).toBe('q8_0');
    expect(argv[argv.indexOf('--cache-type-v') + 1]).toBe('q8_0');
    expect(argv[argv.indexOf('--flash-attn') + 1]).toBe('on');
  });

  /*
   * Thinking is off unless asked for, and the switch is *absent* when it is on
   * rather than sent as `true`. The template's own default is to think, so turning
   * it on is done by saying nothing — one fewer argument to disagree about against
   * an engine built by somebody else.
   */
  it('only passes the thinking switch when it is being turned off', () => {
    expect(args({thinking: false})).toContain('--chat-template-kwargs');
    expect(args({thinking: true})).not.toContain('--chat-template-kwargs');
  });

  it('carries the context window the plan chose', () => {
    const argv = args({contextSize: 32768});
    expect(argv[argv.indexOf('--ctx-size') + 1]).toBe('32768');
  });

  /*
   * The port is a string in the status card before anything is running, because
   * `--port <port>` is a truer thing to show a user than a zero that looks like an
   * answer.
   */
  it('prints a placeholder port when there is not one yet', () => {
    expect(args({port: '<port>'})[args().indexOf('--port') + 1]).toBe('<port>');
  });
});
