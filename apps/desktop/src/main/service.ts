/**
 * Running jobs while the app is closed, from the main process.
 *
 * The plan and the install live in `@marimo/runtime`, which knows nothing about
 * Electron. This file is the part that can only be answered here: which binary to
 * name, where the runner script is, and whether the keys this install holds are
 * ones a process without a keychain could read.
 *
 * That last question is the one worth having a file for. The runner has no
 * `safeStorage`, so an encrypted key is one it cannot decrypt — and a service
 * switched on over an encrypted key does not fail loudly. It runs every minute,
 * refuses for want of a key, records that against the job, and does it again.
 * Nobody is watching. So it is asked *before* the switch is offered, not after.
 */
import {join} from 'node:path';

import {FileSecretStore, installService, nodeServiceHost, serviceState, uninstallService} from '@marimo/runtime';
import type {AppPaths, ServiceSpec} from '@marimo/runtime';

import {activeProvider, PROVIDERS} from '@marimo/protocol';
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
  /** How the app's settings describe the provider, for the key check. */
  providers: () => Promise<Parameters<typeof activeProvider>[0]>;
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

/**
 * Whether the configured key would survive the trip to a windowless process.
 *
 * Read with *no cipher*, which is exactly the runner's situation: an encrypted
 * file answers `unreadable` with the message that names the fix. Absent is not
 * reported as unreadable — a key that has not been entered yet is a different
 * problem, and the toggle should not blame encryption for it.
 */
export async function keysAreReadable(
  context: ServiceContext,
): Promise<boolean> {
  try {
    const provider = activeProvider(await context.providers());
    const store = new FileSecretStore(
      context.paths.providerSecrets[provider.id],
      `${PROVIDERS[provider.id].label} API key`,
    );
    return (await store.read()).state !== 'unreadable';
  } catch {
    /*
     * A settings file that cannot be read is not a reason to refuse to answer.
     * Reporting "not readable" errs towards telling the user about a problem
     * rather than towards switching on a service that will fail silently.
     */
    return false;
  }
}

export async function statusOf(context: ServiceContext): Promise<ServiceStatus> {
  const spec = serviceSpec(context);
  const state = await serviceState(spec, nodeServiceHost());
  return {
    installed: state.installed,
    keysReadable: await keysAreReadable(context),
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
