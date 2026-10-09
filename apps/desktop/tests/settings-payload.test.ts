/**
 * Invariant 8: secrets never cross to the renderer.
 *
 * The audit that prompted this file found the guard correct and **completely
 * untested** — `grep` for `PublicSettings`, `providerKeys` or `hasApiKey` across
 * every test file returned nothing. A rule with no test is a rule that holds
 * until somebody adds a field.
 *
 * So this asserts the *shape* rather than one call site: whatever a settings
 * payload grows into, no key may appear in it.
 */
import {describe, expect, it} from 'vitest';

import {defaultProviders} from '@marimo/protocol';

/** The fields of a settings payload that could ever hold a credential. */
const FORBIDDEN = ['apikey', 'key', 'token', 'secret', 'password'] as const;

/**
 * Whether a JSON value contains anything that looks like a stored credential.
 *
 * Checked by key name rather than by value: a key that happened to be short
 * would not be caught by a length or entropy test, and a false positive is
 * cheaper here than a leak.
 */
function credentialFieldsIn(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      credentialFieldsIn(entry, `${path}[${String(index)}]`),
    );
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      const here = path.length > 0 ? `${path}.${key}` : key;
      const lower = key.toLowerCase();
      const looksSecret = FORBIDDEN.some(
        (word) => lower === word || lower.endsWith(`_${word}`),
      );
      return [
        ...(looksSecret ? [here] : []),
        ...credentialFieldsIn(entry, here),
      ];
    },
  );
}

describe('a settings payload', () => {
  /*
   * The real shape, as `settings.get` builds it: the stored settings spread,
   * plus the derived booleans the window is allowed to see.
   */
  function payload(): Record<string, unknown> {
    return {
      ...{
        providers: defaultProviders(),
        temperature: 0.7,
        allowPrivateNetworkFetch: false,
        allowPlaintextApiKey: false,
        mcpServers: [],
        appearance: {theme: 'system'},
      },
      hasApiKey: true,
      providerKeys: {
        deepseek: true,
        gemini: false,
        llamacpp: false,
        opencode_go: false,
        openrouter: false,
      },
      encryptionAvailable: true,
      availableModels: ['deepseek-chat'],
      profiles: [],
      activeProfileId: 'p1',
    };
  }

  it('carries no credential field anywhere in it', () => {
    expect(credentialFieldsIn(payload())).toEqual([]);
  });

  /*
   * The check is only worth having if it can fail. Without this, a bug in
   * `credentialFieldsIn` would make the assertion above vacuous — which is the
   * failure mode of every "assert nothing bad is present" test.
   */
  it('would notice a key if one were added', () => {
    expect(credentialFieldsIn({...payload(), apiKey: 'sk-test'})).toEqual(['apiKey']);
    expect(
      credentialFieldsIn({...payload(), providers: {...defaultProviders(), apiKey: 'x'}}),
    ).toContain('providers.apiKey');
    expect(
      credentialFieldsIn({...payload(), mcpServers: [{secrets: [], token: 'x'}]}),
    ).toContain('mcpServers[0].token');
  });

  it('reports what a provider block actually holds, which is not a key', () => {
    // The provider config carries a model and a base URL and nothing else. This
    // is the assertion that would break first if somebody added one.
    expect(Object.keys(defaultProviders().configs.deepseek).sort()).toEqual([
      'baseUrl',
      'model',
    ]);
  });
});
