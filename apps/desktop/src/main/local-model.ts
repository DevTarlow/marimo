/**
 * The built-in model, in the window's process.
 *
 * A thin wrapper whose whole job is answering one question: *where* is this
 * build's model, and *how* does the user want it run. That answer is
 * `localModelSpec` in the shared package — the same function the headless runner
 * calls — and the only part that differs here is Electron's own
 * `process.resourcesPath`, which this process has and the runner does not.
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
import type {StoredSettings} from '@marimo/protocol';

export interface LocalModelHostOptions {
  paths: AppPaths;
  /** The settings as they are on disk right now. */
  readSettings: () => Promise<StoredSettings>;
  /** Injectable for a test, which must not be able to start a process. */
  spawnImpl?: typeof import('node:child_process').spawn;
  fetchImpl?: typeof fetch;
}

export class LocalModelHost {
  private readonly service: LocalModelService;

  constructor(private readonly options: LocalModelHostOptions) {
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
   * Where the files are and how they should be run, right now.
   *
   * Read per start and per status rather than cached: pointing the setting at
   * another `.gguf`, or turning thinking on, has to take effect on the next
   * question rather than the next launch — and a cache is the kind of thing that
   * stays right until somebody changes their mind.
   */
  private async specNow() {
    const settings = await this.options.readSettings();
    return localModelSpec(settings, {
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
