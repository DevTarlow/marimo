/**
 * Facts about this product that more than one entry point needs.
 *
 * **The name on screen and the name on disk are two different facts**, and the
 * split is the whole reason this file has two constants rather than one. The app
 * is called Marimo; the folder everything is kept in is still `Marimo Agent`,
 * because that is where every installed copy already keeps its conversations,
 * jobs, memory and keys, and a rename that moved the folder would look exactly
 * like a fresh install that had lost all of them.
 *
 * That distinction is load-bearing rather than cosmetic. Electron derives its
 * user-data directory from `productName` in `package.json`, and the headless job
 * runner has no `app` object to ask — so both processes ask `userDataDirFor`
 * below instead, which is the one place that rule is written down. The window
 * then pins Electron to that answer rather than letting it derive one, and
 * `userDataDisagreement` reports it when the two processes stop agreeing. If they
 * ever did, nothing would error: the window writes one `jobs.json`, the
 * background service reads another, finds nothing due, and exits 0 — a service
 * that looks healthy and never runs anything.
 */
import {resolve} from 'node:path';

import {defaultUserDataDir} from '@marimo/runtime';

/** What the app is called: the window, the tray, the about line, the installer. */
export const PRODUCT_NAME = 'Marimo';

/**
 * The directory both processes append to the platform's application-data root.
 *
 * Deliberately the former product name. Changing it is a data migration, not a
 * rename, so it changes only when something moves the folder first.
 */
export const USER_DATA_NAME = 'Marimo Agent';

/** The environment variable that relocates all app state, for dev and tests. */
export const USER_DATA_ENV = 'MARIMO_USER_DATA_DIR';

/**
 * Where this install keeps everything, decided the same way by both processes.
 *
 * One function rather than two copies, because the failure of two copies is
 * invisible: the window would write one `jobs.json` and the background service
 * would read another. The override wins, so development, the tests and the smoke
 * check can point a copy at a throwaway directory; otherwise it is the platform's
 * application-data root plus `USER_DATA_NAME` — the *folder's* name, not the
 * product's.
 */
export function userDataDirFor(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[USER_DATA_ENV];
  return override !== undefined && override.length > 0
    ? resolve(override)
    : defaultUserDataDir({appName: USER_DATA_NAME, env});
}

/**
 * How this app introduces itself to an MCP server.
 *
 * Shared rather than written out in each entry point, for the reason
 * `PRODUCT_NAME` is: the window and the headless runner dial the same servers, and
 * a second copy of a version string is a second answer to "which build is asking"
 * — the sort of difference a server's own logs would show last, if at all.
 *
 * The client id stays the old slug rather than following the screen: it is what a
 * *server's* configuration and logs key on, and the same reason `package.json`'s
 * `name` and the executable are still `marimo-agent`.
 */
export const MCP_CLIENT = {name: 'marimo-agent', version: '0.1.0'} as const;
