/**
 * Where the engine and the weights are found.
 *
 * The failure this file has always pinned is the quiet one, and it has changed
 * shape: the model used to be bundled, so the window asked Electron for
 * `process.resourcesPath` while the headless runner derived the directory from its
 * own executable, and when the two disagreed nothing errored — the window answered
 * questions while a scheduled job reported the model as not installed.
 *
 * The model is downloaded now, so it lives in the user-data directory both
 * processes already resolve the same way. What is left to get wrong is smaller and
 * still worth pinning: the override has to win, the file name has to follow the
 * tier, and "installed" has to mean the right bytes are there rather than that a
 * file with the right name exists.
 */
import {mkdir, mkdtemp, rm, truncate, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {parseManifest} from './manifest.js';
import type {LocalModelManifest} from './manifest.js';
import {
  engineBinaryName,
  engineDir,
  installedTiers,
  localModelSpec,
  MODEL_DIR_ENV,
  MODEL_DIR_NAME,
  modelDir,
  resolveLocalModelFiles,
} from './files.js';

function manifest(): LocalModelManifest {
  return parseManifest({
    engine: {
      tag: 'b1',
      baseUrl: 'https://example.test/dl',
      assets: {'linux-x64': {file: 'e.tar.gz', sha256: 'a'.repeat(64)}},
      backends: {'linux-x64': 'Vulkan'},
    },
    weights: {
      repo: 'someone/model-GGUF',
      revision: 'deadbeef',
      license: 'Apache-2.0',
      kvBytesPerToken: 32768,
      tiers: {
        low: {
          label: 'Low',
          file: 'low.gguf',
          sha256: 'b'.repeat(64),
          bytes: 2_740_937_888,
          contextSize: 16384,
        },
        high: {
          label: 'High',
          file: 'high.gguf',
          sha256: 'c'.repeat(64),
          bytes: 4_482_403_488,
          contextSize: 32768,
        },
      },
    },
  });
}

describe('modelDir', () => {
  it('lives under the user-data directory both processes already agree on', () => {
    expect(modelDir({userData: '/home/sam/.config/Marimo', env: {}})).toBe(
      join('/home/sam/.config/Marimo', MODEL_DIR_NAME),
    );
  });

  /*
   * The override wins rather than the other way round: a development checkout and
   * the smoke check both point at a directory of their own, and a default a
   * checkout cannot outrank is one that does not work.
   */
  it('lets the environment point somewhere else', () => {
    expect(
      modelDir({
        userData: '/home/sam/.config/Marimo',
        env: {[MODEL_DIR_ENV]: '/opt/weights'},
      }),
    ).toBe('/opt/weights');
  });

  it('ignores an empty override rather than resolving to nothing', () => {
    expect(
      modelDir({
        userData: '/data',
        env: {[MODEL_DIR_ENV]: ''},
      }),
    ).toBe(join('/data', MODEL_DIR_NAME));
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

  /** A directory shaped like an install that has been downloaded. */
  async function downloaded(
    options: {engine?: boolean; tier?: 'low' | 'high'} = {},
  ) {
    const root = join(dir, 'model');
    await mkdir(join(root, 'engine'), {recursive: true});
    if (options.engine !== false) {
      await writeFile(
        join(root, 'engine', engineBinaryName('linux')),
        'binary',
        'utf8',
      );
    }
    const tier = options.tier ?? 'low';
    await writeFile(join(root, manifest().weights.tiers[tier].file), 'w', 'utf8');
    return root;
  }

  it('finds the engine and the tier’s weights', async () => {
    const root = await downloaded();
    const files = resolveLocalModelFiles({
      dir: root,
      manifest: manifest(),
      tier: 'low',
      platform: 'linux',
    });

    expect(files.enginePresent).toBe(true);
    expect(files.modelPresent).toBe(true);
    expect(files.engine).toBe(join(root, 'engine', 'llama-server'));
    expect(files.model).toBe(join(root, 'low.gguf'));
    // The libraries sit beside the binary, which is also where it is run from.
    expect(files.libraryDir).toBe(join(root, 'engine'));
  });

  /*
   * The tier decides the file name, and that is the whole reason two tiers exist.
   * A default here would be a second place the decision could be made differently
   * from the plan that made it.
   */
  it('names the file after the tier, not a constant', () => {
    const root = join(dir, 'model');
    const low = resolveLocalModelFiles({
      dir: root,
      manifest: manifest(),
      tier: 'low',
      platform: 'linux',
    });
    const high = resolveLocalModelFiles({
      dir: root,
      manifest: manifest(),
      tier: 'high',
      platform: 'linux',
    });
    expect(low.model).not.toBe(high.model);
    expect(high.model.endsWith('high.gguf')).toBe(true);
  });

  it('names the engine with the extension Windows needs', () => {
    const files = resolveLocalModelFiles({
      dir: join(dir, 'model'),
      manifest: manifest(),
      tier: 'low',
      platform: 'win32',
    });
    expect(files.engine.endsWith('llama-server.exe')).toBe(true);
  });

  /*
   * What an install that has been started and not finished looks like: the engine
   * is there and the weights are not. It has to be reportable rather than assumed,
   * because the sentence the user gets depends on which half is missing.
   */
  it('says which half is missing rather than failing later', async () => {
    const root = await downloaded({tier: 'low'});
    const files = resolveLocalModelFiles({
      dir: root,
      manifest: manifest(),
      tier: 'high',
      platform: 'linux',
    });

    expect(files.enginePresent).toBe(true);
    expect(files.modelPresent).toBe(false);
  });

  /*
   * A directory named like the weights would pass an existence check and then fail
   * inside the engine, with a complaint about a file it cannot open.
   */
  it('does not count a directory as the model file', async () => {
    const root = join(dir, 'model');
    await mkdir(join(root, 'low.gguf'), {recursive: true});
    const files = resolveLocalModelFiles({
      dir: root,
      manifest: manifest(),
      tier: 'low',
      platform: 'linux',
    });
    expect(files.modelPresent).toBe(false);
  });

  it('reports nothing present for a directory that does not exist', () => {
    const files = resolveLocalModelFiles({
      dir: join(dir, 'nowhere'),
      manifest: manifest(),
      tier: 'low',
      platform: 'linux',
    });
    expect(files.enginePresent).toBe(false);
    expect(files.modelPresent).toBe(false);
  });

  it('answers nothing at all when there is no directory to look in', () => {
    const files = resolveLocalModelFiles({
      dir: '',
      manifest: manifest(),
      tier: 'low',
      platform: 'linux',
    });
    expect(files.engine).toBe('');
    expect(files.model).toBe('');
    expect(files.enginePresent).toBe(false);
  });
});

describe('installedTiers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-installed-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  /*
   * Size, not presence. Hashing 4.5 GB on every launch is not an option, and a
   * name check would count the interrupted download that matters — a file that
   * looks finished and is not.
   */
  it('counts a tier only when the pinned number of bytes is there', async () => {
    const tier = manifest().weights.tiers.low;
    await writeFile(join(dir, tier.file), 'short', 'utf8');
    expect(installedTiers({dir, manifest: manifest()})).toEqual([]);
  });

  it('finds a tier whose weights are the pinned size', async () => {
    await sized(manifest().weights.tiers.low.file, manifest().weights.tiers.low.bytes);
    expect(installedTiers({dir, manifest: manifest()})).toEqual(['low']);
  });

  it('finds both when both are there', async () => {
    const tiers = manifest().weights.tiers;
    await sized(tiers.low.file, tiers.low.bytes);
    await sized(tiers.high.file, tiers.high.bytes);
    expect(installedTiers({dir, manifest: manifest()})).toEqual(['low', 'high']);
  });

  /*
   * A sparse file, because the sizes under test are 2.7 GB and 4.5 GB and writing
   * them out would be a test that fills a disk to prove a comparison.
   */
  async function sized(name: string, bytes: number): Promise<void> {
    const path = join(dir, name);
    await writeFile(path, '', 'utf8');
    await truncate(path, bytes);
  }

  it('answers nothing when there is no directory', () => {
    expect(installedTiers({dir: '', manifest: manifest()})).toEqual([]);
  });
});

describe('localModelSpec', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-spec-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  /*
   * The context arrives from the caller rather than from the tier, because the
   * plan is allowed to reduce it: a card that cannot hold 32K still runs the tier
   * at 16K, and a spec that read the tier's target would start it at the size that
   * did not fit.
   */
  it('carries the window the plan chose rather than the tier’s target', () => {
    const spec = localModelSpec({
      dir: join(dir, 'model'),
      manifest: manifest(),
      tier: 'high',
      contextSize: 16384,
      platform: 'linux',
    });

    expect(spec.contextSize).toBe(16384);
    expect(manifest().weights.tiers.high.contextSize).toBe(32768);
  });

  /*
   * Thinking off is a constant, and it is a verified one: Qwen3.5's template
   * honours the flag, which is not true of every model — one shipped template
   * ignores it entirely and forces thinking on, which reads as "off" while every
   * turn pays for it.
   */
  it('turns thinking off, which the pinned template honours', () => {
    const spec = localModelSpec({
      dir: join(dir, 'model'),
      manifest: manifest(),
      tier: 'low',
      contextSize: 16384,
      platform: 'linux',
    });
    expect(spec.thinking).toBe(false);
  });

  it('finds the engine and the tier’s weights', async () => {
    const root = join(dir, 'model');
    await mkdir(engineDir(root), {recursive: true});
    await writeFile(join(engineDir(root), 'llama-server'), 'binary', 'utf8');
    await writeFile(join(root, 'low.gguf'), 'weights', 'utf8');

    const spec = localModelSpec({
      dir: root,
      manifest: manifest(),
      tier: 'low',
      contextSize: 16384,
      platform: 'linux',
    });

    expect(spec.files.model).toBe(join(root, 'low.gguf'));
    expect(spec.files.enginePresent).toBe(true);
    expect(spec.files.modelPresent).toBe(true);
  });
});
