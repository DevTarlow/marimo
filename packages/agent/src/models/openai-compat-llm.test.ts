/**
 * The one OpenAI-compatible client, and what it puts on the wire.
 *
 * There is one backend now — the llama.cpp engine the app starts on loopback —
 * so the request shape is a fact rather than a choice: usage is always asked for,
 * and there is never an `Authorization` header because there is no credential.
 * Both used to travel with a provider descriptor, and both are the kind of
 * difference that is invisible until the wrong one is sent, so they are pinned
 * here rather than described.
 */
import type {LlmRequest} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  OpenAiCompatLlm,
  OpenAiCompatRequestError,
} from './openai-compat-llm.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
  'data: [DONE]\n',
];

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A client whose transport is replaced, plus what it was asked to send. */
function client(
  options: Partial<ConstructorParameters<typeof OpenAiCompatLlm>[0]> = {},
): {llm: OpenAiCompatLlm; calls: Captured[]} {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(streamOf(SSE_BODY), {status: 200});
  }) as unknown as typeof fetch;

  const llm = new OpenAiCompatLlm({
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:8137/v1',
    fetchImpl,
    ...options,
  });
  return {llm, calls};
}

function request(model = 'test-model'): LlmRequest {
  return {
    model,
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
  } as LlmRequest;
}

/** Drains the generator: the request is sent on the first step, not on `next`. */
async function drain(llm: OpenAiCompatLlm): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of llm.generateContentAsync(request(), true)) {
    out.push(chunk);
  }
  return out;
}

describe('OpenAiCompatLlm request shape', () => {
  it('posts to the engine address it was given', async () => {
    const {llm, calls} = client();
    await drain(llm);

    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:8137/v1/chat/completions',
    );
  });

  it('normalises a trailing slash rather than doubling it', async () => {
    const {llm, calls} = client({baseUrl: 'http://127.0.0.1:8137/v1/'});
    await drain(llm);

    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:8137/v1/chat/completions',
    );
  });

  it('always asks for a trailing usage chunk', async () => {
    const {llm, calls} = client();
    await drain(llm);

    expect(calls[0]!.body['stream_options']).toEqual({include_usage: true});
  });

  it('never sends an Authorization header', async () => {
    const {llm, calls} = client();
    await drain(llm);

    // Not `Bearer ` with nothing after it, and not a key: the engine this app
    // starts takes no credential, and an empty one is a claim that there is.
    expect(calls[0]!.headers).not.toHaveProperty('Authorization');
  });

  it('names the local model in an error the user will read', async () => {
    const llm = new OpenAiCompatLlm({
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:8137/v1',
      fetchImpl: (async () =>
        new Response('model not loaded', {
          status: 429,
        })) as unknown as typeof fetch,
    });

    await expect(drain(llm)).rejects.toThrow(OpenAiCompatRequestError);
    await expect(drain(llm)).rejects.toThrow(/The local model returned 429/);
  });
});
