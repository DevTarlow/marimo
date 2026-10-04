/**
 * Waking the runner while the app is closed.
 *
 * The plans are pure, so what is asserted here is the *content* of what gets
 * installed — which is where every interesting mistake lives. A unit that
 * forgets `ELECTRON_RUN_AS_NODE` produces a service that starts a GUI with no
 * display and does nothing; one that forgets the data directory produces a
 * service that reads a different `jobs.json` and finds nothing due forever; one
 * with `Persistent=true` fires a week of missed runs the moment a laptop wakes.
 *
 * Nothing here installs anything. The host is injected, which is the only reason
 * a test can exercise a failing `systemctl` and a `loginctl` that needs
 * privileges without a timer ending up on the machine running the tests.
 */
import {describe, expect, it} from 'vitest';

import {
  installService,
  serviceState,
  uninstallService,
} from './service/apply.js';
import type {CommandResult, ServiceHost} from './service/apply.js';
import {planService, runnerEnvironment} from './service/plan.js';
import type {ServiceSpec} from './service/plan.js';

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    platform: 'linux',
    execPath: '/opt/marimo/marimo-agent',
    scriptPath: '/opt/marimo/resources/run-due.js',
    userDataDir: '/home/sam/.config/Marimo Agent',
    home: '/home/sam',
    configHome: '/home/sam/.config',
    everyMinutes: 1,
    ...overrides,
  };
}

/** The file with this path, or a failure that names what was looked for. */
function fileAt(plan: ReturnType<typeof planService>, path: string): string {
  const file = plan.files.find((entry) => entry.path === path);
  if (file === undefined) {
    throw new Error(`no planned file at ${path}`);
  }
  return file.contents;
}

describe('the runner environment', () => {
  /*
   * The single most important line in all of this. Without it, a boot-time timer
   * launches a GUI application with no display server, and the service "runs"
   * and does nothing at all — with no error, because Electron failing to find a
   * display is not the job runner's idea of a failure.
   */
  it('runs the app binary as plain Node', () => {
    expect(runnerEnvironment('/data')[ 'ELECTRON_RUN_AS_NODE']).toBe('1');
  });

  /*
   * Invariant 13, made structural. The runner can derive the platform default
   * for itself, but writing it down means the app and the service agree by
   * construction — including for a portable install, and after a change to the
   * product name, which are exactly when they would silently stop agreeing.
   */
  it('names the data directory, so the service reads what the window writes', () => {
    expect(runnerEnvironment('/data/marimo')['MARIMO_USER_DATA_DIR']).toBe(
      '/data/marimo',
    );
  });
});

describe('a systemd user timer', () => {
  const plan = planService(spec());
  const service = fileAt(plan, '/home/sam/.config/systemd/user/marimo-agent-jobs.service');
  const timer = fileAt(plan, '/home/sam/.config/systemd/user/marimo-agent-jobs.timer');

  it('starts the app in Node mode, on a one-shot basis', () => {
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('Environment="ELECTRON_RUN_AS_NODE=1"');
    expect(service).toContain('ExecStart="/opt/marimo/marimo-agent"');
    expect(service).toContain('--json');
  });

  it('passes the data directory through the environment', () => {
    expect(service).toContain(
      'Environment="MARIMO_USER_DATA_DIR=/home/sam/.config/Marimo Agent"',
    );
  });

  it('repeats on the interval it was asked for', () => {
    expect(timer).toContain('OnUnitActiveSec=1min');
    expect(plan.files[1]?.contents).toContain('WantedBy=timers.target');
  });

  it('honours a different interval', () => {
    const five = planService(spec({everyMinutes: 5}));
    expect(fileAt(five, '/home/sam/.config/systemd/user/marimo-agent-jobs.timer'))
      .toContain('OnUnitActiveSec=5min');
  });

  /*
   * The misfire policy, and the most consequential line in the timer. With
   * persistence on, a laptop shut for a week fires every missed occurrence in a
   * burst as it wakes — the opposite of what a schedule means. The scheduler
   * skips stale occurrences too, but not asking for them is better than asking
   * and refusing.
   */
  it('does not ask for the runs it missed while the machine was off', () => {
    expect(timer).toContain('Persistent=false');
  });

  it('reloads systemd before enabling, or the unit is not there yet', () => {
    const what = plan.install.map((command) => command.argv.join(' '));
    expect(what[0]).toContain('daemon-reload');
    expect(what[1]).toContain('enable --now marimo-agent-jobs.timer');
  });

  /*
   * Without linger the user manager stops when the last session ends, so the
   * timer fires while the user is logged in and stops the moment they log out —
   * which is precisely when a background job service is wanted.
   */
  it('asks for linger, but does not insist on it', () => {
    const linger = plan.install.find((command) => command.argv[0] === 'loginctl');
    expect(linger?.argv).toEqual(['loginctl', 'enable-linger']);
    // Optional: on many systems this needs polkit or root, and the service is
    // otherwise installed and working.
    expect(linger?.optional).toBe(true);
  });

  it('stops the timer before forgetting the unit', () => {
    const what = plan.uninstall.map((command) => command.argv.join(' '));
    expect(what[0]).toContain('disable --now marimo-agent-jobs.timer');
    expect(what[1]).toContain('daemon-reload');
  });

  it('is found by its timer file', () => {
    expect(plan.probe).toEqual({
      kind: 'file',
      path: '/home/sam/.config/systemd/user/marimo-agent-jobs.timer',
    });
  });
});

