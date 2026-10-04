/**
 * The parts of "keep jobs running" that can only be decided in the app.
 *
 * Which binary to name, and whether the stored key is one a windowless process
 * could read. The second is the whole reason this file exists: switching the
 * service on over an encrypted key does not fail loudly — it runs every minute,
 * refuses for want of a key, and records that, with nobody watching.
 */
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';
import {defaultProviders} from '@marimo/protocol';

import {keysAreReadable, serviceSpec} from '../src/main/service.js';
import type {ServiceContext} from '../src/main/service.js';

/** A key file, in the shape the app writes. */
async function writeKey(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(path, contents, 'utf8');
}

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
      providers: async () => defaultProviders(),
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
});

describe('whether the runner could read the key', () => {
  let dir: string;
  let paths: AppPaths;
  let context: ServiceContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-service-key-'));
    paths = resolveAppPaths(dir);
    context = {
      paths,
      execPath: '/opt/marimo/marimo-agent',
      appPath: '/opt/marimo/app.asar',
      home: '/home/sam',
      configHome: '/home/sam/.config',
      providers: async () => defaultProviders(),
    };
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  /** The file the active provider's key lives in. */
  function keyFile(): string {
    const provider = defaultProviders();
    return paths.providerSecrets[provider.active];
  }

  it('is true when the key is stored as plain text', async () => {
    await writeKey(keyFile(), `plaintext:${Buffer.from('sk-abc').toString('base64')}`);
    expect(await keysAreReadable(context)).toBe(true);
  });

  /*
   * The case the warning exists for. A process with no keychain — which is what
   * the runner is — cannot decrypt this, so a service switched on over it would
   * run every minute and stop at the key every time.
   */
  it('is false when the key is encrypted', async () => {
    await writeKey(keyFile(), `encrypted:${Buffer.from('whatever').toString('base64')}`);
    expect(await keysAreReadable(context)).toBe(false);
  });

  /*
   * A key that has not been entered yet is a different problem, and blaming
   * encryption for it would send the user to the wrong setting.
   */
  it('is true when there is no key at all', async () => {
    expect(await keysAreReadable(context)).toBe(true);
  });

  it('is false on a file it cannot make sense of, rather than optimistic', async () => {
    await writeKey(keyFile(), 'something else entirely');
    expect(await keysAreReadable(context)).toBe(false);
  });

  it('is false when the settings themselves cannot be read', async () => {
    const broken: ServiceContext = {
      ...context,
      providers: async () => {
        throw new Error('the settings file is unreadable');
      },
    };
    expect(await keysAreReadable(broken)).toBe(false);
  });
});
