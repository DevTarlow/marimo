/**
 * The parts of "keep jobs running" that can only be decided in the app.
 *
 * Which binary to name, where the runner script is, and which directory the
 * window is actually using. That last one is invariant 13: the app and the
 * runner resolve the same user-data directory, and when they do not nothing
 * errors — the window writes one `jobs.json`, the service reads another, finds
 * nothing due, and exits 0.
 *
 * There used to be a third answer here, about whether a stored API key was one a
 * windowless process could read. It went with the key: a background run needs no
 * secret at all, because the model is a local engine and the runner dials no
 * connectors.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {serviceSpec} from '../src/main/service.js';
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
