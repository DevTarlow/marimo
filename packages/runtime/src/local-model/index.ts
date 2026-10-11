/**
 * The model the app carries — except that it no longer carries it.
 *
 * The pieces are deliberately separate, and the seams are where the testing is:
 * `manifest.ts` is the shipped pins as data, `probe.ts` asks the engine what the
 * machine has, `plan.ts` decides which tier that means, `install.ts` fetches it,
 * `files.ts` answers where it all lives, and `service.ts` runs it. The split is
 * the same one the OS service plan makes — the parts that decide are data and are
 * tested directly, and the part that touches the machine is one small class with
 * its seams injected.
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
  engineInstalled,
  installedTiers,
  localModelSpec,
  MODEL_DIR_ENV,
  MODEL_DIR_NAME,
  modelDir,
  RECALL_DIR_NAME,
  recallDir,
  recallPiecesInstalled,
  recallSpec,
  resolveLocalModelFiles,
  resolveRecallFiles,
} from './files.js';
export type {
  LocalModelFiles,
  LocalModelSpec,
  RecallFiles,
  RecallSpec,
} from './files.js';

export {
  backendNameFor,
  EMBEDDING_PIECES,
  EMBEDDING_POOLINGS,
  embeddingUrl,
  engineAssetFor,
  engineUrl,
  ManifestError,
  MODEL_TIERS,
  parseEmbeddingManifest,
  parseManifest,
  platformKey,
  weightsUrl,
} from './manifest.js';
export type {
  EmbeddingManifest,
  EmbeddingPiece,
  EmbeddingPieceName,
  EmbeddingPooling,
  EngineAsset,
  EngineManifest,
  LocalModelManifest,
  ModelTier,
  ModelTierName,
} from './manifest.js';

export {probeDevices, parseDevices, systemMemoryBytes} from './probe.js';
export type {DeviceProbe, ProbedDevice, ProbeOptions} from './probe.js';

export {
  CONTEXT_FLOOR,
  contextThatFits,
  estimatedResidentBytes,
  formatBytes,
  planTier,
  requiredFreeBytes,
  SAFETY_MARGIN_BYTES,
} from './plan.js';
export type {TierChoice, TierPlan, TierPlanInput} from './plan.js';

export {
  downloadVerified,
  engineIsPinned,
  installEmbeddingPiece,
  installEngine,
  InstallError,
  installTier,
  unpackEngine,
} from './install.js';
export type {
  DownloadProgress,
  EmbeddingInstallOptions,
  EngineInstallOptions,
  InstallOptions,
  TierInstallOptions,
} from './install.js';

export {EMBEDDING_PINS, MODEL_PINS} from './pins.js';

export {localModelSpecFor, resolveTier} from './resolve.js';
export type {ResolveTierOptions} from './resolve.js';

export {EMBEDDING_ALIAS, embeddingArgs, engineArgs} from './args.js';
export type {EmbeddingSpec, EngineSpec} from './args.js';

export {
  embeddingPidFile,
  freePort,
  LocalModelService,
  localModelPidFile,
} from './service.js';
export type {
  EngineFiles,
  EngineRunSpec,
  LocalModelOptions,
} from './service.js';
