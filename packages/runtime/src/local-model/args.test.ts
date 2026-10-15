/**
 * The command line, asserted as data.
 *
 * This is where every mistake the model can make at start-up actually lives: a
 * flag that is not what llama.cpp expects is a process that exits with a usage
 * message, and a missing `--embeddings` is worse — the engine runs perfectly,
 * answers `/health`, and embeds nothing at all. Neither is visible from a test
 * that starts a real server, and the second is invisible from the window.
 *
 * The whole argv below was run against the pinned engine with the real weights
 * before it was written here — `--embeddings`, `--pooling mean` and both batch
 * sizes together at 8K, with an image and a two-second clip coming back as
 * vectors. The assertions are what keeps that from drifting.
 */
import {describe, expect, it} from 'vitest';

import {EMBEDDING_ALIAS, embeddingArgs} from './args.js';

/**
 * The recall engine's command line.
 *
 * The flags it must *not* have are half the point: `--jinja` on an embedding
 * server is a flag that looks load-bearing and does nothing, and a quantized KV
 * cache is memory spent on a cache an embedding pass never builds. The rest was
 * measured against the pinned build rather than chosen — see the numbers below.
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
   * On the processor, deliberately: this model's card warns that its activations
   * exceed float16's range, while the CPU backend accumulates in f32. An
   * embedding is one pass over at most 8K tokens, so the GPU is the smaller half
   * of the trade here anyway.
   */
  it('runs on the processor, with no GPU offload at all', () => {
    expect(recallArgs()[recallArgs().indexOf('--n-gpu-layers') + 1]).toBe('0');
  });

  /*
   * The flags a chat server needs and an embedding pass does not. `--jinja` is
   * the one worth naming: on this engine it would look load-bearing, do nothing,
   * and pass a test that only checked the process came up.
   */
  it('leaves out the flags a chat server needs and an embedding pass does not', () => {
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