describe('a launchd agent', () => {
  const plan = planService(spec({platform: 'darwin'}));
  const plist = fileAt(
    plan,
    '/home/sam/Library/LaunchAgents/com.marimo.agent.marimo-agent-jobs.plist',
  );

  it('is a plist with the arguments and the environment', () => {
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key>');
    expect(plist).toContain('<string>1</string>');
    expect(plist).toContain('<key>MARIMO_USER_DATA_DIR</key>');
  });

  it('names the interval in seconds, because launchd does', () => {
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>60</integer>');
  });

  it('scales the interval', () => {
    const hourly = planService(spec({platform: 'darwin', everyMinutes: 60}));
    expect(
      fileAt(
        hourly,
        '/home/sam/Library/LaunchAgents/com.marimo.agent.marimo-agent-jobs.plist',
      ),
    ).toContain('<integer>3600</integer>');
  });

  /*
   * Launching at login and launching on a schedule are different wants, and the
   * schedule is the one that was asked for. An agent that also runs at load would
   * do it a second time a minute later.
   */
  it('does not also run at login', () => {
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<false/>');
  });

  /*
   * launchd refuses a label it already knows, so installing over an existing
   * install fails without unloading first — and an uninstall of something that
   * was never installed is not an error.
   */
  it('unloads any previous agent before loading this one', () => {
    expect(plan.install[0]?.argv[1]).toBe('bootout');
    expect(plan.install[0]?.optional).toBe(true);
    expect(plan.install[1]?.argv[1]).toBe('bootstrap');
  });

  it('escapes a path that contains XML', () => {
    const awkward = planService(
      spec({platform: 'darwin', userDataDir: '/Users/a&b/<Marimo>'}),
    );
    const contents = fileAt(
      awkward,
      '/home/sam/Library/LaunchAgents/com.marimo.agent.marimo-agent-jobs.plist',
    );
    expect(contents).toContain('/Users/a&amp;b/&lt;Marimo&gt;');
    // And no raw angle bracket from the value, which would break the parse.
    expect(contents).not.toContain('<Marimo>');
  });
});

describe('a Windows scheduled task', () => {
  const plan = planService(spec({platform: 'win32'}));

  it('writes no file, because Task Scheduler keeps its own', () => {
    expect(plan.files).toEqual([]);
    expect(plan.definitionPath).toBe('');
  });

  it('registers a one-minute task and overwrites without prompting', () => {
    const create = plan.install[0]?.argv ?? [];
    expect(create).toContain('/Create');
    // Without /F, creating over an existing task prompts, and a prompt during an
    // install is a hang.
    expect(create).toContain('/F');
    expect(create).toContain('MINUTE');
    expect(create).toContain('1');
  });

  it('carries the environment in the command line, which is the only place it can', () => {
    const create = plan.install[0]?.argv ?? [];
    const command = create[create.length - 1] ?? '';
    expect(command).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(command).toContain('run-due.js');
  });

  it('asks Task Scheduler whether it exists, since there is no file to look for', () => {
    expect(plan.probe).toEqual({
      kind: 'command',
      argv: ['schtasks', '/Query', '/TN', 'marimo-agent-jobs'],
      what: 'ask Task Scheduler about the task',
    });
  });

  it('removes the task on uninstall', () => {
    expect(plan.uninstall[0]?.argv).toEqual([
      'schtasks',
      '/Delete',
      '/F',
      '/TN',
      'marimo-agent-jobs',
    ]);
  });
});

/* ------------------------------------------------------------------ apply */

/** A host that records everything and answers what it was told to. */
function fakeHost(
  answers: Record<string, Partial<CommandResult> | 'throw'> = {},
): ServiceHost & {
  written: Array<{path: string; contents: string}>;
  removed: string[];
  ran: string[];
} {
  const host = {
    written: [] as Array<{path: string; contents: string}>,
    removed: [] as string[],
    ran: [] as string[],
    async writeFile(path: string, contents: string) {
      host.written.push({path, contents});
    },
    async remove(path: string) {
      host.removed.push(path);
    },
    async exists() {
      return host.written.length > 0;
    },
    async run(argv: string[]): Promise<CommandResult> {
      host.ran.push(argv.join(' '));
      const answer = answers[argv[0] ?? ''];
      if (answer === 'throw') {
        throw new Error('command not found');
      }
      return {code: answer?.code ?? 0, stdout: '', stderr: '', ...answer};
    },
  };
  return host;
}

