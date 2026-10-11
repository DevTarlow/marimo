/**
 * The headless job runner.
 *
 * This is the other half of "Marimo Agent is always on". With the option
 * enabled, the OS wakes this process on a one-minute timer; it works out which
 * jobs are due, runs them, and exits. It is the *same* binary as the app —
 * started with `ELECTRON_RUN_AS_NODE=1`, so Electron behaves as plain Node —
 * which is what gives it the same agent core, the same stores and the same
 * conversation files without shipping a second runtime or a second copy of the
 * logic.
 *
 * Three consequences of that choice are the shape of the whole feature:
 *
 * **No display is required.** A plain Electron process needs a display server,
 * so it cannot be the thing a boot-time timer launches. Running as Node means
 * this works over SSH, in a container, and at login before any compositor is up.
 *
 * **No `safeStorage`, and nothing that needs it.** There is no `app` object in
 * Node mode, so an encrypted secret cannot be decrypted — which stopped
 * mattering when the app stopped having a model key. A background run needs no
 * secret at all: the model is a local engine, and this process dials no
 * connectors.
 *
 * **No web search.** That runs in a browser engine, and there is none here.
 * `web_search` is simply not offered, and the operating rules have the model say
 * a capability is missing rather than pretend.
 *
 * It does not need to avoid running while the app is open: the store's own
 * claim on an occurrence is what makes a job run once. Checking the app's lock
 * first is an optimisation — it saves building an agent and dialling every MCP
 * server beside an app doing the same — not a correctness measure.
 */
import {pathToFileURL} from 'node:url';

import {
  AgentRuntime,
  createJobRunner,
  defaultUserDataDir,
  holdProcessLock,
  isProcessHeld,
  JobScheduler,
  JobStore,
  LocalModelService,
  localModelPidFile,
  localModelSpec,
  resolveAppPaths,
} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {PRODUCT_NAME, USER_DATA_ENV} from '../shared/product.js';

export interface RunDueReport {
  userData: string;
  /** Whether the app was already running the jobs. */
  appIsRunning: boolean;
  total: number;
  enabled: number;
  due: number;
  ran: string[];
  /**
   * Why the runner could not do its job, when it could not.
   *
   * Present means trouble, and it is what makes the exit code non-zero: for a
   * timer, "exit 0, nothing happened" and "exit 0, I could not read the file"
   * are the same observation, and the second one is the failure nobody notices.
   */
  problem?: string;
}

/**
 * Where this process should look.
 *
 * The override first, because that is what a development run and the smoke check
 * set, and it is the same variable the app honours. Otherwise the platform's own
 * rules with the product name appended — the value Electron would have chosen,
 * worked out without an `app` object to ask.
 */
export function resolveRunnerPaths(
  env: NodeJS.ProcessEnv = process.env,
): AppPaths {
  const override = env[USER_DATA_ENV];
  const userData =
    override !== undefined && override.length > 0
      ? override
      : defaultUserDataDir({appName: PRODUCT_NAME, env});
  return resolveAppPaths(userData);
}

/**
 * Looks at the clock once and runs whatever is due.
 *
 * One look rather than a loop: the OS timer is the loop. `tick()` awaits the
 * dispatch queue, so by the time this returns, every job it started has
 * finished, and the process can exit without leaving a turn half-written.
 */
