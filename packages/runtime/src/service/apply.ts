/**
 * Carrying out a service plan.
 *
 * Deliberately dull, and deliberately the only part that touches the machine. The
 * knowledge is in `plan.ts`, which is pure and therefore assertable; this file
 * writes files and runs commands, and the interesting failure is always that a
 * command refused — so everything here is about *reporting* that well rather than
 * deciding anything.
 *
 * The host is injected, which is what lets the tests exercise the whole install
 * path — including a `systemctl` that fails and a `loginctl` that needs
 * privileges — without a test machine ever having a timer installed on it.
 */
import {execFile} from 'node:child_process';
import {chmod, mkdir, rm, stat, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {promisify} from 'node:util';

import {planService} from './plan.js';
import type {PlannedCommand, ServicePlan, ServiceSpec} from './plan.js';

const execFileAsync = promisify(execFile);

/** What a command answered. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything an install needs from the machine. */
export interface ServiceHost {
  writeFile(path: string, contents: string, mode?: number): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  run(argv: string[]): Promise<CommandResult>;
}

/** One step that did not work. */
export interface ServiceFailure {
  what: string;
  /** The command, as it was run, for a user who wants to do it by hand. */
  command: string;
  detail: string;
}

export interface ServiceOutcome {
  ok: boolean;
  /** Steps that failed and mattered. */
  failures: ServiceFailure[];
  /**
   * Steps that failed and did not.
   *
   * Linger is the case this exists for: it needs privileges the user may not
   * have, and the timer is installed and working either way. Reporting it as a
   * failure would be telling the user their working setup is broken.
   */
  notes: string[];
}

/** How a service is doing. */
export interface ServiceState {
  installed: boolean;
  /** Where the definition lives, when the platform keeps one. */
  definitionPath: string;
}

/** Installs or replaces the service, and starts it. */
export async function installService(
  spec: ServiceSpec,
  host: ServiceHost,
): Promise<ServiceOutcome> {
  const plan = planService(spec);
  const failures: ServiceFailure[] = [];
  const notes: string[] = [];

  for (const file of plan.files) {
    try {
      await host.writeFile(file.path, file.contents, file.mode);
    } catch (error) {
      failures.push({
        what: `write ${file.path}`,
        command: file.path,
        detail: describe(error),
      });
    }
  }

  // Nothing to start if the definition could not be written, and running the
  // commands anyway would produce a second, more confusing failure.
  if (failures.length > 0) {
    return {ok: false, failures, notes};
  }

  await runAll(plan.install, host, failures, notes);
  return {ok: failures.length === 0, failures, notes};
}

/** Stops the service and removes it. */
export async function uninstallService(
  spec: ServiceSpec,
  host: ServiceHost,
): Promise<ServiceOutcome> {
  const plan = planService(spec);
  const failures: ServiceFailure[] = [];
  const notes: string[] = [];

  /*
   * Stopped before the definition is removed, not after. A timer whose unit file
   * has gone but which is still loaded is one systemd will keep firing until the
   * next daemon-reload, and the run it fires has no unit to explain where it came
   * from.
   */
  await runAll(plan.uninstall, host, failures, notes, {soft: true});

  for (const path of plan.remove) {
    try {
      await host.remove(path);
    } catch (error) {
      failures.push({
        what: `remove ${path}`,
        command: path,
        detail: describe(error),
      });
    }
  }

  return {ok: failures.length === 0, failures, notes};
}

/**
 * Whether the service is installed.
 *
 * Asked of the platform rather than remembered, because the answer changes
 * without this app's involvement: a user can remove a unit file by hand, and a
 * status that is a cached boolean would go on claiming a service that is gone.
 */
export async function serviceState(
  spec: ServiceSpec,
  host: ServiceHost,
): Promise<ServiceState> {
  const plan = planService(spec);
  return {
    installed: await isInstalled(plan, host),
    definitionPath: plan.definitionPath,
  };
}

async function isInstalled(plan: ServicePlan, host: ServiceHost): Promise<boolean> {
  if (plan.probe.kind === 'file') {
    return await host.exists(plan.probe.path);
  }
  try {
    const result = await host.run(plan.probe.argv);
    return result.code === 0;
  } catch {
    // A probe that cannot run is not an installed service. The alternative —
    // assuming yes — would offer to uninstall something that may not exist.
    return false;
  }
}

async function runAll(
  commands: PlannedCommand[],
  host: ServiceHost,
  failures: ServiceFailure[],
  notes: string[],
  /** For uninstall: every step is best-effort, because the point is to remove. */
  options: {soft?: boolean} = {},
): Promise<void> {
  for (const command of commands) {
    try {
      const result = await host.run(command.argv);
      if (result.code === 0) {
        continue;
      }
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.code)}`;
      record(command, detail);
    } catch (error) {
      record(command, describe(error));
    }
  }

  function record(command: PlannedCommand, detail: string): void {
    const entry: ServiceFailure = {
      what: command.what,
      command: command.argv.join(' '),
      detail,
    };
    if (command.optional === true || options.soft === true) {
      notes.push(`${command.what}: ${detail}`);
    } else {
      failures.push(entry);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The real machine.
 *
 * `run` answers a non-zero exit as a result rather than an exception, because a
 * command that refuses is the normal way this fails and the caller wants its
 * stderr. A command that could not be started at all — not on `PATH` — is still
 * an exception, because there is no output to read.
 */
export function nodeServiceHost(): ServiceHost {
  return {
    async writeFile(path, contents, mode) {
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, contents, 'utf8');
      if (mode !== undefined) {
        await chmod(path, mode);
      }
    },

    async remove(path) {
      await rm(path, {force: true});
    },

    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },

    async run(argv) {
      const [file, ...args] = argv;
      if (file === undefined) {
        throw new Error('An empty command was planned.');
      }
      try {
        const {stdout, stderr} = await execFileAsync(file, args, {
          // Generous: `systemctl` can block on a slow session bus, and killing it
          // early would report a working install as a failure.
          timeout: 30_000,
        });
        return {code: 0, stdout, stderr};
      } catch (error) {
        const failed = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        // `code` is a string like 'ENOENT' when the command was never started.
        if (typeof failed.code !== 'number') {
          throw error;
        }
        return {
          code: failed.code,
          stdout: failed.stdout ?? '',
          stderr: failed.stderr ?? '',
        };
      }
    },
  };
}
