/**
 * The Electron half of path resolution.
 *
 * `@marimo/runtime` owns the layout and takes the user-data directory as an
 * argument; this file is the one place with an `app` object to hand it one. Which
 * directory that is comes from `userDataDirFor` in `shared/product.ts`, shared
 * with the headless runner rather than written twice, and
 * `userDataDisagreement` below is what reports it when the two stop agreeing.
 */
import {mkdirSync} from 'node:fs';

import {app} from 'electron';

import {resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {USER_DATA_ENV, userDataDirFor} from '../shared/product.js';

export {USER_DATA_ENV};

/**
 * Pins this run to the directory both processes use, before the app is ready.
 *
 * Electron would derive a directory from `productName`, and since the app is
 * called Marimo that derivation is now `…/Marimo` — while every installed copy
 * has its conversations and keys in `…/Marimo Agent`. Setting it explicitly is
 * what keeps a rename from being a data migration; `userDataDisagreement` is the
 * check that the runner still agrees about the answer.
 *
 * It has to happen before the app is ready and before the single-instance lock
 * is requested, because Electron keeps that lock *inside* the user-data
 * directory: two instances pointed at two directories are the only way to run an
 * isolated copy beside a real one. The directory is created first, because
 * `setPath` throws for one that does not exist — which is exactly the
 * fresh-install case.
 *
 * `dir` is a parameter only so a test can watch the creation happen somewhere it
 * may write; every caller leaves it at the decision.
 */
export function applyUserDataPath(dir: string = userDataDirFor()): void {
  mkdirSync(dir, {recursive: true});
  app.setPath('userData', dir);
}

/** Every location the app owns, for this run. */
export function resolvePaths(): AppPaths {
  return resolveAppPaths(app.getPath('userData'));
}

/**
 * Checks that the runner would find the same directory this app is using.
 *
 * These two must agree, and when they do not nothing errors: the window writes
 * one `jobs.json`, the background service reads another, finds nothing due, and
 * exits 0. That is a service which looks healthy and never runs anything, so the
 * disagreement is worth reporting the moment it exists rather than being
 * discovered from a job that quietly never fired.
 *
 * Returns the complaint, or undefined when they agree. Silent when the override
 * is set, because that deliberately points both at a directory neither rule
 * predicts.
 */
export function userDataDisagreement(): string | undefined {
  const override = process.env[USER_DATA_ENV];
  if (override !== undefined && override.length > 0) {
    return undefined;
  }

  const derived = userDataDirFor();
  const actual = app.getPath('userData');
  if (actual === derived) {
    return undefined;
  }

  return (
    `The app is using ${actual} but the headless job runner would use ` +
    `${derived}. Scheduled jobs that run while the app is closed would read ` +
    'a different directory.'
  );
}
