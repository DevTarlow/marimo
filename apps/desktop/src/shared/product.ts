/**
 * Facts about this product that more than one entry point needs.
 *
 * **The name on screen and the name on disk are two different facts**, and this
 * file keeps them in two constants even though both hold the same string today.
 * That is not tidiness. The folder was `Marimo Agent` for the whole life of the
 * app called Marimo, and moving it to `Marimo Bot` is a migration rather than a
 * rename — `adoptFormerUserDataDir` is that migration, and it exists because the
 * two names were allowed to differ once already. The day somebody collapses these
 * constants into one is the day the next rename opens every installed copy empty.
 *
 * The distinction is load-bearing rather than cosmetic. Electron derives its
 * user-data directory from `productName` in `package.json`, and the headless job
 * runner has no `app` object to ask — so both processes ask `userDataDirFor`
 * below instead, which is the one place that rule is written down. The window
 * then pins Electron to that answer rather than letting it derive one, and
 * `userDataDisagreement` reports it when the two processes stop agreeing. If they
 * ever did, nothing would error: the window writes one `jobs.json`, the
 * background service reads another, finds nothing due, and exits 0 — a service
 * that looks healthy and never runs anything.
 */
import {existsSync, renameSync} from 'node:fs';
import {resolve} from 'node:path';

import {defaultUserDataDir} from '@marimo/runtime';

/** What the app is called: the window, the tray, the about line, the installer. */
export const PRODUCT_NAME = 'Marimo Bot';

/**
 * The directory both processes append to the platform's application-data root.
 *
 * The same string as `PRODUCT_NAME` today, and still a constant of its own:
 * a value here moves only when something has moved the folder first, which is
 * what `adoptFormerUserDataDir` is for.
 */
export const USER_DATA_NAME = 'Marimo Bot';

/**
 * What that folder was called before this rename.
 *
 * Every copy installed before it keeps its conversations, jobs, memory and keys
 * in a directory of this name, so this string is moved by the migration below and
 * is still named by a job definition that was written before the rename. It is
 * history rather than a setting: nothing writes it again, and deleting it would
 * strand exactly the installs it exists for.
 */
export const FORMER_USER_DATA_NAME = 'Marimo Agent';

/** The environment variable that relocates all app state, for dev and tests. */
export const USER_DATA_ENV = 'MARIMO_USER_DATA_DIR';

function dirNamed(
  appName: string,
  env: NodeJS.ProcessEnv,
  home?: string,
): string {
  return defaultUserDataDir({appName, env, home});
}

/** Where an install made before the rename kept everything. Never written now. */
export function formerUserDataDirFor(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string {
  return dirNamed(FORMER_USER_DATA_NAME, env, home);
}

/**
 * Where this install keeps everything, decided the same way by both processes.
 *
 * One function rather than two copies, because the failure of two copies is
 * invisible: the window would write one `jobs.json` and the background service
 * would read another. The override wins, so development, the tests and the smoke
 * check can point a copy at a throwaway directory; otherwise it is the platform's
 * application-data root plus `USER_DATA_NAME`.
 *
 * `home` is a parameter so a test can ask the question somewhere it may write,
 * the same seam `applyUserDataPath` has and for the same reason.
 */
export function userDataDirFor(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string {
  const override = env[USER_DATA_ENV];
  if (override === undefined || override.length === 0) {
    return dirNamed(USER_DATA_NAME, env, home);
  }

  /*
   * A job definition installed before the rename names the folder the app used to
   * use, because `runnerEnvironment` bakes the directory into the systemd unit
   * and a rename cannot reach into a unit that is already on disk. That timer is
   * still this install, so an override naming the former folder is read as the
   * folder that moved rather than as one that no longer exists — which is the
   * difference between a scheduled job that keeps running and the silent failure
   * invariant 13 is about. Switching the service off and on writes a definition
   * that names the new folder, and then this stops firing; nothing else can
   * produce this string, because nothing else knows it.
   */
  const fromOverride = resolve(override);
  const former = formerUserDataDirFor(env, home);
  if (fromOverride !== former || existsSync(former)) {
    return fromOverride;
  }

  const current = dirNamed(USER_DATA_NAME, env, home);
  return existsSync(current) ? current : fromOverride;
}

/**
 * Moves a pre-rename install's folder to its new name, once.
 *
 * Called by both entry points before anything reads the directory — the window
 * before `applyUserDataPath` creates the new one, and the runner before it
 * resolves its paths — because the folder has to move before either can be sure
 * which of the two it is looking at. Whichever process starts first does it, and
 * the other finds the work already done.
 *
 * Three cases are deliberately a no-op: there is an override (an explicit
 * directory is an explicit choice), the new folder already exists (migrated
 * already, or a fresh install), or there is nothing to move.
 *
 * `rename` rather than a copy, because both names sit under the same parent, so
 * the move is one filesystem operation rather than a window in which the
 * conversations exist twice and a crash leaves them half in each.
 *
 * `home` is a parameter for the reason `userDataDirFor`'s is: a test has to be
 * able to watch a directory move somewhere it may write, and the real one holds
 * somebody's conversations.
 */
export function adoptFormerUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): void {
  const override = env[USER_DATA_ENV];
  if (override !== undefined && override.length > 0) {
    return;
  }

  const former = formerUserDataDirFor(env, home);
  const current = dirNamed(USER_DATA_NAME, env, home);
  if (existsSync(current) || !existsSync(former)) {
    return;
  }

  try {
    renameSync(former, current);
  } catch {
    /*
     * A move that failed is not a reason to refuse to start. The app opens on the
     * new folder, the old one is still where it was, and a person can copy it
     * across by hand — which is recoverable, where a throw here is a window that
     * does not open at all. The next launch tries again.
     */
  }
}

/**
 * How this app introduces itself to an MCP server.
 *
 * Shared rather than written out in each entry point, for the reason
 * `PRODUCT_NAME` is: the window and the headless runner dial the same servers, and
 * a second copy of a version string is a second answer to "which build is asking"
 * — the sort of difference a server's own logs would show last, if at all.
 *
 * The client id stays the old slug rather than following the screen, for the
 * reason the executable and `package.json`'s `name` do: it is what a *server's*
 * configuration and logs key on, and a rename that reached it would be a rename
 * that silently stopped matching the grants somebody already wrote down.
 */
export const MCP_CLIENT = {name: 'marimo-agent', version: '0.1.0'} as const;
