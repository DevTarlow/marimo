/**
 * The recall model: its pins, its download, and the engine that serves it.
 *
 * The pieces are deliberately separate, and the seams are where the testing is:
 * `manifest.ts` is the shipped pins as data, `install.ts` fetches them, `files.ts`
 * answers where it all lives, `args.ts` is the command line as an array, and
 * `service.ts` runs it. The split is the same one the OS service plan makes — the
 * parts that decide are data and are tested directly, and the part that touches
 * the machine is one small class with its seams injected.
 *
 * It lives in this package rather than in the app because both processes need it:
 * the window starts the engine to answer a question, and the headless runner
 * starts its own to run a scheduled job while the window is closed. Neither can
 * reach into the other, and a second copy of this in `apps/desktop` would be the
 * half that drifts.
 */
export {
  engineBinaryName,
  engineDir,
  MODEL_DIR_ENV,
  MODEL_DIR_NAME,
  modelDir,
  RECALL_DIR_NAME,
  recallDir,
  recallPiecesInstalled,
  recallSpec,
  resolveRecallFiles,
} from './files.js';
export type {RecallFiles, RecallSpec} from './files.js';

export {
  EMBEDDING_PIECES,
  EMBEDDING_POOLINGS,
  embeddingUrl,
  engineAssetFor,
  engineUrl,
  ManifestError,
  parseEmbeddingManifest,
  platformKey,
} from './manifest.js';
export type {
  EmbeddingManifest,
  EmbeddingPiece,
  EmbeddingPieceName,
  EmbeddingPooling,
  EngineAsset,
  EngineManifest,
} from './manifest.js';

export {
  downloadVerified,
  engineIsPinned,
  installEmbeddingPiece,
  installEngine,
  InstallError,
  unpackEngine,
} from './install.js';
export type {
  DownloadProgress,
  EmbeddingInstallOptions,
  EngineInstallOptions,
  InstallOptions,
} from './install.js';

export {EMBEDDING_PINS} from './pins.js';

export {EMBEDDING_ALIAS, embeddingArgs} from './args.js';
export type {EmbeddingSpec} from './args.js';

export {
  embeddingPidFile,
  freePort,
  LocalModelService,
} from './service.js';
export type {
  EngineFiles,
  EngineRunSpec,
  EngineStatus,
  LocalModelOptions,
} from './service.js';
