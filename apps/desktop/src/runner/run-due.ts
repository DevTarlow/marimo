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
 * Two consequences of that choice are worth stating plainly, because they are
 * the shape of the whole feature:
 *
 * **No display is required.** A plain Electron process needs a display server,
 * so it cannot be the thing a boot-time timer launches. Running as Node means
 * this works over SSH, in a container, and at login before any compositor is up.
 *
 * **No `safeStorage`.** There is no `app` object in Node mode, so an encrypted
 * secret cannot be decrypted. That is why running jobs while the app is closed
 * requires the plain-text opt-in, and why a run that cannot read the key records
 * that as its outcome instead of failing obscurely at the provider.
 *
 * At this stage it reports what it finds rather than running turns: the agent
 * host is wired in with the rest of the capabilities, and a runner that silently
 * did nothing would be indistinguishable from one that worked.
 */
import {pathToFileURL} from 'node:url';

import {defaultUserDataDir, JobStore, resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';
import type {Job} from '@marimo/protocol';

import {PRODUCT_NAME, USER_DATA_ENV} from '../shared/product.js';

export interface DueJob {
  id: string;
  name: string;
  profileId: string;
  /** The occurrence that has passed and has not been dealt with yet. */
  dueAt: string;
}

export interface RunDueReport {
  userData: string;
  /** Jobs across every agent, not only the one the window happens to show. */
  total: number;
  enabled: number;
  due: DueJob[];
  /**
   * Why the jobs could not be read, when they could not be.
   *
   * Present means "this process could not do its job", which is a different
   * thing from "there was nothing to do" and has to look different: a runner
   * that reported an unreadable file as an empty one would exit 0 every minute
   * for a week and never run anything, with nothing anywhere to say so.
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
export function resolveRunnerPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const override = env[USER_DATA_ENV];
  const userData =
    override !== undefined && override.length > 0
      ? override
      : defaultUserDataDir({appName: PRODUCT_NAME, env});
  return resolveAppPaths(userData);
}

/**
 * The jobs that are due, across every agent.
 *
 * `dueAt` is the occurrence the scheduler is watching and it is deliberately not
 * `nextRunAt`: the latter is always in the future — it is what the card promises
 * — so it cannot also be the moment that says "this one is now". A job is due
 * when its watched occurrence has passed, which is what stops a daily job firing
 * once a minute all day.
 *
 * A paused job is never due, and that is the only reason `enabled` is consulted
 * here rather than left to the caller.
 */
export function dueJobs(jobs: readonly Job[], now: Date): DueJob[] {
  const due: DueJob[] = [];

  for (const job of jobs) {
    if (!job.enabled || job.dueAt === undefined) {
      continue;
    }
    const at = Date.parse(job.dueAt);
    if (!Number.isFinite(at) || at > now.getTime()) {
      continue;
    }
    due.push({
      id: job.id,
      name: job.name,
      profileId: job.profileId,
      dueAt: job.dueAt,
    });
  }

  return due;
}

/**
 * Reads the jobs document and works out what is due, without running anything.
 *
 * Separated from the entry point so it can be called by a test with a fixed
 * clock, and later by the app itself when it wants to know whether the background
 * service has anything waiting.
 */
export async function inspectDueJobs(options: {
  paths: AppPaths;
  now?: Date;
}): Promise<RunDueReport> {
  const store = new JobStore({file: options.paths.jobs});
  const {jobs, problem} = await store.loadChecked();
  const now = options.now ?? new Date();

  return {
    userData: options.paths.userData,
    total: jobs.jobs.length,
    enabled: jobs.jobs.filter((job) => job.enabled).length,
    due: dueJobs(jobs.jobs, now),
    ...(problem === undefined ? {} : {problem}),
  };
}

/** The report as lines a person reads in a log. */
export function describeReport(report: RunDueReport): string[] {
  const lines = [
    `Marimo Agent job runner`,
    `  data directory: ${report.userData}`,
  ];

  if (report.problem !== undefined) {
    /*
     * Printed before the counts and phrased as a failure, because that is what
     * it is: the job list below is empty only because nothing could be read.
     */
    lines.push(`  FAILED: ${report.problem}`);
    return lines;
  }

  lines.push(`  jobs: ${report.total} (${report.enabled} enabled)`);

  if (report.due.length === 0) {
    lines.push('  nothing due.');
    return lines;
  }

  lines.push(`  due now: ${report.due.length}`);
  for (const job of report.due) {
    lines.push(`    - ${job.name} (${job.id}), due ${job.dueAt}`);
  }
  lines.push(
    '  This build reports due jobs rather than running them: the agent host is',
    '  wired in with the rest of the capabilities. Nothing was run.',
  );
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
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArguments(argv);

  try {
    const report = await inspectDueJobs({paths: resolveRunnerPaths()});
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
    process.stderr.write(`[marimo] the job runner could not start: ${detail}\n`);
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
