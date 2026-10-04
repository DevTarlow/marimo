/**
 * The Electron half of path resolution.
 *
 * `@marimo/runtime` owns the layout and takes the user-data directory as an
 * argument; this file is the one place that knows the answer, because it is the
 * only place with an `app` object. The headless runner works the same directory
 * out from the platform's own rules for itself, and `userDataDisagreement` below
 * is what reports it when the two stop agreeing.
 */
import {resolve} from 'node:path';

import {app} from 'electron';

import {defaultUserDataDir, resolveAppPaths} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';

import {PRODUCT_NAME, USER_DATA_ENV} from '../shared/product.js';

export {USER_DATA_ENV};

/**
 * Relocates everything the app owns, for development, smoke runs and tests.
 *
 * It has to happen before the app is ready and before the single-instance lock
 * is requested, because Electron keeps that lock *inside* the user-data
 * directory: two instances pointed at two directories are the only way to run an
 * isolated copy beside a real one.
 */
export function applyUserDataOverride(): void {
  const override = process.env[USER_DATA_ENV];
  if (override !== undefined && override.length > 0) {
    app.setPath('userData', resolve(override));
  }
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

  const actual = app.getPath('userData');
  const name = app.getName();

  if (name !== PRODUCT_NAME) {
    return (
      `Electron calls this app "${name}" but the runner looks for ` +
      `"${PRODUCT_NAME}". They must match or the background service will read a ` +
      'different directory from the one the window writes.'
    );
  }

  const derived = defaultUserDataDir({appName: PRODUCT_NAME});
  if (actual === derived) {
    return undefined;
  }

  return (
    `The app is using ${actual} but the headless job runner would use ` +
    `${derived}. Scheduled jobs that run while the app is closed would read ` +
    'a different directory.'
  );
}
