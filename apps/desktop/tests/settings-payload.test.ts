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
 *
 * The payload grew a field that is *named* like a credential when the provider
 * catalogue came back — `providerKeys` — and it is the one field here whose name
 * the walk below cannot be allowed to pass over. It carries booleans, so the
 * second check is the one that matters: an entry named `...key` or `...keys`
 * holding anything but a boolean is a value that crossed the boundary, and this
 * file fails on it rather than trusting the name.
 */
import {describe, expect, it} from 'vitest';

import {defaultStoredSettings} from '@marimo/runtime';

/** The fields of a settings payload that could ever hold a credential. */
const FORBIDDEN = ['apikey', 'key', 'token', 'secret', 'password'] as const;

/**
 * The words a field is allowed to be named after while holding a boolean.
 *
 * A key that is *stored* is a fact about a provider — "there is one" — and that
 * is the only thing this app reports. A key that is *held* is the credential
 * itself, and the two are one value apart.
 */
const BOOLEAN_ONLY = ['key', 'keys', 'apikey', 'apikeys'] as const;

/**
 * Whether a JSON value contains anything that looks like a stored credential.
 *
 * Checked by key name rather than by value: a key that happened to be short
 * would not be caught by a length or entropy test, and a false positive is
 * cheaper here than a leak.
 *
 * The last *word* of the name rather than the whole string, so `botToken` is
 * caught as well as `bot_token` — the app writes camelCase, and a guard that
 * only knew snake_case would pass over exactly the field a hurried change would
 * add. Whole words, so `secrets` (which names where a value goes, not what it
 * is) is not a false positive.
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
      const lastWord = (key.split(/(?=[A-Z])|_/u).pop() ?? '').toLowerCase();
      const looksSecret = FORBIDDEN.some((word) => lastWord === word);
      return [
        ...(looksSecret ? [here] : []),
        ...credentialFieldsIn(entry, here),
      ];
    },
  );
}

/**
 * Every entry named after a key, and whether it holds a boolean.
 *
 * The value rather than the name, because the name is now allowed: `providerKeys`
 * exists so the window can draw a filled-in field, and it is exactly the field a
 * hurried change would put the key itself into — "it is already called keys" is
 * how that reads at the call site, and the payload would look identical from
 * outside.
 *
 * A *map* of booleans is the one shape that survives this: `providerKeys` is a
 * record, so the check is over its values and each of them has to be a boolean.
 * Any other object under a key-named field is a credential until proven
 * otherwise, which is the answer that costs a false positive rather than a leak.
 */
function keyEntries(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      const here = path.length > 0 ? `${path}.${key}` : key;
      const lastWord = (key.split(/(?=[A-Z])|_/u).pop() ?? '').toLowerCase();
      if (!BOOLEAN_ONLY.some((word) => lastWord === word)) {
        return keyEntries(entry, here);
      }
      if (typeof entry === 'boolean') {
        return [];
      }
      const values = plainRecord(entry);
      if (values === undefined) {
        return [here];
      }
      return Object.entries(values).flatMap(([name, flag]) =>
        typeof flag === 'boolean' ? [] : [`${here}.${name}`],
      );
    },
  );
}

/** The value as a plain object, or `undefined` for anything else. */
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

describe('a settings payload', () => {
  /*
   * The real shape, as `settings.get` builds it: the stored settings spread,
   * plus the facts the window is allowed to see.
   */
  function payload(): Record<string, unknown> {
    return {
      ...defaultStoredSettings(),
      modelReady: true,
      providerKeys: {deepseek: true, llamacpp: false},
      encryptionAvailable: true,
      availableModels: ['deepseek-flash'],
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
    expect(credentialFieldsIn({...payload(), apiKey: 'sk-test'})).toEqual([
      'apiKey',
    ]);
    expect(
      credentialFieldsIn({
        ...payload(),
        mcpServers: [{secrets: [], token: 'x'}],
      }),
    ).toContain('mcpServers[0].token');
    expect(
      credentialFieldsIn({
        ...payload(),
        discord: {botToken: 'x'},
      }),
    ).toContain('discord.botToken');
  });

  /*
   * The other half of invariant 8 now that a field is legitimately named like a
   * credential: `providerKeys` may say *whether* a key is stored and never what
   * it is, and the only way to tell those apart is to look at the value.
   */
  it('reports a stored key as a boolean, never as a string', () => {
    expect(keyEntries(payload())).toEqual([]);
  });

  it('would notice a key smuggled into the provider booleans', () => {
    expect(
      keyEntries({...payload(), providerKeys: {deepseek: 'sk-test'}}),
    ).toEqual(['providerKeys.deepseek']);
    // The name alone is not the check: a boolean anywhere else is fine, and a
    // string under a name that is not a key is somebody else's field.
    expect(keyEntries({...payload(), providerKeys: {deepseek: true}})).toEqual(
      [],
    );
  });

  it('reports a connector as a name and a target, never a value', () => {
    /*
     * The shape a saved connector actually has. `secrets` names where a value
     * goes; the value lives in the keychain and is never read back into this
     * payload. This is the assertion that would break first if somebody stored
     * one here for convenience.
     */
    const payloadWithConnector = {
      ...payload(),
      mcpServers: [
        {
          id: 'notes',
          name: 'Notes',
          transport: 'stdio',
          command: 'notes-mcp',
          secrets: [{target: 'env', name: 'NOTES_TOKEN'}],
        },
      ],
    };

    expect(credentialFieldsIn(payloadWithConnector)).toEqual([]);
  });
});
