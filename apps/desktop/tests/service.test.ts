/**
 * The parts of "keep jobs running" that can only be decided in the app.
 *
 * Which binary to name, where the runner script is, and which directory the
 * window is actually using. That last one is invariant 13: the app and the
 * runner resolve the same user-data directory, and when they do not nothing
 * errors — the window writes one `jobs.json`, the service reads another, finds
 * nothing due, and exits 0.
 *
 * The third answer here is the one that decides whether switching the service on
 * is honest: whether the provider a scheduled job would use is one a process with
 * no keychain can read. It is a fact about two documents — the catalogue and the
 * user's settings — and getting it wrong is a job that fails at nine in the
 * morning with nobody watching.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {PROVIDERS} from '@marimo/protocol';
import type {StoredSettings} from '@marimo/protocol';
import {defaultStoredSettings, resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {keysReadableIn, serviceSpec, statusOf} from '../src/main/service.js';
import type {ServiceContext} from '../src/main/service.js';

describe('the service definition', () => {
  let dir: string;
  let paths: AppPaths;
  let context: ServiceContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-service-'));
    paths = resolveAppPaths(dir);
    context = {
      paths,
      execPath: '/opt/marimo/marimo-agent',
      appPath: '/opt/marimo/resources/app.asar',
      home: '/home/sam',
      configHome: '/home/sam/.config',
      readSettings: async () => defaultStoredSettings(),
    };
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('names the app binary and the runner inside it', () => {
    const spec = serviceSpec(context);
    expect(spec.execPath).toBe('/opt/marimo/marimo-agent');
    /*
     * Inside the app, so the service runs the code that shipped with it rather
     * than a copy that can drift — and valid packaged, because Electron reads
     * inside an asar archive.
     */
    expect(spec.scriptPath).toBe(
      '/opt/marimo/resources/app.asar/dist/runner/run-due.js',
    );
  });

  /*
   * Invariant 13, from the app's side: the directory the window is using is the
   * one written into the definition, not one the runner would work out for
   * itself and possibly get wrong.
   */
  it('bakes in the directory the app is actually using', () => {
    expect(serviceSpec(context).userDataDir).toBe(dir);
  });

  it('wakes once a minute, which is the finest a schedule can ask for', () => {
    expect(serviceSpec(context).everyMinutes).toBe(1);
  });

  it('asks the app for the settings it is actually running under', async () => {
    /*
     * A provider whose key could never be decrypted: the status has to say so,
     * and the only way it can know is the document it was handed.
     */
    const settings = defaultStoredSettings();
    settings.providers.configs.deepseek.keyStorage = 'plaintext';
    context.readSettings = async () => settings;

    expect((await statusOf(context)).keysReadable).toBe(true);
  });
});

describe('keysReadableIn', () => {
  /** The stored settings with one provider active and one storage choice. */
  function withProvider(
    active: StoredSettings['providers']['active'],
    keyStorage: 'keychain' | 'plaintext',
  ): StoredSettings {
    const settings = defaultStoredSettings();
    settings.providers.active = active;
    settings.providers.configs[active].keyStorage = keyStorage;
    return settings;
  }

  it('is true for a provider that needs no key at all', () => {
    // The case the whole feature exists for: a server on the user's own machine
    // has nothing to decrypt, and a job on it works with the app closed.
    expect(PROVIDERS.llamacpp.requiresApiKey).toBe(false);
    expect(keysReadableIn(withProvider('llamacpp', 'keychain'))).toBe(true);
  });

  it('is true when the user let the key be stored readable', () => {
    expect(keysReadableIn(withProvider('deepseek', 'plaintext'))).toBe(true);
  });

  it('is false when the key is encrypted and the runner has no keychain', () => {
    expect(keysReadableIn(withProvider('deepseek', 'keychain'))).toBe(false);
  });
});
