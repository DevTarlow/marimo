/**
 * Where the engine and the weights are, for one tier.
 *
 * This file used to be the app's *other* invariant-13 problem. The model was
 * bundled inside the installer, so the window had to ask Electron for
 * `process.resourcesPath` while the headless runner — the same binary as plain
 * Node, with no `app` at all — derived the same directory from its own executable.
 * When the two disagreed nothing errored: the window answered questions while a
 * scheduled job reported the model as not installed.
 *
 * That whole class of failure is gone, because the model is no longer shipped. It
 * is downloaded into the user-data directory, which both processes already resolve
 * through `resolveAppPaths` and which invariant 13 is about. There is one
 * derivation now instead of two, and it is the one that already had a test.
 *
 * What survives is `MARIMO_MODEL_DIR`: a development checkout and the smoke check
 * both point at a directory of their own, and it wins over the default rather than
 * the other way round — a directory a shipped path can silently outrank is one
 * that does not work.
 */
import {statSync} from 'node:fs';
import {dirname, join} from 'node:path';

import type {LocalModelManifest, ModelTierName} from './manifest.js';
import {MODEL_TIERS} from './manifest.js';
import {EMBEDDING_PIECES} from './manifest.js';
import type {EmbeddingManifest, EmbeddingPieceName, EmbeddingPooling} from './manifest.js';

/**
 * Points both processes at a directory of their own.
 *
 * What a development checkout uses — the weights are not in the repository, and
 * `pnpm model:fetch` puts them in `.model-cache/` and prints the path. It is also
 * what the smoke check sets, so a run that has no model says so rather than
 * starting a search.
 */
export const MODEL_DIR_ENV = 'MARIMO_MODEL_DIR';

/** The directory the app owns, under the user-data directory it already has. */
export const MODEL_DIR_NAME = 'model';

/**
 * Everything a start needs, in one answer.
 *
 * One shape rather than three callbacks because all three are decided together,
 * and asking for them separately is how two callers come to disagree about what is
 * being started.
 */
export interface LocalModelSpec {
  files: LocalModelFiles;
  contextSize: number;
  thinking: boolean;
}

export interface LocalModelFiles {
  /** The directory the engine and the weights live in. */
  dir: string;
  /** The `llama-server` binary. */
  engine: string;
  /**
   * The directory holding the engine's shared libraries.
   *
   * The released archives unpack `libllama.so`, `libggml*.so` and friends beside
   * the binary and expect to be run from there, so the child is spawned with this
   * as its working directory *and* on `LD_LIBRARY_PATH` — the rpath in the shipped
   * build is not something this app should assume.
   */
  libraryDir: string;
  /** The weights for this tier. */
  model: string;
  /** Whether the engine binary is there. */
  enginePresent: boolean;
  /** Whether this tier's weights are there. */
  modelPresent: boolean;
}

/**
 * The directory the model lives in.
 *
 * `MARIMO_MODEL_DIR` first, because it is what a checkout and the smoke check set,
 * then the app's own directory under user data. No `resourcesPath` argument any
 * more: there is nothing to find inside the app.
 */
export function modelDir(options: {
  userData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  const override = env[MODEL_DIR_ENV];
  return override !== undefined && override.length > 0
    ? override
    : join(options.userData, MODEL_DIR_NAME);
}

/** The engine binary's name, which is the one thing Windows spells differently. */
export function engineBinaryName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** Where the engine is unpacked inside the model directory. */
export function engineDir(dir: string): string {
  return join(dir, 'engine');
}

/**
 * The files this install would use for one tier.
 *
 * `tier` is required rather than defaulted: the whole point of two tiers is that
 * the file name depends on the decision, and a default here would be a second
 * place the decision could be made differently.
 */
export function resolveLocalModelFiles(options: {
  dir: string;
  manifest: LocalModelManifest;
  tier: ModelTierName;
  platform?: NodeJS.Platform;
}): LocalModelFiles {
  const {dir} = options;
  const engine =
    dir.length > 0
      ? join(engineDir(dir), engineBinaryName(options.platform))
      : '';
  const model =
    dir.length > 0 ? join(dir, options.manifest.weights.tiers[options.tier].file) : '';

  return {
    dir,
    engine,
    libraryDir: engine.length > 0 ? dirname(engine) : '',
    model,
    enginePresent: isFile(engine),
    modelPresent: isFile(model),
  };
}

/**
 * The spec for one tier, with the window the plan chose.
 *
 * Shared by the two processes that start an engine — the window and the headless
 * runner — because everything about the answer has to be identical between them.
 * One definition means a change made for one process cannot leave the other
 * running a different engine, which is the failure this file's history is about.
 *
 * `contextSize` arrives from the caller rather than from the tier, because the
 * plan is allowed to reduce it: a card that cannot hold 32K still runs the tier at
 * 16K, and a spec that read the tier's target would start it at the size that did
 * not fit.
 *
 * `thinking` is off, and it is a constant rather than a setting: Qwen3.5's template
 * thinks by default, thinking makes every easy question take seconds longer, and
 * most questions are the easy kind. Verified against the pinned build rather than
 * assumed — the template honours the flag, which is not true of every model.
 */
export function localModelSpec(options: {
  dir: string;
  manifest: LocalModelManifest;
  tier: ModelTierName;
  contextSize: number;
  platform?: NodeJS.Platform;
}): LocalModelSpec {
  return {
    files: resolveLocalModelFiles(options),
    contextSize: options.contextSize,
    thinking: false,
  };
}

/**
 * Whether an engine binary is unpacked at all.
 *
 * Asked on its own, without a tier, because the probe needs it before any tier has
 * been decided: a caller that has no engine has nothing to ask about the hardware,
 * and caching that answer would outlive the install that changed it.
 */
export function engineInstalled(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    dir.length > 0 && sizeOf(join(engineDir(dir), engineBinaryName(platform))) >= 0
  );
}

