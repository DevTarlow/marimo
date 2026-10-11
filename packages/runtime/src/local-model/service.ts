/**
 * The engine the app runs for its own model, supervised.
 *
 * One long-lived child process, started on demand and stopped when the app goes
 * away. Everything here exists because a model server is a *process*, and the
 * three ways that goes wrong are all silent:
 *
 * 1. **It never comes up.** A missing shared library, an unsupported flag, a
 *    corrupted file — the engine prints one line to stderr and exits non-zero.
 *    So the last of what it said is kept and handed to whoever asked, because
 *    "the model is not running" without it is a dead end.
 * 2. **It comes up somewhere else.** The port is whatever was free a moment ago,
 *    so the address is read back from the supervisor rather than stored — a
 *    fixed port in a settings file is a promise about a machine this app does not
 *    own.
 * 3. **It outlives the app.** A stray `llama-server` is 1.3 GB of memory and a
 *    spinning fan on somebody's laptop with no window that explains it. A pid
 *    file, a kill on the way out, and a check on the way in.
 *
 * `spawnImpl` and `fetchImpl` are injected, so no test starts an engine: the
 * interesting failures are all about what happens when a child misbehaves, and a
 * test that had to load a model to cause them would not be run.
 */
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';

import type {EngineStatus} from '@marimo/protocol';

import {engineArgs} from './args.js';
import type {LocalModelFiles, LocalModelSpec} from './files.js';

/** How long the engine gets to load the weights and answer `/health`. */
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 250;

/** How long it gets to exit politely before it is killed. */
const STOP_GRACE_MS = 3_000;

/**
 * How many of the engine's lines are kept for the window.
 *
 * Enough to hold a failure — a missing library is one line, a rejected flag is
 * two or three with the usage text — and short enough to be a card in a dialog.
 * The first lines are the ones worth having, because a llama.cpp load announces
 * what it is doing before it fails.
 */
const LOG_LINES = 40;

export interface LocalModelOptions {
  /**
   * Resolved fresh on every start and every status, so a settings change shows
   * up on the next question rather than the next launch.
   *
   * May be asynchronous, and await is used either way: both callers read a file
   * to answer it, and a callback that had to be synchronous would push that read
   * into whoever assembled this object — where the first symptom of getting it
   * wrong is "the engine is not installed, it should be at undefined".
   */
  spec: () => LocalModelSpec | Promise<LocalModelSpec>;
  /** Where the pid file goes. Absent means no stray-process protection. */
  pidFile?: string;
  log?: (line: string) => void;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
}

type Child = Pick<
  ChildProcess,
  'pid' | 'stdout' | 'stderr' | 'kill' | 'once' | 'removeListener'
>;

type Started = {ok: true; baseUrl: string} | {ok: false; problem: string};

export class LocalModelService {
  private child: Child | undefined;
  private starting: Promise<Started> | undefined;
  private url: string | undefined;
  private port: number | undefined;
  private failure: string | undefined;
  private readonly log: string[] = [];

  constructor(private readonly options: LocalModelOptions) {}

