/**
 * The model that ships with the app.
 *
 * Two halves that are deliberately separate: `files.ts` answers *where* the
 * engine and the weights are, and `service.ts` runs one. The split is the same
 * one the OS service plan makes — the part that decides what to do is data and
 * is tested directly, and the part that touches the machine is one small class
 * with its seams injected.
 *
 * It lives in this package rather than in the app because both processes need
 * it: the window starts the engine to answer a question, and the headless runner
 * starts its own to run a scheduled job while the window is closed. Neither can
 * reach into the other, and a second copy of this in `apps/desktop` would be the
 * half that drifts.
 */
export {
  bundledModelDir,
  localModelSpec,
  MODEL_ALIAS,
  MODEL_DIR_ENV,
  MODEL_FILE_NAME,
  resolveLocalModelFiles,
} from './files.js';
export type {LocalModelFiles, LocalModelSpec} from './files.js';

export {defaultGpuLayers, engineArgs} from './args.js';
export type {EngineSpec} from './args.js';

export {freePort, LocalModelService, localModelPidFile} from './service.js';
export type {LocalModelOptions} from './service.js';
