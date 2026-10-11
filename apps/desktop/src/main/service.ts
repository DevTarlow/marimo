/**
 * Running jobs while the app is closed, from the main process.
 *
 * The plan and the install live in `@marimo/runtime`, which knows nothing about
 * Electron. This file is the part that can only be answered here: which binary to
 * name, and where the runner script is.
 *
 * It used to answer a third question — whether the keys this install held were
 * ones a process without a keychain could read — and that went with the keys. A
 * background run needs no secret: the model is a local engine and the runner does
 * not dial connectors, so switching the service on is a plain choice now.
 */
import {join} from 'node:path';

import {installService, nodeServiceHost, serviceState, uninstallService} from '@marimo/runtime';
import type {AppPaths, ServiceSpec} from '@marimo/runtime';

import type {ServiceChange, ServiceStatus} from '@marimo/protocol';

import {PRODUCT_NAME} from '../shared/product.js';

/**
 * How often the OS wakes the runner.
 *
 * A minute, because the finest granularity a cron schedule can express is a
 * minute — waking more often would be a process started for nothing, and waking
 * less often would make a `* * * * *` job late.
 */
export const EVERY_MINUTES = 1;

export interface ServiceContext {
  paths: AppPaths;
  /** The app's own binary, which is also the runner's when asked to be Node. */
  execPath: string;
  /** The app's root: `resources/app.asar` when packaged, the repo when not. */
  appPath: string;
  home: string;
  configHome: string;
}

/** The service definition for this install. */
export function serviceSpec(context: ServiceContext): ServiceSpec {
  return {
    platform: process.platform === 'darwin' || process.platform === 'win32'
      ? process.platform
      : 'linux',
    execPath: context.execPath,
    /*
     * Inside the app, so the service runs the code that shipped with it rather
     * than a copy that can drift. Electron reads inside an asar archive, so this
     * path is valid packaged and unpackaged alike.
     */
    scriptPath: join(context.appPath, 'dist', 'runner', 'run-due.js'),
    userDataDir: context.paths.userData,
    home: context.home,
    configHome: context.configHome,
    everyMinutes: EVERY_MINUTES,
  };
}

export async function statusOf(context: ServiceContext): Promise<ServiceStatus> {
  const spec = serviceSpec(context);
  const state = await serviceState(spec, nodeServiceHost());
  return {
    installed: state.installed,
    definitionPath: state.definitionPath,
  };
}

export async function enable(context: ServiceContext): Promise<ServiceChange> {
  const outcome = await installService(serviceSpec(context), nodeServiceHost());
  return {
    // Asked rather than assumed: `install` reports what it was told to do, and
    // the platform is the only thing that knows whether it took.
    installed: (await statusOf(context)).installed,
    notes: outcome.notes,
    failures: outcome.failures.map((failure) => ({
      what: failure.what,
      // The command as well as the complaint: a user who has to finish this by
      // hand needs the exact line, and it is the one thing the app can tell them
      // that a message from systemd cannot.
      detail: `${failure.detail} (${failure.command})`,
    })),
  };
}

export async function disable(context: ServiceContext): Promise<ServiceChange> {
  const outcome = await uninstallService(serviceSpec(context), nodeServiceHost());
  return {
    installed: (await statusOf(context)).installed,
    notes: outcome.notes,
    failures: outcome.failures.map((failure) => ({
      what: failure.what,
      detail: `${failure.detail} (${failure.command})`,
    })),
  };
}

/** The product name, re-exported so a caller needs one import for the service. */
export {PRODUCT_NAME};