  /**
   * Starts the engine if it is not already up, and answers where it is.
   *
   * Concurrent callers share one start: the window pre-warming and a turn
   * beginning a moment later are one engine, not two, and a second spawn would
   * either fail on the port or quietly load a second copy of the weights.
   */
  async ensureRunning(): Promise<Started> {
    if (this.url !== undefined) {
      return {ok: true, baseUrl: this.url};
    }
    if (this.starting !== undefined) {
      return await this.starting;
    }

    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** Stops the engine, if this process is the one that started it. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    this.port = undefined;
    /*
     * A stop is an answer, so it clears a failure. The user pressed the button,
     * and a card that went on saying "it stopped immediately" about a run that
     * was deliberately ended would be describing a state the app is not in.
     */
    this.failure = undefined;
    if (child === undefined) {
      await this.clearPidFile();
      return;
    }

    await new Promise<void>((resolve) => {
      const done = (): void => {
        resolve();
      };
      child.once('exit', done);
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        // Still there: it is not going to stop on its own, and a process holding
        // a gigabyte of weights is worse than an abrupt end.
        child.kill('SIGKILL');
        done();
      }, STOP_GRACE_MS);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
      });
    });

    await this.clearPidFile();
  }

  async status(): Promise<EngineStatus> {
    const {files, ...tuning} = await this.options.spec();
    const state: EngineStatus['state'] =
      this.url !== undefined
        ? 'ready'
        : this.starting !== undefined
          ? 'starting'
          : this.failure !== undefined
            ? 'failed'
            : 'off';

    return {
      state,
      ...(this.url === undefined ? {} : {baseUrl: this.url}),
      ...(this.failure === undefined ? {} : {detail: this.failure}),
      modelPresent: files.modelPresent,
      enginePresent: files.enginePresent,
      modelPath: files.model,
      enginePath: files.engine,
      command: this.command(files, tuning),
      log: [...this.log],
    };
  }

  /**
   * The exact command line, with the port filled in once there is one.
   *
   * Shown to a power user, and worth showing for the same reason
   * `service.definitionPath` is: it is the difference between "the app runs a
   * model" and being able to run the same thing by hand and see what it says.
   */
  private command(
    files: LocalModelFiles,
    tuning: {contextSize: number; thinking: boolean},
  ): string[] {
    return [
      files.engine,
      ...engineArgs({
        engine: files.engine,
        model: files.model,
        port: this.port ?? '<port>',
        ...tuning,
      }),
    ];
  }

  private async start(): Promise<Started> {
    this.failure = undefined;
    this.log.length = 0;

    const {files, ...tuning} = await this.options.spec();
    if (!files.enginePresent) {
      return this.fail(
        `The model engine is not installed. It should be at ${files.engine}.`,
      );
    }
    if (!files.modelPresent) {
      return this.fail(
        `The model file is not installed. It should be at ${files.model}.`,
      );
    }

    /*
     * Anything left over from a previous run, before a port is chosen and before
     * a second copy of the weights is loaded. Best effort: a pid file that names
     * a process which is not ours is deleted rather than obeyed.
     */
    await this.reapPrevious();

    const port = await freePort();
    const args = engineArgs({
      engine: files.engine,
      model: files.model,
      port,
      ...tuning,
    });

    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: Child;
    try {
      child = spawnImpl(files.engine, args, {
        // The released archives expect to be run from where they were unpacked,
        // and their shared libraries sit beside the binary.
        cwd: files.libraryDir,
        env: {...process.env, LD_LIBRARY_PATH: libraryPath(files)},
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as Child;
    } catch (failure) {
      return this.fail(
        `The model engine could not be started: ${describe(failure)}`,
      );
    }

    this.child = child;
    this.capture(child);

    /*
     * An early exit is a failure, and the only place it can be reported from is
     * here: the promise below is racing the health check against the child
     * going away, and a spawn that rejects with nobody listening is an unhandled
     * error rather than a sentence in a dialog.
     *
     * Attached before the pid file is written, in the same tick as the spawn, so
     * there is no window in which an engine that dies instantly — a refused
     * flag, a missing library — is anything other than a failure this code has
     * already heard about. It also covers the engine dying *after* it was ready,
     * which is a crash mid-turn: clearing the address is the point, so the next
     * call starts a new one rather than handing out a URL with nothing behind it.
     */
    const exited = new Promise<Started>((resolve) => {
      child.once('exit', (code, signal) => {
        if (this.child !== child) {
          // Stopped on purpose. `stop` is the only caller that does this, and it
          // has already answered whoever was waiting.
          resolve({ok: false, problem: 'The model was stopped.'});
          return;
        }
        this.child = undefined;
        this.url = undefined;
        this.port = undefined;
        resolve(
          this.fail(
            `The model engine stopped (${describeExit(code, signal)}). ` +
              this.tail(),
          ),
        );
      });
    });

    await this.writePidFile(child.pid);

    const baseUrl = `http://127.0.0.1:${String(port)}/v1`;
    const ready = this.waitForHealth(baseUrl);
    const result = await Promise.race([ready, exited]);
    if (!result.ok) {
      return result;
    }

    this.url = baseUrl;
    this.port = port;
    this.options.log?.(`[marimo] the built-in model is up at ${baseUrl}`);
    return {ok: true, baseUrl};
  }

  /** Polls `/health` until it answers, or gives up. */
  private async waitForHealth(baseUrl: string): Promise<Started> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const response = await fetchImpl(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          return {ok: true, baseUrl};
        }
      } catch {
        // Not listening yet, which is the normal answer for the first second or
        // two while a gigabyte of weights is mapped.
      }
      await delay(READY_POLL_MS);
    }

    return this.fail(
      `The model did not finish loading within ${String(
        Math.round(READY_TIMEOUT_MS / 1000),
      )} seconds. ${this.tail()}`,
    );
  }

  private capture(child: Child): void {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim().length === 0) {
            continue;
          }
          this.log.push(line.trimEnd());
          while (this.log.length > LOG_LINES) {
            this.log.shift();
          }
        }
      });
    }
  }

  private fail(problem: string): Started {
    this.failure = problem;
    this.options.log?.(`[marimo] ${problem}`);
    return {ok: false, problem};
  }

  /** The engine's own words, so a failure names its cause. */
  private tail(): string {
    const lines = this.log.slice(-6);
    return lines.length === 0 ? 'It printed nothing.' : lines.join('\n');
  }

  /*
   * The pid file.
   *
   * One file, holding one pid, written after the spawn and removed on the way
   * out. It exists for the case neither the app nor the runner can cover: this
   * process killed without warning, leaving an engine that nothing will ever
   * stop. The next start reads it, checks the process is still there, and kills
   * it before loading another copy.
   */

  private async writePidFile(pid: number | undefined): Promise<void> {
    const file = this.options.pidFile;
    if (file === undefined || pid === undefined) {
      return;
    }
    try {
      await writeFile(file, String(pid), 'utf8');
    } catch {
      // Not fatal, and deliberately not reported: this is a courtesy to the
      // *next* run, and failing to write it costs one stray process at worst.
    }
  }

  private async clearPidFile(): Promise<void> {
    const file = this.options.pidFile;
    if (file === undefined) {
      return;
    }
    await rm(file, {force: true}).catch(() => undefined);
  }

  private async reapPrevious(): Promise<void> {
    const file = this.options.pidFile;
    if (file === undefined) {
      return;
    }
    let pid: number;
    try {
      pid = Number((await readFile(file, 'utf8')).trim());
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
      await this.clearPidFile();
      return;
    }

    try {
      // Signal 0 asks whether the process exists without touching it.
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
      this.options.log?.(
        `[marimo] stopped a model engine left behind by an earlier run (${String(pid)})`,
      );
    } catch {
      // Already gone, which is the usual case and not worth a word.
    }
    await this.clearPidFile();
  }
}

/**
 * A port nothing is listening on, asked for rather than guessed.
 *
 * Between this and the spawn the port can be taken, which is what the engine's
 * own failure to bind looks like: one line of stderr and an exit. That is
 * reported with the engine's words, which is the honest answer — a retry loop
 * here would hide a machine that genuinely has no free ports.
 */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        address !== null && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** `LD_LIBRARY_PATH`, keeping whatever the user's environment already had. */
function libraryPath(files: LocalModelFiles): string {
  const existing = process.env['LD_LIBRARY_PATH'];
  return existing !== undefined && existing.length > 0
    ? `${files.libraryDir}:${existing}`
    : files.libraryDir;
}

function describeExit(code: number | null, signal: string | null): string {
  if (signal !== null) {
    return `killed by ${signal}`;
  }
  return `exit code ${String(code ?? 'unknown')}`;
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Where the pid file lives, given a user-data directory. */
export function localModelPidFile(userData: string): string {
  return join(userData, 'local-model.pid');
}
