/**
 * The model the app runs, in the window's process.
 *
 * A thin wrapper whose whole job is answering one question: *which* tier this
 * machine should run, and how is it started. That answer comes from
 * `localModelSpecFor` in the shared package — the same function the headless
 * runner calls, with the same pins — so the window and a scheduled job cannot
 * disagree about what to load. That disagreement is the failure this whole feature
 * is shaped around, and it is silent when it happens.
 *
 * What differs between the two processes is only where the files are, and that is
 * `modelDir`, which derives from the user-data directory both of them already
 * resolve the same way. There is no `resourcesPath` here any more: nothing is
 * bundled, so there is nothing inside the app to find.
 *
 * The probe is cached, and carefully: launching the engine to ask about the
 * hardware costs a process, and the Settings card asks for the status every time it
 * is drawn. But a probe taken *before* the engine was downloaded found nothing to
 * ask, so that answer is not cached — otherwise the first run's "no GPU" would
 * outlive the install that fixed it.
 */
import {
  LocalModelService,
  localModelPidFile,
  localModelSpecFor,
  MODEL_PINS,
  modelDir,
  engineInstalled,
  probeDevices,
  engineBinaryName,
  engineDir,
} from '@marimo/runtime';
import type {
  AppPaths,
  DeviceProbe,
  LocalModelSpec,
  TierPlan,
} from '@marimo/runtime';

export interface LocalModelHostOptions {
  paths: AppPaths;
  /** Injectable for a test, which must not be able to start a process. */
  spawnImpl?: typeof import('node:child_process').spawn;
  fetchImpl?: typeof fetch;
}

export class LocalModelHost {
  private readonly service: LocalModelService;
  private probed: DeviceProbe | undefined;

  constructor(private readonly options: LocalModelHostOptions) {
    this.service = new LocalModelService({
      spec: async () => (await this.resolve()).spec,
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

  /** The directory the engine and the weights live in. */
  private get dir(): string {
    return modelDir({userData: this.options.paths.userData});
  }

  /**
   * What the engine says the machine has.
   *
   * Cached only when there was an engine to ask. A machine with none is a machine
   * about to download one, and a cached "nothing" would go on describing the
   * hardware of a moment that has passed.
   */
  private async probe(): Promise<DeviceProbe> {
    if (this.probed !== undefined) {
      return this.probed;
    }
    const dir = this.dir;
    const result = await probeDevices(
      dir.length > 0
        ? `${engineDir(dir)}/${engineBinaryName()}`
        : '',
    );
    if (engineInstalled(dir)) {
      this.probed = result;
    }
    return result;
  }

  /** Which tier, at which context, and why — the answer the card shows. */
  async plan(): Promise<TierPlan> {
    const {plan} = await this.resolve();
    return plan;
  }

  private async resolve(): Promise<{spec: LocalModelSpec; plan: TierPlan}> {
    const resolved = await localModelSpecFor({
      dir: this.dir,
      manifest: MODEL_PINS,
      /*
       * `auto` until the user says otherwise. The override is a settings value
       * that does not exist yet, and a caller that guessed at one would be making
       * the decision in two places.
       */
      choice: 'auto',
      probe: await this.probe(),
    });
    return resolved;
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
