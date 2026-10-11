/**
 * The model the app runs, in the window's process.
 *
 * A thin wrapper whose job is answering one question: *which* tier this machine
 * should run, and how is it started. That answer comes from `localModelSpecFor` in
 * the shared package — the same function the headless runner calls, over the same
 * pins — so the window and a scheduled job cannot disagree about what to load.
 *
 * What this file adds to that is the part only a window can do: fetching the model
 * on a user's first run, and reporting how far along it is.
 *
 * The order of an install is the whole trick, and it is forced by the hardware
 * being unknowable until something can ask it. So: the engine first — 32 MB, and
 * it is what *can* be asked — then the probe, then the tier that probe chose. That
 * is what stops a first run downloading 4.5 GB for a card that cannot hold it, and
 * it is why the cheap half gates the expensive one rather than the other way round.
 *
 * The probe is cached, and carefully: launching the engine to ask about the
 * hardware costs a process, and the Settings card asks for the status every time it
 * is drawn. But a probe taken *before* the engine existed found nothing to ask, so
 * that answer is dropped the moment the engine lands — otherwise the first run's
 * "no GPU" would outlive the download that made it answerable.
 */
import {
  LocalModelService,
  backendNameFor,
  engineBinaryName,
  engineDir,
  engineInstalled,
  installEngine,
  installTier,
  installedTiers,
  localModelPidFile,
  localModelSpecFor,
  MODEL_PINS,
  modelDir,
  probeDevices,
} from '@marimo/runtime';
import type {
  AppPaths,
  DeviceProbe,
  DownloadProgress,
  LocalModelSpec,
  TierPlan,
} from '@marimo/runtime';
import type {
  LocalModelStatus,
  ModelTier,
  ModelTierChoice,
  ModelTierSummary,
  StoredSettings,
} from '@marimo/protocol';

export interface LocalModelHostOptions {
  paths: AppPaths;
  /**
   * The tier choice as it is on disk, read per call.
   *
   * A function rather than a value because the user can change it in Settings
   * while the app runs, and a copy taken at startup would be a switch that only
   * worked after a restart.
   */
  readSettings?: () => Promise<Pick<StoredSettings, 'modelTier'>>;
  /** Where a download's progress goes, so the window can draw it. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Told when a download finishes, so whatever waited on it can re-read. */
  onInstalled?: (tier: ModelTier) => void;
  /** Told when a download fails, with the sentence that says why. */
  onFailed?: (message: string) => void;
  /** Injectable for a test, which must not be able to start a process. */
  spawnImpl?: typeof import('node:child_process').spawn;
  fetchImpl?: typeof fetch;
}

export class LocalModelHost {
  private readonly service: LocalModelService;
  private probed: DeviceProbe | undefined;
  /** Set while a download is in flight, and what cancels it. */
  private downloading: AbortController | undefined;
  /** The last progress reported, so a window that opened mid-download sees it. */
  private progress: LocalModelStatus['installing'];

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

  /** What the user asked for, or `auto` when nothing has said otherwise. */
  private async choice(): Promise<ModelTierChoice> {
    if (this.options.readSettings === undefined) {
      return 'auto';
    }
    return (await this.options.readSettings()).modelTier;
  }

  /**
   * What the engine says the machine has.
   *
   * Cached only when there was an engine to ask. A machine with none is a machine
   * about to download one, and a cached "nothing" would go on describing hardware
   * of a moment that has passed — which is exactly the state a first run is in.
   */
  private async probe(): Promise<DeviceProbe> {
    if (this.probed !== undefined) {
      return this.probed;
    }
    const dir = this.dir;
    const result = await probeDevices(
      dir.length > 0 ? `${engineDir(dir)}/${engineBinaryName()}` : '',
    );
    if (engineInstalled(dir)) {
      this.probed = result;
    }
    return result;
  }

  /** Which tier, at which window, and why. */
  async plan(): Promise<TierPlan> {
    return (await this.resolve()).plan;
  }

  private async resolve(): Promise<{spec: LocalModelSpec; plan: TierPlan}> {
    return await localModelSpecFor({
      dir: this.dir,
      manifest: MODEL_PINS,
      choice: await this.choice(),
      probe: await this.probe(),
    });
  }

