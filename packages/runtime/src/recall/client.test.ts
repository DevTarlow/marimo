/**
 * The HTTP client, with a fake engine.
 *
 * Every assertion here is a failure that is invisible from the window. A vector
 * arrived in the wrong order indexes a folder against the wrong files; a vector
 * of the wrong width scores against nothing; a NaN vector is stored, never
 * matches, and is never reported. None of those look like a bug — they look like
 * a search that is not very good — so they are caught here, at the door, and the
 * tests are written as the sentences a caller would otherwise never see.
 *
 * What is *not* faked is the request body: the typed-content shape is asserted
 * verbatim, because it is the part the published documentation gets wrong. The
 * documented `/embedding` form with `prompt_string` and `multimodal_data`
 * answers 500 on the pinned build, and a test that only mocked the response
 * would happily let it back in.
 */
import {describe, expect, it} from 'vitest';

import {EmbeddingClient, EmbeddingError} from './client.js';

interface Call {
  url: string;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

/** A fetch that records what it was asked and answers with what it was given. */
function fakeFetch(handler: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      body: JSON.parse(String(init.body)) as unknown,
      signal: init.signal,
    };
    calls.push(call);
    return await handler(call);
  }) as unknown as typeof fetch;
  return {fetchImpl, calls};
}

function answer(
  embeddings: number[][],
  options: {tokens?: number; indexes?: number[]} = {},
): Response {
  return new Response(
    JSON.stringify({
      data: embeddings.map((embedding, position) => ({
        index: options.indexes?.[position] ?? position,
        embedding,
      })),
      usage: {prompt_tokens: options.tokens ?? 7},
    }),
    {status: 200},
  );
}

function client(fetchImpl: typeof fetch, dims = 4): EmbeddingClient {
  return new EmbeddingClient({
    baseUrl: () => 'http://127.0.0.1:9999/v1',
    dims,
    fetchImpl,
  });
}

