/**
 * Reading a provider's model list.
 *
 * The list is what replaces the catalogue's placeholder names in the picker, so
 * the failure that matters is not a crash — it is a *quiet* one: a body this
 * code did not recognise turning into an empty list, which looks exactly like a
 * provider that offers nothing. Every unusable answer is therefore an error
 * here, and the shapes seen in the wild are pinned.
 */
import {describe, expect, it} from 'vitest';

import {
  fetchProviderModels,
  ProviderModelsError,
} from './provider-models.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers with one canned response and records the request. */
function respondWith(
  body: string,
  init: ResponseInit = {},
): {fetchImpl: typeof fetch; calls: Call[]} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, request?: RequestInit) => {
    calls.push({url: String(url), init: request});
    return new Response(body, {status: 200, ...init});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

function authorizationOf(call: Call): unknown {
  return (call.init?.headers as Record<string, string> | undefined)?.[
    'Authorization'
  ];
}

describe('fetchProviderModels', () => {
  it('reads the OpenAI `{data: [{id}]}` shape', async () => {
    const {fetchImpl} = respondWith(
      JSON.stringify({
        object: 'list',
        data: [{id: 'deepseek-chat'}, {id: 'deepseek-reasoner'}],
      }),
    );

    await expect(
      fetchProviderModels({provider: 'deepseek', apiKey: 'sk-x', fetchImpl}),
    ).resolves.toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('reads the older `{models: [...]}` shape local servers still send', async () => {
    const {fetchImpl} = respondWith(
      JSON.stringify({models: ['local-a', {id: 'local-b'}]}),
    );

    await expect(
      fetchProviderModels({provider: 'llamacpp', apiKey: '', fetchImpl}),
    ).resolves.toEqual(['local-a', 'local-b']);
  });

  it('asks the provider address, with a trailing slash collapsed', async () => {
    const {fetchImpl, calls} = respondWith(JSON.stringify({data: [{id: 'm'}]}));

    await fetchProviderModels({
      provider: 'gemini',
      apiKey: 'k',
      baseUrl: 'https://example.test/v1/',
      fetchImpl,
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://example.test/v1/models',
    ]);
  });

  it('sends the key as a bearer token, and nothing when there is no key', async () => {
    const withKey = respondWith(JSON.stringify({data: [{id: 'm'}]}));
    await fetchProviderModels({
      provider: 'deepseek',
      apiKey: 'sk-secret',
      fetchImpl: withKey.fetchImpl,
    });
    expect(authorizationOf(withKey.calls[0]!)).toBe('Bearer sk-secret');

    const withoutKey = respondWith(JSON.stringify({data: [{id: 'm'}]}));
    await fetchProviderModels({
      provider: 'llamacpp',
      apiKey: '',
      fetchImpl: withoutKey.fetchImpl,
    });
    // An empty `Bearer ` would claim a credential that is not there.
    expect(authorizationOf(withoutKey.calls[0]!)).toBeUndefined();
  });

  it('keeps the endpoint order and drops blanks and duplicates', async () => {
    const {fetchImpl} = respondWith(
      JSON.stringify({
        data: [{id: ' b '}, {id: 'a'}, {id: 'b'}, {id: ''}, {nope: true}],
      }),
    );

    await expect(
      fetchProviderModels({provider: 'openrouter', apiKey: 'k', fetchImpl}),
    ).resolves.toEqual(['b', 'a']);
  });

  it('refuses a non-2xx answer, naming the status and the body', async () => {
    const {fetchImpl} = respondWith(
      JSON.stringify({error: {message: 'invalid key'}}),
      {status: 401},
    );

    const failure = await fetchProviderModels({
      provider: 'deepseek',
      apiKey: 'bad',
      fetchImpl,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderModelsError);
    expect((failure as ProviderModelsError).status).toBe(401);
    expect((failure as Error).message).toContain('401');
    expect((failure as Error).message).toContain('invalid key');
  });

  it('refuses an answer that lists nothing', async () => {
    const {fetchImpl} = respondWith(JSON.stringify({object: 'list', data: []}));

    await expect(
      fetchProviderModels({provider: 'deepseek', apiKey: 'k', fetchImpl}),
    ).rejects.toThrow(/listed no models/u);
  });

  it('refuses an answer that is not JSON', async () => {
    const {fetchImpl} = respondWith('<html>nope</html>');

    await expect(
      fetchProviderModels({provider: 'deepseek', apiKey: 'k', fetchImpl}),
    ).rejects.toThrow(/did not answer with JSON/u);
  });

  it('reports an unreachable endpoint as the provider and address', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;

    await expect(
      fetchProviderModels({
        provider: 'llamacpp',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:9999/v1',
        fetchImpl,
      }),
    ).rejects.toThrow(
      /Could not reach Local at http:\/\/127\.0\.0\.1:9999\/v1/u,
    );
  });
});