describe('installing', () => {
  it('writes the definition and then runs the commands', async () => {
    const host = fakeHost();
    const outcome = await installService(spec(), host);

    expect(outcome.ok).toBe(true);
    expect(host.written.map((file) => file.path)).toEqual([
      '/home/sam/.config/systemd/user/marimo-agent-jobs.service',
      '/home/sam/.config/systemd/user/marimo-agent-jobs.timer',
    ]);
    expect(host.ran[0]).toContain('daemon-reload');
  });

  /*
   * Nothing to start if the definition is not there. Running the commands anyway
   * produces a second, more confusing failure — "unit not found" — that hides the
   * real one, which was the write.
   */
  it('does not run the commands when the definition could not be written', async () => {
    const host = fakeHost();
    host.writeFile = async () => {
      throw new Error('read-only file system');
    };

    const outcome = await installService(spec(), host);

    expect(outcome.ok).toBe(false);
    expect(outcome.failures[0]?.detail).toContain('read-only');
    expect(host.ran).toEqual([]);
  });

  it('reports a command that refused, with its own words', async () => {
    const host = fakeHost({systemctl: {code: 1, stderr: 'no session bus'}});
    const outcome = await installService(spec(), host);

    expect(outcome.ok).toBe(false);
    // The command as it was run, for a user who wants to do it by hand...
    expect(outcome.failures[0]?.command).toBe('systemctl --user daemon-reload');
    // ...what it was for, in words, because the argv alone does not say why...
    expect(outcome.failures[0]?.what).toBe('ask systemd to notice the new unit');
    // ...and what the machine said, which is the only part that explains it.
    expect(outcome.failures[0]?.detail).toBe('no session bus');
  });

  /*
   * The distinction the whole outcome type exists for. Linger needs privileges
   * the user may not have, and the timer is installed and working either way;
   * reporting it as a failure would tell somebody their working setup is broken.
   */
  it('notes an optional step instead of failing on it', async () => {
    const host = fakeHost({
      loginctl: {code: 1, stderr: 'Access denied'},
    });
    const outcome = await installService(spec(), host);

    expect(outcome.ok).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes[0]).toContain('outlive the login session');
    expect(outcome.notes[0]).toContain('Access denied');
  });

  it('reports a command that could not be started at all', async () => {
    const host = fakeHost({systemctl: 'throw'});
    const outcome = await installService(spec(), host);

    expect(outcome.ok).toBe(false);
    expect(outcome.failures[0]?.detail).toContain('not found');
  });
});

describe('uninstalling', () => {
  it('stops the service before deleting its definition', async () => {
    const host = fakeHost();
    host.written.push({path: 'marker', contents: ''});

    await uninstallService(spec(), host);

    // Every command before every removal: a timer whose unit file has gone but
    // which is still loaded keeps firing, with no unit to explain where it came
    // from.
    expect(host.ran[0]).toContain('disable --now');
    expect(host.removed).toEqual([
      '/home/sam/.config/systemd/user/marimo-agent-jobs.service',
      '/home/sam/.config/systemd/user/marimo-agent-jobs.timer',
    ]);
  });

  /*
   * Uninstalling something that was never installed, or was already partly
   * removed by hand, still has to end with it gone. Every step is best-effort for
   * that reason, and the failures are reported as notes rather than refused.
   */
  it('removes the files even when the commands refuse', async () => {
    const host = fakeHost({systemctl: {code: 1, stderr: 'not loaded'}});
    const outcome = await uninstallService(spec(), host);

    expect(outcome.ok).toBe(true);
    expect(outcome.notes).toHaveLength(2);
    expect(host.removed).toHaveLength(2);
  });
});

describe('status', () => {
  it('answers from the file where the platform keeps one', async () => {
    const host = fakeHost();
    await installService(spec(), host);

    expect((await serviceState(spec(), host)).installed).toBe(true);
  });

  it('answers not installed once the definitions are gone', async () => {
    const host = fakeHost();
    expect((await serviceState(spec(), host)).installed).toBe(false);
  });

  /*
   * Asked of the platform rather than remembered. A user can remove a unit file
   * by hand, and a cached boolean would go on claiming a service that is gone —
   * which is worst in exactly the case it matters, offering to uninstall
   * something that no longer exists.
   */
  it('asks the platform where there is no file to look for', async () => {
    const host = fakeHost();
    const state = await serviceState(spec({platform: 'win32'}), host);

    expect(host.ran[0]).toBe('schtasks /Query /TN marimo-agent-jobs');
    expect(state.installed).toBe(true);
  });

  it('treats a probe that cannot run as not installed', async () => {
    const host = fakeHost({schtasks: 'throw'});
    const state = await serviceState(spec({platform: 'win32'}), host);

    expect(state.installed).toBe(false);
  });
});