  /**
   * The process, plus the decision about which process to run.
   *
   * Two sources, deliberately: the supervisor knows what it started and where the
   * files are, and the resolver knows what the machine can take and why. Merging
   * them here is what lets the card show a plan and a running engine in one look
   * without either half knowing about the other.
   */
  async status(): Promise<LocalModelStatus> {
    const {spec, plan} = await this.resolve();
    const engine = await this.service.status();
    const installed = installedTiers({dir: this.dir, manifest: MODEL_PINS});
    const chosen = plan.runnable
      ? MODEL_PINS.weights.tiers[plan.tier]
      : MODEL_PINS.weights.tiers.low;
    const backend = backendNameFor(MODEL_PINS);

    return {
      ...engine,
      tier: chosen.name,
      tierLabel: chosen.label,
      contextSize: spec.contextSize,
      ...(backend === undefined ? {} : {backend}),
      runnable: plan.runnable,
      /*
       * Only when the engine is there. Before that the plan's refusal is not the
       * answer to "why can it not answer" — the answer is that nothing has been
       * downloaded yet, and the card keys off `enginePresent` to say so. Reporting
       * "no usable GPU" about a machine whose engine has not been fetched would be
       * a sentence about the wrong problem.
       */
      ...(plan.runnable || !engine.enginePresent ? {} : {problem: plan.problem}),
      reason: plan.runnable ? plan.reason : '',
      fits: plan.runnable ? plan.fits : false,
      tiers: this.summarise(installed),
      ...(this.progress === undefined ? {} : {installing: this.progress}),
    };
  }

  private summarise(installed: readonly ModelTier[]): ModelTierSummary[] {
    return (['low', 'high'] as const).map((name) => {
      const tier = MODEL_PINS.weights.tiers[name];
      return {
        name,
        label: tier.label,
        bytes: tier.bytes,
        contextSize: tier.contextSize,
        installed: installed.includes(name),
      };
    });
  }

  /**
   * Fetches the engine and the chosen tier, reporting progress as it goes.
   *
   * Answers as soon as the download has *started*: the caller is an `invoke`, and a
   * call that blocked for four gigabytes would be one nobody could cancel and every
   * window would appear to hang on. What happens next arrives as events.
   */
  async install(): Promise<{started: boolean}> {
    if (this.downloading !== undefined) {
      return {started: false};
    }
    const controller = new AbortController();
    this.downloading = controller;
    // Deliberately not awaited: the answer is "started", and the outcome is an
    // event. The catch is inside `fetch` so a failure is reported, not swallowed.
    void this.fetch(controller);
    return {started: true};
  }

  /** Stops a download in flight. What arrived is kept, so it can resume. */
  cancel(): {cancelled: boolean} {
    if (this.downloading === undefined) {
      return {cancelled: false};
    }
    this.downloading.abort();
    return {cancelled: true};
  }

  private async fetch(controller: AbortController): Promise<void> {
    try {
      await this.installEngine(controller.signal);
      /*
       * The engine is what can be asked about the hardware, so the answer taken
       * before it existed is dropped rather than reused.
       */
      this.probed = undefined;

      const {plan} = await this.resolve();
      if (!plan.runnable) {
        this.options.onFailed?.(plan.problem);
        return;
      }
      if (plan.download) {
        await installTier({
          dir: this.dir,
          manifest: MODEL_PINS,
          tier: plan.tier,
          onProgress: (progress) => {
            this.report(progress);
          },
          signal: controller.signal,
          ...(this.options.fetchImpl === undefined
            ? {}
            : {fetchImpl: this.options.fetchImpl}),
        });
      }
      this.options.onInstalled?.(plan.tier);
    } catch (failure) {
      // A cancelled download is not a failure to report: the user asked for it.
      if (!controller.signal.aborted) {
        this.options.onFailed?.(describe(failure));
      }
    } finally {
      this.downloading = undefined;
      this.progress = undefined;
    }
  }

  private async installEngine(signal: AbortSignal): Promise<void> {
    await installEngine({
      dir: this.dir,
      manifest: MODEL_PINS,
      onProgress: (progress) => {
        this.report(progress);
      },
      signal,
      ...(this.options.fetchImpl === undefined
        ? {}
        : {fetchImpl: this.options.fetchImpl}),
    });
  }

  private report(progress: DownloadProgress): void {
    this.progress = {
      label: progress.label,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
      ...(progress.percent === undefined ? {} : {percent: progress.percent}),
    };
    this.options.onProgress?.(progress);
  }

  /** Starts it if it is not up, and answers where it is. */
  async ensureRunning() {
    return await this.service.ensureRunning();
  }

  async stop(): Promise<void> {
    await this.service.stop();
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
