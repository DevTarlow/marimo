/**
 * Where the engine and the weights are found.
 *
 * The failure this pins is the quiet one: the window has Electron and asks it
 * for `process.resourcesPath`, while the headless runner — the same binary
 * started as plain Node — has to derive the same directory from the executable's
 * path. When the two disagree, nothing errors. The window answers questions and
 * a scheduled job, running with the app closed, reports the model as not
 * installed, which looks like a feature that was never built rather than a path
 * that is wrong.
 */
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  bundledModelDir,
  localModelSpec,
  MODEL_FILE_NAME,
  resolveLocalModelFiles,
} from './files.js';

describe('bundledModelDir', () => {
  it('uses the resources directory when Electron hands one over', () => {
    expect(
      bundledModelDir({
        resourcesPath: '/opt/Marimo/resources',
        execPath: '/opt/Marimo/marimo-agent',
      }),
    ).toBe(join('/opt/Marimo/resources', 'local-model'));
  });

  /*
   * The runner: no `app`, no `process.resourcesPath`, one executable to reason
   * from. On Linux and Windows the resources sit beside it.
   */
  it('derives the same directory from the executable when there is no app', () => {
    expect(
      bundledModelDir({
        resourcesPath: undefined,
        execPath: join('/opt', 'Marimo Agent', 'marimo-agent'),
        platform: 'linux',
      }),
    ).toBe(join('/opt', 'Marimo Agent', 'resources', 'local-model'));

    expect(
      bundledModelDir({
        resourcesPath: undefined,
        execPath: join('C:', 'Apps', 'marimo-agent.exe'),
        platform: 'win32',
      }),
    ).toBe(join('C:', 'Apps', 'resources', 'local-model'));
  });

  /* macOS is the one that differs: the binary is in Contents/MacOS. */
  it('walks up one more level on macOS', () => {
    expect(
      bundledModelDir({
        resourcesPath: undefined,
        execPath: join(
          '/Applications',
          'Marimo Agent.app',
          'Contents',
          'MacOS',
          'marimo-agent',
        ),
        platform: 'darwin',
      }),
    ).toBe(
      join(
        '/Applications',
        'Marimo Agent.app',
        'Contents',
        'Resources',
        'local-model',
      ),
    );
  });

  /* A process whose executable is not where a bundle is simply has no model. */
  it('reports no directory when there is nothing to derive from', () => {
    expect(
      bundledModelDir({resourcesPath: '', execPath: '', platform: 'linux'}),
    ).toBe(join('', 'resources', 'local-model'));
  });
});

