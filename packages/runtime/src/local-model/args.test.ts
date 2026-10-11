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

import {EMBEDDING_ALIAS, embeddingArgs, engineArgs} from './args.js';

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

/**
 * The recall engine's command line.
 *
 * A second engine over the same binary, and the flags it must *not* have are
 * half the point: `--jinja` on an embedding server is a flag that looks
 * load-bearing and does nothing, and a quantized KV cache is memory spent on a
 * cache an embedding pass never builds. The rest was measured against the pinned
 * build rather than chosen — see the numbers below.
 */
describe('embeddingArgs', () => {
  function recallArgs(overrides: Partial<Parameters<typeof embeddingArgs>[0]> = {}) {
    return embeddingArgs({
      engine: '/opt/model/recall/engine/llama-server',
      model: '/opt/model/recall/embeddinggemma-2-Q8_0.gguf',
      port: 8123,
      contextSize: 8192,
      pooling: 'mean',
      ...overrides,
    });
  }

  it('is the whole command line, in the order the engine documents', () => {
    expect(recallArgs()).toEqual([
      '--model',
      '/opt/model/recall/embeddinggemma-2-Q8_0.gguf',
      '--alias',
      EMBEDDING_ALIAS,
      '--host',
      '127.0.0.1',
      '--port',
      '8123',
      '--ctx-size',
      '8192',
      '--n-gpu-layers',
      '0',
      '--embeddings',
      '--pooling',
      'mean',
      '--parallel',
      '1',
      '--batch-size',
      '4096',
      '--ubatch-size',
      '4096',
      '--no-webui',
    ]);
  });

  /*
   * This is the flag that makes the server an embedding server: without it
   * `/v1/embeddings` is not the endpoint the model is served on, and the process
   * comes up healthy and answers nothing.
   */
  it('restricts the server to embeddings, with the pooling the model declares', () => {
    const argv = recallArgs();
    expect(argv).toContain('--embeddings');
    expect(argv[argv.indexOf('--pooling') + 1]).toBe('mean');
  });

  /*
   * Both halves, because llama.cpp warns and clamps one down to the other: an
   * install that raised only `--batch-size` would lose the batching that makes
   * indexing a folder quick, and one that left both at the default of 512
   * refuses any media input over 512 tokens — measured, on a two-second clip at
   * 669 tokens, as an HTTP 500 rather than as a truncation.
   */
  it('sets both batch sizes high enough for the largest input it will send', () => {
    const argv = recallArgs();
    expect(argv[argv.indexOf('--batch-size') + 1]).toBe('4096');
    expect(argv[argv.indexOf('--ubatch-size') + 1]).toBe('4096');
  });

  /*
   * On the processor, deliberately. The chat tier's plan assumes the engine may
   * use all the free device memory, so a second client on the GPU would make
   * that estimate a lie; and this model's card warns that its activations exceed
   * float16's range, while the CPU backend accumulates in f32.
   */
  it('runs on the processor, with no GPU offload at all', () => {
    expect(recallArgs()[recallArgs().indexOf('--n-gpu-layers') + 1]).toBe('0');
  });

  it('leaves out every flag that belongs to the chat model', () => {
    const argv = recallArgs();
    expect(argv).not.toContain('--jinja');
    expect(argv).not.toContain('--chat-template-kwargs');
    expect(argv).not.toContain('--flash-attn');
    expect(argv).not.toContain('--cache-type-k');
    expect(argv).not.toContain('--cache-type-v');
  });

  it('takes the projector only when one is being used', () => {
    expect(recallArgs()).not.toContain('--mmproj');
    const argv = recallArgs({projector: '/opt/model/recall/mmproj-Q8_0.gguf'});
    expect(argv[argv.indexOf('--mmproj') + 1]).toBe(
      '/opt/model/recall/mmproj-Q8_0.gguf',
    );
  });

  it('binds to loopback and names the model with the app’s own id', () => {
    const argv = recallArgs();
    expect(argv[argv.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(argv[argv.indexOf('--alias') + 1]).toBe(EMBEDDING_ALIAS);
    expect(argv[argv.indexOf('--alias') + 1]).not.toContain('.gguf');
  });

  it('prints a placeholder port when there is not one yet', () => {
    expect(recallArgs({port: '<port>'})[recallArgs().indexOf('--port') + 1]).toBe(
      '<port>',
    );
  });
});
