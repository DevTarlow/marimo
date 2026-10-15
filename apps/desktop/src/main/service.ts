/**
 * Running jobs while the app is closed, from the main process.
 *
 * The plan and the install live in `@marimo/runtime`, which knows nothing about
 * Electron. This file is the part that can only be answered here: which binary to
 * name, where the runner script is, and — the one that is easy to get wrong —
 * whether the provider a scheduled job would use is one a process with no
 * keychain can actually read.
 */
import {join} from 'node:path';

import {
  installService,
  nodeServiceHost,
  serviceState,
  uninstallService,
} from '@marimo/runtime';
import type {AppPaths, ServiceSpec} from '@marimo/runtime';

import {activeProvider, PROVIDERS} from '@marimo/protocol';
import type {
  ServiceChange,
  ServiceStatus,
  StoredSettings,
} from '@marimo/protocol';

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
  /**
   * The settings as they are on disk.
   *
   * Injected rather than read from `context.paths.settings` here, because the
   * answer has to be the one the app is actually running under: a second reader
   * of the same file would be a second answer to "which provider is active",
   * and the one the card showed would be the wrong one.
   */
  readSettings: () => Promise<StoredSettings>;
}

/**
 * Whether the active provider is one a process with no keychain could use.
 *
 * That process is the runner, and the question decides whether switching the
 * service on is honest: a provider that needs no key — a llama.cpp server on the
 * user's own machine — has nothing to decrypt, and one whose key the user chose
 * to store readable can be read by anything. Anything else is a job that would
 * be refused at the first turn, which is what the card has to say beforehand
 * rather than after somebody has relied on it overnight.
 */
export function keysReadableIn(settings: StoredSettings): boolean {
  const {id, keyStorage} = activeProvider(settings.providers);
  return !PROVIDERS[id].requiresApiKey || keyStorage === 'plaintext';
}

/** The service definition for this install. */
export function serviceSpec(context: ServiceContext): ServiceSpec {
  return {
    platform:
      process.platform === 'darwin' || process.platform === 'win32'
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

export async function statusOf(
  context: ServiceContext,
): Promise<ServiceStatus> {
  const spec = serviceSpec(context);
  const state = await serviceState(spec, nodeServiceHost());
  return {
    installed: state.installed,
    definitionPath: state.definitionPath,
    keysReadable: keysReadableIn(await context.readSettings()),
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
  const outcome = await uninstallService(
    serviceSpec(context),
    nodeServiceHost(),
  );
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
