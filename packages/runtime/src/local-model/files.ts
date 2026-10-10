/**
 * Where everything the built-in model needs actually lives.
 *
 * Two answers, and both are the kind this project has already been bitten by
 * once: *which* engine binary and weights to use, and *where* the app finds them.
 * The second is invariant 13's sibling. The window has Electron and can ask it
 * for `process.resourcesPath`; the headless runner is the same binary started as
 * plain Node with no `app` at all, so it has to derive the same directory from
 * the platform's rules. If the two ever disagree, nothing errors: the window
 * answers questions with the shipped model while a scheduled job, running with
 * the app closed, finds no model file and records "not installed" — a background
 * service that looks like it is working.
 *
 * So there is one function here, both processes call it, a test pins the
 * derivation, and the Settings card shows the result. That is the same remedy as
 * the user-data directory's, for the same failure.
 */
import {statSync} from 'node:fs';
import {dirname, join} from 'node:path';

/**
 * Points both processes at a directory of their own.
 *
 * What a development checkout uses — the weights are not in the repository, and
 * `pnpm model:fetch` puts them in `.model-cache/` and prints the path. It is also
 * what the smoke check sets, so a run that has no model says so rather than
 * starting a search.
 */
export const MODEL_DIR_ENV = 'MARIMO_MODEL_DIR';

/** The name the weights are shipped under, inside the model directory. */
export const MODEL_FILE_NAME = 'Qwen3-1.7B-Q4_K_M.gguf';

/**
 * The model id every request names, and the alias the engine is started with.
 *
 * Not the file name, deliberately: the id travels between two processes of this
 * app and nothing else reads it, while the file is an implementation detail a
 * user can replace by pointing at a `.gguf` of their own. Two facts that can
 * differ should not be spelled the same.
 */
export const MODEL_ALIAS = 'qwen3-1.7b';

/**
 * Everything a start needs, in one answer.
 *
 * One shape rather than three callbacks because all three come from the same
 * place — the settings file, plus where this build keeps its model — and asking
 * for them separately means reading that file three times and being able to
 * disagree with itself in between.
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
   * the binary and expect to be run from there, so the child is spawned with
   * this as its working directory *and* on `LD_LIBRARY_PATH` — the rpath in the
   * shipped build is not something this app should assume.
   */
  libraryDir: string;
  /** The weights, whichever of the two named them. */
  model: string;
  /** Whether the engine binary is there. */
  enginePresent: boolean;
  /** Whether the weights are there. */
  modelPresent: boolean;
}

/**
 * Where the shipped copy lives, or `undefined` when this build has none.
 *
 * `<resources>` is the directory `electron-builder` puts `extraResources` into:
 * `Contents/Resources` on macOS, `resources/` beside the executable on Linux and
 * Windows. Electron hands the main process `process.resourcesPath`; the runner
 * walks up from `process.execPath`, which is the same executable.
 */
export function bundledModelDir(options: {
  resourcesPath?: string | undefined;
  execPath: string;
  platform?: NodeJS.Platform;
}): string | undefined {
  const platform = options.platform ?? process.platform;
  if (options.resourcesPath !== undefined && options.resourcesPath.length > 0) {
    return join(options.resourcesPath, 'local-model');
  }

  /*
   * No `process.resourcesPath`: this is the runner, or a plain Node process.
   *
   * The layout is Electron's own and is the same on all three platforms —
   * `.../resources/<app>` — except on macOS, where the executable sits in
   * `Contents/MacOS` and the resources are its sibling. There is no way to ask,
   * so it is derived, and a wrong answer here is the silent kind: the engine is
   * simply not found and the model reports itself as not installed.
   */
  if (platform === 'darwin') {
    return join(dirname(dirname(options.execPath)), 'Resources', 'local-model');
  }
  return join(dirname(options.execPath), 'resources', 'local-model');
}

/**
 * The files this install would use, in the order the answers are decided.
 *
 * The override wins over the shipped copy rather than the other way round: it is
 * what a user typed, and a setting that a shipped file can silently outrank is a
 * setting that does not work.
 */
export function resolveLocalModelFiles(options: {
  /** What the settings file says, if anything. */
  ggufPath?: string | undefined;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | undefined;
  execPath: string;
  platform?: NodeJS.Platform;
}): LocalModelFiles {
  const env = options.env ?? process.env;
  const override = env[MODEL_DIR_ENV];
  const dir =
    override !== undefined && override.length > 0
      ? override
      : (bundledModelDir({
          resourcesPath: options.resourcesPath,
          execPath: options.execPath,
          ...(options.platform === undefined
            ? {}
            : {platform: options.platform}),
        }) ?? '');

  const engineName =
    (options.platform ?? process.platform) === 'win32'
      ? 'llama-server.exe'
      : 'llama-server';
  const engine = dir.length > 0 ? join(dir, 'engine', engineName) : '';
  const shipped = dir.length > 0 ? join(dir, MODEL_FILE_NAME) : '';
  const chosen = options.ggufPath ?? '';

  return {
    dir,
    engine,
    libraryDir: engine.length > 0 ? dirname(engine) : '',
    model: chosen.length > 0 ? chosen : shipped,
    enginePresent: isFile(engine),
    modelPresent: isFile(chosen.length > 0 ? chosen : shipped),
  };
}

/**
 * The spec for the settings as they are, and where this build keeps its model.
 *
 * Shared by the two processes that start an engine — the window and the headless
 * runner — because the only thing that differs between them is how they find
 * `resourcesPath`, and everything else about the answer has to be identical. One
 * definition means a setting added later cannot reach one process and not the
 * other.
 */
export function localModelSpec(
  settings: {
    localModel: {ggufPath: string; contextSize: number; thinking: boolean};
  },
  where: {
    resourcesPath?: string | undefined;
    execPath: string;
    platform?: NodeJS.Platform;
  },
): LocalModelSpec {
  return {
    files: resolveLocalModelFiles({
      ggufPath: settings.localModel.ggufPath,
      env: process.env,
      ...where,
    }),
    contextSize: settings.localModel.contextSize,
    thinking: settings.localModel.thinking,
  };
}

/**
 * Whether a path is a file rather than nothing, a directory, or a broken link.
 *
 * `statSync` rather than `existsSync` alone: a *directory* named like the model
 * file would pass an existence check and then fail somewhere far less clear,
 * with the engine complaining about a file it cannot open.
 */
function isFile(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  try {
    return statSync(path).isFile();
  } catch {
    // Absent, unreadable, or a link to nowhere. All three mean "not usable",
    // which is the only question the caller is asking.
    return false;
  }
}