export async function runDue(options: {
  paths: AppPaths;
  /** Told about each job as it starts, for a log a person reads. */
  onRun?: (jobId: string) => void;
}): Promise<RunDueReport> {
  const {paths} = options;

  if (await isProcessHeld(paths.appLock)) {
    return {
      userData: paths.userData,
      appIsRunning: true,
      total: 0,
      enabled: 0,
      due: 0,
      ran: [],
    };
  }

  const jobs = new JobStore({file: paths.jobs});
  const {problem} = await jobs.loadChecked();
  if (problem !== undefined) {
    return {
      userData: paths.userData,
      appIsRunning: false,
      total: 0,
      enabled: 0,
      due: 0,
      ran: [],
      problem,
    };
  }

  /*
   * The model the app carries, started only if a job actually needs it.
   *
   * The path is derived from this process's own executable because there is no
   * `app` here: the same function the window calls, with Electron's answer left
   * out. Getting that wrong is the silent kind of failure — the window answers
   * questions and a scheduled job reports the model as not installed.
   */
  const localModel = new LocalModelService({
    spec: async () =>
      localModelSpec({
        execPath: process.execPath,
      }),
    pidFile: localModelPidFile(paths.userData),
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });

  const runtime = new AgentRuntime({
    paths,
    appName: PRODUCT_NAME,
    localModel,
  });

  /*
   * Claimed for the duration of the work, not merely checked.
   *
   * Checking once at startup was one-directional: it told this process whether
   * an app was up, and told the app nothing. So an app launched while a runner
   * was mid-turn found the lock free, took it, and ran its own scheduler beside
   * this one — two processes running turns at once, which is the thing the
   * invariant says must not happen. Holding it makes the exclusion symmetric,
   * and the app waits for this to be released.
   */
  const lock = await holdProcessLock(paths.appLock);
  if (lock === undefined) {
    // Somebody took it between the check above and here. Theirs.
    await runtime.dispose();
    return {
      userData: paths.userData,
      appIsRunning: true,
      total: 0,
      enabled: 0,
      due: 0,
      ran: [],
    };
  }

  /*
   * `onChange` is the scheduler saying it recorded something about a job —
   * which is every dispatch outcome, including a deferral and a gate. A `Set`
   * because one job can record twice in a run: once when it starts, once when
   * it ends.
   */
  const ran = new Set<string>();
  const scheduler = new JobScheduler({
    store: jobs,
    runner: createJobRunner({runtime, jobs}),
    onChange: (jobId) => {
      ran.add(jobId);
      options.onRun?.(jobId);
    },
  });

  try {
    // One look, waited for. Not `start`, which arms a timer this process will
    // never reach, and not `tick`, which is written for a caller that will be
    // back — this process is about to exit, and a turn still running would be
    // killed mid-write.
    await scheduler.runOnce();
  } finally {
    await lock.release();
    await runtime.dispose();
  }

  const after = await jobs.load();
  return {
    userData: paths.userData,
    appIsRunning: false,
    total: after.jobs.length,
    enabled: after.jobs.filter((job) => job.enabled).length,
    due: ran.size,
    ran: [...ran],
  };
}

/** The report as lines a person reads in a log. */
export function describeReport(report: RunDueReport): string[] {
  const lines = ['Marimo Agent job runner'];

  if (report.problem !== undefined) {
    lines.push(`  FAILED: ${report.problem}`);
    return lines;
  }

  if (report.appIsRunning) {
    /*
     * Not a failure, and said plainly rather than logged as an error: the app
     * runs the jobs while it is open, so there was nothing for this process to
     * do.
     */
    lines.push('  the app is running, so it is looking after the jobs.');
    return lines;
  }

  lines.push(`  data directory: ${report.userData}`);
  if (report.ran.length === 0) {
    lines.push(
      `  jobs: ${report.total} (${report.enabled} enabled), none due.`,
    );
    return lines;
  }

  lines.push(`  ran ${report.ran.length} job(s):`);
  for (const jobId of report.ran) {
    lines.push(`    - ${jobId}`);
  }
  return lines;
}

interface Options {
  json: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  return {json: argv.includes('--json')};
}

/**
 * Runs the report and answers the exit code the OS timer will see.
 *
 * Exported so the app can call it directly when it is the one that came due, and
 * so a test can assert on the code rather than on a spawned process.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArguments(argv);

  try {
    const report = await runDue({paths: resolveRunnerPaths()});
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const line of describeReport(report)) {
        process.stdout.write(`${line}\n`);
      }
    }
    // A report with a problem in it is a failed run, not a quiet one.
    return report.problem === undefined ? 0 : 1;
  } catch (error) {
    /*
     * A non-zero exit is the only signal the OS timer has. It is reserved for
     * "this process could not do its job" — a corrupt jobs file, a data
     * directory it cannot read — and never for "there was nothing to do", which
     * is the ordinary case for a timer that fires every minute.
     */
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[marimo] the job runner could not start: ${detail}\n`,
    );
    return 1;
  }
}

/**
 * Whether this module is the process's entry point.
 *
 * Checked before doing any work, because the app imports this module too: an
 * unguarded top-level call would make importing it run a job report as a side
 * effect, which in the app means a stray write to stdout and a process exit code
 * set by something the user never asked for.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
