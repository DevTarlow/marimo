/**
 * The built-in model, in the window's process.
 *
 * A thin wrapper whose whole job is answering one question: *where* is this
 * build's model, and how is it run. That answer is `localModelSpec` in the shared
 * package — the same function the headless runner calls — and the only part that
 * differs here is Electron's own `process.resourcesPath`, which this process has
 * and the runner does not.
 *
 * The wrapper exists so the IPC handlers have one object to talk to, and so that
 * only the process that owns a window knows Electron is involved at all.
 */
import {
  LocalModelService,
  localModelPidFile,
  localModelSpec,
} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

export interface LocalModelHostOptions {
  paths: AppPaths;
  /** Injectable for a test, which must not be able to start a process. */
  spawnImpl?: typeof import('node:child_process').spawn;
  fetchImpl?: typeof fetch;
}

export class LocalModelHost {
  private readonly service: LocalModelService;

  constructor(options: LocalModelHostOptions) {
    this.service = new LocalModelService({
      spec: async () => this.specNow(),
      pidFile: localModelPidFile(options.paths.userData),
      log: (line) => {
        console.log(line);
      },
      ...(options.spawnImpl === undefined
        ? {}
        : {spawnImpl: options.spawnImpl}),
      ...(options.fetchImpl === undefined
        ? {}
        : {fetchImpl: options.fetchImpl}),
    });
  }

  /**
   * Where the files are and how they are run.
   *
   * Asked per start and per status rather than cached, because the answer is
   * derived from this process's own paths and `MARIMO_MODEL_DIR`, either of which
   * a test can change between two calls. It is cheap: two `stat`s and no I/O.
   */
  private specNow() {
    return localModelSpec({
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
    });
  }

  /** Starts it if it is not up, and answers where it is. */
  async ensureRunning() {
    return await this.service.ensureRunning();
  }

  async stop(): Promise<void> {
    await this.service.stop();
  }

  async status() {
    return await this.service.status();
  }
}