/**
 * Which tiers' weights are on disk.
 *
 * Presence plus the *exact* byte count from the manifest, which is the same test
 * `verify` has always used. Hashing 4.5 GB on every launch is not an option, and
 * a size check still catches the failure that matters — a download that was
 * interrupted and left a file that looks present.
 */
export function installedTiers(options: {
  dir: string;
  manifest: LocalModelManifest;
}): ModelTierName[] {
  const {dir, manifest} = options;
  if (dir.length === 0) {
    return [];
  }
  return MODEL_TIERS.filter((name) => {
    const tier = manifest.weights.tiers[name];
    return sizeOf(join(dir, tier.file)) === tier.bytes;
  });
}

function sizeOf(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : -1;
  } catch {
    return -1;
  }
}

/**
 * The recall model lives in a subdirectory of the model directory.
 *
 * `model/recall/` rather than a second concept beside it, and that is the whole
 * design of this block: everything above — the engine directory, its shared
 * libraries, the binary's name, the presence checks — is written in terms of a
 * directory, so pointing it at `model/recall` reuses all of it. A second layout
 * would be a second place for the two processes to disagree about where a file
 * is, which is the failure this file's history is entirely about.
 *
 * What differs is only *which* files: a different engine build (see
 * `EMBEDDING_PINS` for why), one GGUF for text, and one projector that may not
 * be there at all.
 */
export const RECALL_DIR_NAME = 'recall';

/** Where the recall model is unpacked and downloaded. */
export function recallDir(options: {
  userData: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return join(modelDir(options), RECALL_DIR_NAME);
}

export interface RecallFiles {
  dir: string;
  engine: string;
  libraryDir: string;
  /** The text backbone's GGUF. */
  model: string;
  /**
   * The projector's path, or `''` when this install is not using media.
   *
   * `''` rather than a path plus a flag, because the two answers would have to
   * be kept in step at every call site and only one of them is what the engine
   * is handed. What decides `--mmproj` is whether this names a file that is
   * there.
   */
  projector: string;
  enginePresent: boolean;
  modelPresent: boolean;
  projectorPresent: boolean;
}

/**
 * What the recall engine would be started with.
 *
 * `media` is the user's switch, not a fact about the disk: asked for but not
 * downloaded resolves to no projector, and the args builder then leaves
 * `--mmproj` off rather than handing the engine a path that is not there. The
 * status card reads the two apart, because "you asked for images and the encoder
 * has not been downloaded" and "you have not asked for images" are different
 * sentences.
 */
export function resolveRecallFiles(options: {
  dir: string;
  manifest: EmbeddingManifest;
  media: boolean;
  platform?: NodeJS.Platform;
}): RecallFiles {
  const {dir} = options;
  const engine =
    dir.length > 0
      ? join(engineDir(dir), engineBinaryName(options.platform))
      : '';
  const model =
    dir.length > 0 ? join(dir, options.manifest.weights.pieces.text.file) : '';
  const projector =
    options.media && dir.length > 0
      ? join(dir, options.manifest.weights.pieces.media.file)
      : '';

  return {
    dir,
    engine,
    libraryDir: engine.length > 0 ? dirname(engine) : '',
    model,
    projector,
    enginePresent: isFile(engine),
    modelPresent: isFile(model),
    projectorPresent: isFile(projector),
  };
}

/** The recall spec: the files, and the two numbers an index depends on. */
export function recallSpec(options: {
  dir: string;
  manifest: EmbeddingManifest;
  media: boolean;
  platform?: NodeJS.Platform;
}): RecallSpec {
  return {
    files: resolveRecallFiles(options),
    contextSize: options.manifest.weights.contextSize,
    pooling: options.manifest.weights.pooling,
    media: options.media,
  };
}

export interface RecallSpec {
  files: RecallFiles;
  contextSize: number;
  pooling: EmbeddingPooling;
  media: boolean;
}

/**
 * Which pieces of the recall model are on disk, by exact size.
 *
 * The same test `installedTiers` uses and for the same reason: hashing 310 MB on
 * every launch is not an option, and a size check still catches the failure that
 * matters — a download that was interrupted and left a file that looks present.
 */
export function recallPiecesInstalled(options: {
  dir: string;
  manifest: EmbeddingManifest;
}): EmbeddingPieceName[] {
  const {dir, manifest} = options;
  if (dir.length === 0) {
    return [];
  }
  return EMBEDDING_PIECES.filter((name) => {
    const piece = manifest.weights.pieces[name];
    return sizeOf(join(dir, piece.file)) === piece.bytes;
  });
}

/**
 * Whether a path is a file rather than nothing, a directory, or a broken link.
 *
 * `statSync` rather than `existsSync` alone: a *directory* named like the model
 * file would pass an existence check and then fail somewhere far less clear, with
 * the engine complaining about a file it cannot open.
 */
function isFile(path: string): boolean {
  return sizeOf(path) >= 0;
}