describe('resolveLocalModelFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-localfiles-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  /** A directory shaped like a packaged app's resources. */
  async function shipped(options: {engine?: boolean; model?: boolean} = {}) {
    const resources = join(dir, 'resources');
    const root = join(resources, 'local-model');
    await mkdir(join(root, 'engine'), {recursive: true});
    if (options.engine !== false) {
      await writeFile(join(root, 'engine', 'llama-server'), 'binary', 'utf8');
    }
    if (options.model !== false) {
      await writeFile(join(root, MODEL_FILE_NAME), 'weights', 'utf8');
    }
    return resources;
  }

  it('finds both halves of a packaged install', async () => {
    const resources = await shipped();
    const files = resolveLocalModelFiles({
      env: {},
      resourcesPath: resources,
      execPath: '/opt/marimo-agent',
      platform: 'linux',
    });

    expect(files.modelPresent).toBe(true);
    expect(files.enginePresent).toBe(true);
    expect(files.model).toBe(join(resources, 'local-model', MODEL_FILE_NAME));
    expect(files.engine).toBe(
      join(resources, 'local-model', 'engine', 'llama-server'),
    );
    // The libraries sit beside the binary, which is also where it is run from.
    expect(files.libraryDir).toBe(join(resources, 'local-model', 'engine'));
  });

  it('names the engine with the extension Windows needs', async () => {
    const resources = await shipped();
    await mkdir(join(resources, 'local-model', 'engine'), {recursive: true});
    const files = resolveLocalModelFiles({
      env: {},
      resourcesPath: resources,
      execPath: 'C:\\marimo-agent.exe',
      platform: 'win32',
    });
    expect(files.engine.endsWith('llama-server.exe')).toBe(true);
  });

  /*
   * The override is for the three cases the shipped file cannot cover: a
   * checkout with no weights in it, a machine that cannot run this model, and
   * somebody who already has one. It wins over the shipped copy rather than the
   * other way round — a setting a file on disk can silently outrank is a setting
   * that does not work.
   */
  it('prefers the directory the environment names', async () => {
    const resources = await shipped();
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(join(elsewhere, 'engine'), {recursive: true});
    await writeFile(
      join(elsewhere, 'engine', 'llama-server'),
      'binary',
      'utf8',
    );
    await writeFile(join(elsewhere, MODEL_FILE_NAME), 'weights', 'utf8');

    const files = resolveLocalModelFiles({
      env: {MARIMO_MODEL_DIR: elsewhere},
      resourcesPath: resources,
      execPath: '/opt/marimo-agent',
      platform: 'linux',
    });

    expect(files.dir).toBe(elsewhere);
    expect(files.modelPresent).toBe(true);
    expect(files.enginePresent).toBe(true);
  });

  it('prefers a .gguf the user named over the one that shipped', async () => {
    const resources = await shipped();
    const mine = join(dir, 'my-model.gguf');
    await writeFile(mine, 'weights', 'utf8');

    const files = resolveLocalModelFiles({
      ggufPath: mine,
      env: {},
      resourcesPath: resources,
      execPath: '/opt/marimo-agent',
      platform: 'linux',
    });

    expect(files.model).toBe(mine);
    expect(files.modelPresent).toBe(true);
    // The engine is still the shipped one: this setting replaces the weights.
    expect(files.enginePresent).toBe(true);
  });

  /*
   * What an install that has not fetched the weights looks like — a development
   * checkout, or a build made without the model. It has to be reportable rather
   * than assumed, because the sentence the user gets depends on which half is
   * missing.
   */
  it('says which half is missing rather than failing later', async () => {
    const resources = await shipped({model: false});
    const files = resolveLocalModelFiles({
      env: {},
      resourcesPath: resources,
      execPath: '/opt/marimo-agent',
      platform: 'linux',
    });

    expect(files.enginePresent).toBe(true);
    expect(files.modelPresent).toBe(false);
  });

  /*
   * A directory named like the weights would pass an existence check and then
   * fail inside the engine, with a complaint about a file it cannot open.
   */
  it('does not count a directory as the model file', async () => {
    const resources = await shipped({model: false});
    await mkdir(join(resources, 'local-model', MODEL_FILE_NAME), {
      recursive: true,
    });
    const files = resolveLocalModelFiles({
      env: {},
      resourcesPath: resources,
      execPath: '/opt/marimo-agent',
      platform: 'linux',
    });

    expect(files.modelPresent).toBe(false);
  });

  it('reports nothing present when the directory is empty', () => {
    const files = resolveLocalModelFiles({
      env: {},
      resourcesPath: join(dir, 'nowhere'),
      execPath: '/opt/marimo-agent',
      platform: 'linux',
    });

    expect(files.enginePresent).toBe(false);
    expect(files.modelPresent).toBe(false);
  });
});

/*
 * The one answer both processes build.
 *
 * The window has Electron and hands over `process.resourcesPath`; the runner has
 * no `app` and lets the path be derived from its own executable. Everything else
 * — which file, how much context, whether it thinks — comes from the settings,
 * and it has to come out the same in both or a scheduled job answers questions
 * with a model the window is not using.
 */
describe('localModelSpec', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-spec-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  const settings = (
    overrides: Partial<{
      ggufPath: string;
      contextSize: number;
      thinking: boolean;
    }> = {},
  ) => ({
    localModel: {
      ggufPath: '',
      contextSize: 8192,
      thinking: false,
      ...overrides,
    },
  });

  it('carries the two settings the engine is started with', () => {
    const spec = localModelSpec(
      settings({contextSize: 32768, thinking: true}),
      {resourcesPath: '/opt/resources', execPath: '/opt/marimo-agent'},
    );

    expect(spec.contextSize).toBe(32768);
    expect(spec.thinking).toBe(true);
  });

  it('finds the shipped model when the settings name none', () => {
    const spec = localModelSpec(settings(), {
      resourcesPath: join(dir, 'resources'),
      execPath: '/opt/marimo-agent',
    });

    expect(spec.files.model).toBe(
      join(dir, 'resources', 'local-model', MODEL_FILE_NAME),
    );
  });

  it('uses the file the user named instead', () => {
    const spec = localModelSpec(settings({ggufPath: '/home/me/other.gguf'}), {
      resourcesPath: join(dir, 'resources'),
      execPath: '/opt/marimo-agent',
    });

    expect(spec.files.model).toBe('/home/me/other.gguf');
  });

  /* The runner's case: no `resourcesPath` at all. */
  it('derives the same directory when there is no app to ask', () => {
    const spec = localModelSpec(settings(), {
      resourcesPath: undefined,
      execPath: join(dir, 'marimo-agent'),
      platform: 'linux',
    });

    expect(spec.files.dir).toBe(join(dir, 'resources', 'local-model'));
  });
});
