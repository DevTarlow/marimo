import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {FileSecretStore} from './secrets.js';
import type {SecretCipher} from './secrets.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marimo-secrets-'));
  file = join(dir, 'deepseek.bin');
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

/** Stands in for `safeStorage`, with a transform that is obvious in a failure. */
const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(`sealed(${value})`, 'utf8'),
  decrypt: (payload) => payload.toString('utf8').replace(/^sealed\(|\)$/gu, ''),
};

const noKeychain: SecretCipher = {
  available: () => false,
  encrypt: () => {
    throw new Error('no keychain');
  },
  decrypt: () => {
    throw new Error('no keychain');
  },
};

describe('FileSecretStore', () => {
  it('reports a missing secret as absent, not as an error', async () => {
    const store = new FileSecretStore(file);
    expect(await store.read()).toEqual({state: 'absent'});
    expect(await store.has()).toBe(false);
    expect(await store.get()).toBe('');
  });

  it('round-trips a plaintext secret', async () => {
    const store = new FileSecretStore(file, 'API key', noKeychain);
    await store.set('sk-secret', {allowPlaintext: true});

    expect(await store.get()).toBe('sk-secret');
    expect((await store.read()).state).toBe('present');
  });

  it('writes a plaintext secret readable only by its owner', async () => {
    const store = new FileSecretStore(file, 'API key', noKeychain);
    await store.set('sk-secret', {allowPlaintext: true});

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  /*
   * The case the background service depends on, and the one the flag used to get
   * wrong. On a normal desktop a keychain *is* available, so encrypting whenever
   * possible meant the key was always encrypted — and a headless runner has no
   * keychain, so "run jobs while the app is closed" could never work while the
   * settings screen said it could.
   *
   * A security setting that produces the opposite of what it promises is the
   * worst shape one can take.
   */
  it('writes a readable secret even when a keychain is available, if asked', async () => {
    const store = new FileSecretStore(file, 'API key', cipher);
    await store.set('sk-secret', {allowPlaintext: true});

    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('plaintext:');
    expect(raw).not.toContain('encrypted:');
    // ...and the keychain-less reader is the one that has to be able to read it.
    const headless = new FileSecretStore(file, 'API key');
    expect(await headless.get()).toBe('sk-secret');
  });

  it('encrypts by default even when plaintext would be permitted elsewhere', async () => {
    const store = new FileSecretStore(file, 'API key', cipher);
    await store.set('sk-secret', {allowPlaintext: false});

    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('encrypted:');
    // And a process with no keychain — the runner — cannot read it.
    expect(await new FileSecretStore(file, 'API key').read()).toMatchObject({
      state: 'unreadable',
    });
  });

  it('round-trips an encrypted secret through the cipher', async () => {
    const store = new FileSecretStore(file, 'API key', cipher);
    await store.set('sk-secret', {allowPlaintext: false});

    // The point of the encrypted path is that the value is not on disk.
    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('encrypted:');
    expect(raw).not.toContain('sk-secret');

    expect(await store.get()).toBe('sk-secret');
  });

  /*
   * The distinction the whole read shape exists for. "No key yet" and "a key I
   * cannot decrypt" need different things from the user, and the headless runner
   * has to be able to say which one it hit.
   */
  it('says unreadable, not absent, when it cannot decrypt', async () => {
    await writeFile(file, `encrypted:${Buffer.from('sealed(x)').toString('base64')}\n`);

    const headless = new FileSecretStore(file, 'API key');
    const read = await headless.read();

    expect(read.state).toBe('unreadable');
    if (read.state === 'unreadable') {
      expect(read.reason).toContain('keychain');
    }
    // `get()` is the lenient door for callers that only want a value.
    expect(await headless.get()).toBe('');
  });

  it('says unreadable when the keychain refuses to decrypt', async () => {
    await writeFile(file, `encrypted:${Buffer.from('sealed(x)').toString('base64')}\n`);

    const broken: SecretCipher = {
      available: () => true,
      encrypt: cipher.encrypt,
      decrypt: () => {
        throw new Error('keychain rotated');
      },
    };

    const read = await new FileSecretStore(file, 'API key', broken).read();
    expect(read.state).toBe('unreadable');
    if (read.state === 'unreadable') {
      expect(read.reason).toContain('Enter it again');
    }
  });

  it('reads a plaintext secret even when a cipher is available', async () => {
    // What the app must do for a user who enabled the plain-text opt-in on a
    // machine whose keychain later became available: their key still works.
    await writeFile(file, `plaintext:${Buffer.from('sk-legacy').toString('base64')}\n`);
    const store = new FileSecretStore(file, 'API key', cipher);
    expect(await store.get()).toBe('sk-legacy');
  });

  it('refuses to write a readable secret without permission', async () => {
    const store = new FileSecretStore(file, 'Discord bot token', noKeychain);

    await expect(
      store.set('token', {allowPlaintext: false}),
    ).rejects.toThrow(/Discord bot token/u);

    // And it must not have written anything on the way to refusing.
    expect(await store.read()).toEqual({state: 'absent'});
  });

  it('clears the file when the value is empty, rather than storing nothing', async () => {
    const store = new FileSecretStore(file, 'API key', cipher);
    await store.set('sk-secret', {allowPlaintext: false});
    expect((await store.read()).state).toBe('present');

    await store.set('   ', {allowPlaintext: false});
    expect((await store.read()).state).toBe('absent');
  });

  it('reports a foreign file as unreadable rather than as absent', async () => {
    await writeFile(file, 'this is not a secret file\n', 'utf8');
    const read = await new FileSecretStore(file).read();
    expect(read.state).toBe('unreadable');
  });

  it('creates the secrets directory when it is missing', async () => {
    const nested = join(dir, 'a', 'b', 'key.bin');
    const store = new FileSecretStore(nested, 'API key', cipher);
    await store.set('sk-secret', {allowPlaintext: false});
    expect(await store.get()).toBe('sk-secret');
  });

  it('treats a keychain that throws as unavailable', () => {
    const throwing: SecretCipher = {
      available: () => {
        throw new Error('no session bus');
      },
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
    };
    expect(new FileSecretStore(file, 'API key', throwing).isEncryptionAvailable()).toBe(
      false,
    );
  });
});