describe('EmbeddingClient', () => {
  it('sends the typed-content shape and nothing else', async () => {
    const {fetchImpl, calls} = fakeFetch(() => answer([[1, 0, 0, 0]]));
    await client(fetchImpl).embedText(['hello']);

    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/v1/embeddings');
    expect(calls[0]?.body).toEqual({
      input: [{content: [{type: 'text', text: 'hello'}]}],
    });
  });

  /*
   * Images and audio go in the same field as text, which is what makes one
   * interleaved input — a file name followed by a picture — a single point in
   * the space rather than two. The audio part carries its format because the
   * engine has no other way to know what it was handed.
   */
  it('sends media as typed parts, with the format', async () => {
    const {fetchImpl, calls} = fakeFetch((call) => {
      const inputs = (call.body as {input: unknown[]}).input;
      return answer(inputs.map(() => [1, 0, 0, 0]));
    });
    await client(fetchImpl).embed([
      [
        {type: 'text', text: 'title: a.png | text:'},
        {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
      ],
      [{type: 'input_audio', input_audio: {data: 'BBB', format: 'wav'}}],
    ]);

    expect(calls[0]?.body).toEqual({
      input: [
        {
          content: [
            {type: 'text', text: 'title: a.png | text:'},
            {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
          ],
        },
        {content: [{type: 'input_audio', input_audio: {data: 'BBB', format: 'wav'}}]},
      ],
    });
  });

  it('asks for nothing when it was given nothing', async () => {
    const {fetchImpl, calls} = fakeFetch(() => answer([]));
    const result = await client(fetchImpl).embedText([]);

    expect(result.vectors).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('batches, and keeps the order across batches', async () => {
    let seen = 0;
    const {fetchImpl, calls} = fakeFetch((call) => {
      const inputs = (call.body as {input: unknown[]}).input;
      return answer(
        inputs.map(() => {
          seen += 1;
          return [seen, 0, 0, 0];
        }),
      );
    });
    const result = await new EmbeddingClient({
      baseUrl: () => 'http://x/v1',
      dims: 4,
      batchSize: 2,
      fetchImpl,
    }).embedText(['a', 'b', 'c']);

    expect(calls).toHaveLength(2);
    expect(result.vectors.map((vector) => vector[0])).toEqual([1, 2, 3]);
  });

  /*
   * The engine is allowed to answer in any order, and one that does so would
   * otherwise index a folder with each vector attached to another file's name —
   * the most expensive kind of silent wrongness here, because the results look
   * plausible and point at the wrong code.
   */
  it('puts vectors back in the order they were sent, by index', async () => {
    const {fetchImpl} = fakeFetch(() =>
      answer(
        [
          [9, 0, 0, 0],
          [1, 0, 0, 0],
          [5, 0, 0, 0],
        ],
        {indexes: [2, 0, 1]},
      ),
    );
    const result = await client(fetchImpl).embedText(['first', 'second', 'third']);

    expect(result.vectors.map((vector) => vector[0])).toEqual([1, 5, 9]);
  });

  it('counts the tokens the engine reported', async () => {
    const {fetchImpl} = fakeFetch(() => answer([[1, 0, 0, 0]], {tokens: 42}));
    const result = await client(fetchImpl).embedText(['x']);

    expect(result.tokens).toBe(42);
  });

  it('does not guess an address when the engine is not running', async () => {
    const {fetchImpl, calls} = fakeFetch(() => answer([[1, 0, 0, 0]]));
    const idle = new EmbeddingClient({
      baseUrl: () => undefined,
      dims: 4,
      fetchImpl,
    });

    await expect(idle.embedText(['x'])).rejects.toThrow(EmbeddingError);
    expect(calls).toHaveLength(0);
  });

  /*
   * The engine's own words are kept. It answers a bad request with the cause —
   * "input (669 tokens) is too large to process" is how the physical-batch limit
   * was found — and replacing that with "HTTP 500" throws away the only half a
   * person could act on.
   */
  it('keeps the engine’s own explanation of a refusal', async () => {
    const {fetchImpl} = fakeFetch(
      () =>
        new Response(
          JSON.stringify({error: {message: 'input (669 tokens) is too large'}}),
          {status: 500},
        ),
    );

    await expect(client(fetchImpl).embedText(['x'])).rejects.toThrow(
      /500.*input \(669 tokens\) is too large/u,
    );
  });

  it('refuses a vector of the wrong width, naming both numbers', async () => {
    const {fetchImpl} = fakeFetch(() => answer([[1, 0, 0]]));

    await expect(client(fetchImpl, 768).embedText(['x'])).rejects.toThrow(
      /3-value vector.*768/u,
    );
  });

  /*
   * The model's own card warns that its activations exceed float16's range and
   * come back as NaN in it. What that actually looks like on the wire is the
   * interesting part, and it is two different things, so both are pinned:
   *
   * - a NaN is not writable in JSON and arrives as `null`, which
   *   `Float32Array.from` turns into a `0` — a plausible value in a plausible
   *   vector, and nothing downstream could ever tell;
   * - an overflow *is* writable as `1e999` and parses to `Infinity`, which no
   *   norm and no dot product survives.
   */
  it('refuses a hole in a vector, which is how a NaN arrives', async () => {
    const {fetchImpl} = fakeFetch(
      () => new Response('{"data":[{"index":0,"embedding":[1,null,0,0]}]}', {status: 200}),
    );

    await expect(client(fetchImpl).embedText(['x'])).rejects.toThrow(
      /null where a vector value belongs \(position 2\)/u,
    );
  });

  it('refuses an overflowing value that parsed as Infinity', async () => {
    const {fetchImpl} = fakeFetch(
      () => new Response('{"data":[{"index":0,"embedding":[1,1e999,0,0]}]}', {status: 200}),
    );

    await expect(client(fetchImpl).embedText(['x'])).rejects.toThrow(/not finite/u);
  });

  it('refuses an all-zero vector, which is not an embedding', async () => {
    const {fetchImpl} = fakeFetch(() => answer([[0, 0, 0, 0]]));

    await expect(client(fetchImpl).embedText(['x'])).rejects.toThrow(/all-zero/u);
  });

  /*
   * Counting the answers is not pedantry: vectors are matched to inputs by
   * position, so one missing vector attaches every later result to the wrong
   * question.
   */
  it('refuses an answer with a different number of vectors', async () => {
    const {fetchImpl} = fakeFetch(() => answer([[1, 0, 0, 0]]));

    await expect(client(fetchImpl).embedText(['a', 'b'])).rejects.toThrow(
      /1 vectors for 2 inputs/u,
    );
  });

  it('says what happened when the engine cannot be reached at all', async () => {
    const {fetchImpl} = fakeFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    await expect(client(fetchImpl).embedText(['x'])).rejects.toThrow(
      /could not be reached: ECONNREFUSED/u,
    );
  });

  it('gives every request a deadline', async () => {
    const {fetchImpl, calls} = fakeFetch(() => answer([[1, 0, 0, 0]]));
    await client(fetchImpl).embedText(['x'], {timeoutMs: 1_500});

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
