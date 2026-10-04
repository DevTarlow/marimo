/**
 * The one OpenAI-compatible client, and the two places a provider's differences
 * actually reach the wire.
 *
 * Everything else about a request is identical across DeepSeek, a local
 * llama.cpp server and Gemini, which is the whole reason there is one client. The
 * exception is `stream_options`: Gemini's compatibility layer rejects it, and
 * sending it there fails every turn rather than costing a token count. That is
 * the kind of difference that is invisible until someone switches provider, so it
 * is pinned here.
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
    apiKey: 'k',
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
  it('asks DeepSeek for a trailing usage chunk', async () => {
    const {llm, calls} = client({provider: 'deepseek'});
    await drain(llm);

    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0]!.body['stream_options']).toEqual({include_usage: true});
    expect(calls[0]!.headers['Authorization']).toBe('Bearer k');
  });

  it('leaves stream_options off for Gemini', async () => {
    const {llm, calls} = client({provider: 'gemini'});
    await drain(llm);

    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    // The field is not merely empty: its absence is what the layer requires.
    expect(calls[0]!.body).not.toHaveProperty('stream_options');
  });

  it('keeps stream_options for a llama.cpp server', async () => {
    const {llm, calls} = client({provider: 'llamacpp'});
    await drain(llm);

    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(calls[0]!.body['stream_options']).toEqual({include_usage: true});
  });

  it('omits the header entirely when there is no key', async () => {
    const {llm, calls} = client({provider: 'llamacpp', apiKey: ''});
    await drain(llm);

    // Not `Bearer ` with nothing after it: a local server usually has no
    // credential at all, and an empty one is a claim that there is.
    expect(calls[0]!.headers).not.toHaveProperty('Authorization');
  });

  it('defaults to DeepSeek when no provider is named', async () => {
    const {llm, calls} = client();
    await drain(llm);

    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
  });

  it('names the provider in an error the user will read', async () => {
    const llm = new OpenAiCompatLlm({
      model: 'test-model',
      apiKey: 'k',
      provider: 'gemini',
      fetchImpl: (async () =>
        new Response('quota exceeded', {
          status: 429,
        })) as unknown as typeof fetch,
    });

    await expect(drain(llm)).rejects.toThrow(OpenAiCompatRequestError);
    await expect(drain(llm)).rejects.toThrow(/Google Gemini returned 429/);
  });
});
