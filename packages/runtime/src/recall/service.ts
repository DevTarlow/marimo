/**
 * The recall engine, supervised, with an idle timer.
 *
 * This is the same process problem `local-model/service.ts` already solves —
 * spawn, wait for health, keep the last lines it printed, reap what a crash left
 * behind, never outlive the app — so it is the same class underneath and this
 * file adds the three things that are specific to a *second* engine:
 *
 * 1. **It is optional and it is on demand.** The chat engine is the app; this one
 *    is a feature. It starts when something actually needs a vector and stops
 *    itself after five idle minutes, because 400 MB of resident weights and a fan
 *    spinning for a search somebody did yesterday is the failure AGENTS.md names
 *    about models left behind.
 * 2. **Its own pid file.** Reaping kills whatever pid the file names, so sharing
 *    `local-model.pid` would have whichever engine started second kill the other.
 * 3. **One request at a time, and a sentence instead of a throw.** Callers of
 *    `embed` are a turn that must not fail because search is unavailable, and a
 *    background indexer that has to survive one bad file. So the failure comes
 *    back as `EmbeddingError` — a value the caller can catch and act on — rather
 *    than as a rejected promise nobody is holding.
 */
import type {spawn} from 'node:child_process';

import type {EngineStatus} from '@marimo/protocol';

import {embeddingArgs} from '../local-model/args.js';
import {LocalModelService} from '../local-model/service.js';
import type {RecallFiles, RecallSpec} from '../local-model/files.js';
import {EmbeddingClient, EmbeddingError} from './client.js';
import type {EmbeddingPart, EmbeddingResult} from './client.js';

/**
 * How long the engine may sit unused before it is stopped.
 *
 * Five minutes is longer than the gap between two questions in one sitting of
 * searching and shorter than the gap between two sittings, which is the whole
 * judgement: stopping it while somebody is still reading results would pay the
 * load time again for nothing.
 */
export const RECALL_IDLE_MS = 5 * 60_000;

export interface RecallEngineOptions {
  /** What to start, resolved per call so a settings change takes effect. */
  spec: () => RecallSpec | Promise<RecallSpec>;
  pidFile: string;
  /** The width every index is written in; vectors are checked against it. */
  dims: number;
  log?: (line: string) => void;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  idleMs?: number;
}

export class RecallEngine {
  private readonly service: LocalModelService<RecallFiles, RecallSpec>;
  private readonly client: EmbeddingClient;
  private readonly idleMs: number;
  private idle: NodeJS.Timeout | undefined;
  /** Serializes embeds, so one engine serves one request at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RecallEngineOptions) {
    this.idleMs = options.idleMs ?? RECALL_IDLE_MS;
    this.service = new LocalModelService<RecallFiles, RecallSpec>({
      spec: options.spec,
      args: (spec, port) =>
        embeddingArgs({
          engine: spec.files.engine,
          model: spec.files.model,
          ...(projectorOf(spec.files) === undefined
            ? {}
            : {projector: projectorOf(spec.files) as string}),
          port,
          contextSize: spec.contextSize,
          pooling: spec.pooling,
        }),
      pidFile: options.pidFile,
      ...(options.log === undefined ? {} : {log: options.log}),
      ...(options.spawnImpl === undefined ? {} : {spawnImpl: options.spawnImpl}),
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    });
    this.client = new EmbeddingClient({
      // The supervisor's own answer, per request: a copy kept here would be an
      // address pointing at a process that died a minute ago.
      baseUrl: async () => {
        const status = await this.service.status();
        return status.state === 'ready' ? status.baseUrl : undefined;
      },
      dims: options.dims,
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    });
  }

  /** Starts it if it is not up, and answers where it is. */
  async ensureRunning(): Promise<
    {ok: true; baseUrl: string} | {ok: false; problem: string}
  > {
    return await this.service.ensureRunning();
  }

  /** Text in, one vector out per input. Throws `EmbeddingError`. */
  async embedText(
    texts: readonly string[],
    call: {timeoutMs?: number} = {},
  ): Promise<EmbeddingResult> {
    return await this.withEngine(async () => await this.client.embedText(texts, call));
  }

  /** Media in — one content array per input. Throws `EmbeddingError`. */
  async embedParts(
    parts: readonly EmbeddingPart[][],
    call: {timeoutMs?: number} = {},
  ): Promise<EmbeddingResult> {
    return await this.withEngine(async () => await this.client.embed(parts, call));
  }

  /** The process, as the card draws it. */
  async status(): Promise<EngineStatus> {
    return await this.service.status();
  }

  /** Stops it now, whether or not it was idle. */
  async stop(): Promise<void> {
    this.clearIdle();
    // Any embed already in flight finishes first: killing the engine under a
    // request would turn a good answer into a failure to report.
    await this.queue.catch(() => undefined);
    await this.service.stop();
  }

  private async withEngine<T>(task: () => Promise<T>): Promise<T> {
    return await this.withQueue(async () => {
      const started = await this.service.ensureRunning();
      if (!started.ok) {
        throw new EmbeddingError(started.problem);
      }
      const result = await task();
      this.armIdle();
      return result;
    });
  }

  /**
   * The idle stop, and why it is unref'd.
   *
   * The headless runner is a process that must be able to exit, and a five-minute
   * timer is five minutes of a scheduled job's process staying alive after its
   * work is done. Node never exits while a timer is pending, so the timer is
   * made not to count — the app, which is meant to stay up, is unaffected, and
   * the runner leaves when the runner is finished.
   */
  private armIdle(): void {
    this.clearIdle();
    const timer = setTimeout(() => {
      void this.stop();
    }, this.idleMs);
    timer.unref?.();
    this.idle = timer;
  }

  private clearIdle(): void {
    if (this.idle !== undefined) {
      clearTimeout(this.idle);
      this.idle = undefined;
    }
  }

  private async withQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

/**
 * The projector to pass to `--mmproj`, if there is one to pass.
 *
 * Both halves of the answer matter. `projectorPresent` is the disk — the file is
 * actually there and the right size — and the empty-string check is the caller's
 * resolution of "the user has not asked for media". Handing the engine a path
 * that is not there is a start that fails at load time with a message about a
 * file, when what happened is that a download has not been done.
 */
function projectorOf(files: RecallFiles): string | undefined {
  return files.projectorPresent && files.projector.length > 0
    ? files.projector
    : undefined;
}
