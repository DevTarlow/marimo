/**
 * Waking the job runner when the app is closed.
 *
 * There is no portable way to say "run this every minute", so this file produces
 * the three platform-specific descriptions of that request — a systemd user
 * timer, a launchd agent, a Task Scheduler entry — and nothing else. Producing
 * them is pure: a plan is data, and data can be asserted on. Applying one is a
 * separate, deliberately dull function in `apply.ts`, because the interesting
 * mistakes are all in what gets written, not in the writing.
 *
 * Three decisions run through all of it.
 *
 * **The command is this binary in Node mode.** `ELECTRON_RUN_AS_NODE=1` plus the
 * runner's path means the background service is the same executable as the app,
 * with the same agent core and the same stores. A separate runtime would be a
 * second thing to install, version and get out of step.
 *
 * **The data directory is written into the unit.** The runner can work out the
 * platform default for itself, but writing it makes the app and the service agree
 * *by construction* — including for a portable install and after a change to the
 * product name, which is precisely the pair of situations where they would
 * silently stop agreeing and the service would read an empty `jobs.json` forever.
 *
 * **Nothing here trusts `$HOME` or `$XDG_CONFIG_HOME` at run time.** They are
 * resolved once, when the service is installed, and baked in. A timer started at
 * login may well not have them.
 */
import {join} from 'node:path';

/** The platforms this app is built for, in the order they ship. */
export type ServicePlatform = 'linux' | 'darwin' | 'win32';

/** A file the service needs on disk. */
export interface PlannedFile {
  path: string;
  contents: string;
  /** Applied where the platform has modes; ignored elsewhere. */
  mode?: number;
}

/** A command to run, said in words as well as in argv. */
export interface PlannedCommand {
  argv: string[];
  /** What this is for, shown to the user if it fails. */
  what: string;
  /**
   * Whether a failure should be reported rather than fatal.
   *
   * For the one step that needs privileges the user may not have — enabling
   * linger so the timer outlives the session — where the service is otherwise
   * installed and refusing the whole thing would be wrong.
   */
  optional?: boolean;
}

export interface ServiceSpec {
  platform: ServicePlatform;
  /** The app binary. Electron run as Node when the environment says so. */
  execPath: string;
  /** The runner script inside the app. */
  scriptPath: string;
  /** Baked into the unit so the service reads what the window writes. */
  userDataDir: string;
  /** Where the user's config lives: `~/.config`, `~/Library`, and so on. */
  home: string;
  /**
   * `XDG_CONFIG_HOME`, resolved at install time.
   *
   * Not read at run time: a timer started at login may not have it, and a unit
   * in the wrong place is a service that is installed and never fires.
   */
  configHome: string;
  /** How often to wake. */
  everyMinutes: number;
}

export interface ServicePlan {
  files: PlannedFile[];
  install: PlannedCommand[];
  /** Files to delete when uninstalling. */
  remove: string[];
  uninstall: PlannedCommand[];
  /**
   * The identity of the service, so a status check knows what to look for.
   *
   * `unit` is a systemd unit name, a launchd label, or a Task Scheduler task
   * name — whatever the platform calls a thing it can be asked about.
   */
  unit: string;
  /** Where the platform records the installed definition, when it is a file. */
  definitionPath: string;
  /** How to ask the platform whether the service is installed. */
  probe: ServiceProbe;
}

/**
 * How to find out whether the service is installed.
 *
 * A file where the platform keeps one, and a command where it does not. Task
 * Scheduler is the second case: its definitions live in its own database, so the
 * only way to ask is to ask it.
 */
export type ServiceProbe =
  | {kind: 'file'; path: string}
  | {kind: 'command'; argv: string[]; what: string};

/** The unit, label and task name. One identity across three platforms. */
export const SERVICE_UNIT = 'marimo-agent-jobs';

/** The user-visible name, for the places that show a description. */
export const SERVICE_LABEL = 'Marimo scheduled jobs';

/**
 * The environment that makes the app binary behave as plain Node.
 *
 * This is what lets a boot-time timer launch the runner with no display server
 * present. Without it the process starts a GUI, fails to find a display, and the
 * service is one that "runs" and does nothing at all.
 */
export function runnerEnvironment(userDataDir: string): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: '1',
    MARIMO_USER_DATA_DIR: userDataDir,
  };
}

/** The plan for this platform. */
export function planService(spec: ServiceSpec): ServicePlan {
  switch (spec.platform) {
    case 'linux':
      return planSystemd(spec);
    case 'darwin':
      return planLaunchd(spec);
    case 'win32':
      return planScheduledTask(spec);
    default: {
      // Exhaustive by construction: adding a platform to the union without
      // adding it here is a type error rather than a runtime one.
      const unreachable: never = spec.platform;
      throw new Error(`No service plan for ${String(unreachable)}.`);
    }
  }
}

/**
 * A systemd user service and timer.
 *
 * `OnUnitActiveSec` rather than `OnCalendar`: the cadence asked for is "every N
 * minutes from whenever the last one ran", and a calendar expression would need
 * rewriting per interval and would drift into firing twice at a boundary.
 *
 * `Persistent=false` is the misfire policy, and it is the important line. With
 * persistence on, a laptop shut for a week would fire every missed occurrence in
 * a burst the moment it woke — which is the opposite of what a schedule means.
 * The scheduler skips stale occurrences itself as a second line, but not asking
 * for them is better than asking and refusing.
 */
function planSystemd(spec: ServiceSpec): ServicePlan {
  const dir = join(spec.configHome, 'systemd', 'user');
  const servicePath = join(dir, `${SERVICE_UNIT}.service`);
  const timerPath = join(dir, `${SERVICE_UNIT}.timer`);

  const environment = runnerEnvironment(spec.userDataDir);
  const service = [
    '[Unit]',
    `Description=${SERVICE_LABEL}`,
    // Started by the timer, never on its own.
    'RefuseManualStart=no',
    '',
    '[Service]',
    'Type=oneshot',
    ...Object.entries(environment).map(
      ([key, value]) => `Environment="${key}=${value}"`,
    ),
    `ExecStart="${spec.execPath}" "${spec.scriptPath}" --json`,
    /*
     * A run still going when the next tick arrives is left alone rather than
     * started twice. The store's claim would make the second run harmless, but
     * two agents on one machine is still two agents dialling the same servers.
     */
    '',
  ].join('\n');

  const timer = [
    '[Unit]',
    `Description=${SERVICE_LABEL}`,
    '',
    '[Timer]',
    // A short grace after boot, so a login storm does not race the first tick.
    'OnBootSec=2min',
    `OnUnitActiveSec=${String(spec.everyMinutes)}min`,
    'AccuracySec=1s',
    'Persistent=false',
    `Unit=${SERVICE_UNIT}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');

  return {
    unit: SERVICE_UNIT,
    definitionPath: timerPath,
    probe: {kind: 'file', path: timerPath},
    files: [
      {path: servicePath, contents: service, mode: 0o644},
      {path: timerPath, contents: timer, mode: 0o644},
    ],
    install: [
      {
        argv: ['systemctl', '--user', 'daemon-reload'],
        what: 'ask systemd to notice the new unit',
      },
      {
        argv: ['systemctl', '--user', 'enable', '--now', `${SERVICE_UNIT}.timer`],
        what: 'start the timer and keep it across logins',
      },
      {
        /*
         * Without linger the user manager stops when the last session ends, so
         * the timer fires while the user is logged in and stops the moment they
         * log out — which is when a background job service is most wanted.
         *
         * Optional because on many systems this needs polkit or root, and the
         * service is otherwise installed and working.
         */
        argv: ['loginctl', 'enable-linger'],
        what: 'let the timer outlive the login session',
        optional: true,
      },
    ],
    remove: [servicePath, timerPath],
    uninstall: [
      {
        argv: ['systemctl', '--user', 'disable', '--now', `${SERVICE_UNIT}.timer`],
        what: 'stop the timer',
      },
      {
        argv: ['systemctl', '--user', 'daemon-reload'],
        what: 'forget the unit',
      },
    ],
  };
}

/**
 * A launchd agent.
 *
 * `StartInterval` is a plain N-second cadence with no calendar arithmetic, which
 * is exactly the request. `RunAtLoad` is false because launching at login and
 * launching on a schedule are different wants, and the schedule is the one that
 * was asked for.
 */
function planLaunchd(spec: ServiceSpec): ServicePlan {
  const dir = join(spec.home, 'Library', 'LaunchAgents');
  const label = `com.marimo.agent.${SERVICE_UNIT}`;
  const path = join(dir, `${label}.plist`);

  const environment = runnerEnvironment(spec.userDataDir);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(spec.execPath)}</string>`,
    `    <string>${escapeXml(spec.scriptPath)}</string>`,
    '    <string>--json</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(environment).flatMap(([key, value]) => [
      `    <key>${key}</key>`,
      `    <string>${escapeXml(value)}</string>`,
    ]),
    '  </dict>',
    '  <key>StartInterval</key>',
    `  <integer>${String(spec.everyMinutes * 60)}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  return {
    unit: label,
    definitionPath: path,
    probe: {kind: 'file', path},
    files: [{path, contents: plist, mode: 0o644}],
    install: [
      {
        /*
         * `bootout` first, ignoring failure: launchd refuses to load a label it
         * already knows, so reinstalling over a previous install would fail
         * without this. An uninstall of something not installed is not an error.
         */
        argv: ['launchctl', 'bootout', `gui/${String(process.getuid?.() ?? 0)}/${label}`],
        what: 'replace any previous version of the agent',
        optional: true,
      },
      {
        argv: ['launchctl', 'bootstrap', `gui/${String(process.getuid?.() ?? 0)}`, path],
        what: 'load the agent',
      },
    ],
    remove: [path],
    uninstall: [
      {
        argv: ['launchctl', 'bootout', `gui/${String(process.getuid?.() ?? 0)}/${label}`],
        what: 'unload the agent',
        optional: true,
      },
    ],
  };
}

/**
 * A Task Scheduler entry.
 *
 * Built as a `/TR` command line rather than the XML form: the XML has to be
 * imported from a file with the right encoding, and getting that wrong fails in
 * a way that is hard to read back. `cmd /c set VAR=… && …` is the portable way to
 * give a scheduled task an environment.
 */
function planScheduledTask(spec: ServiceSpec): ServicePlan {
  const environment = runnerEnvironment(spec.userDataDir);
  const sets = Object.entries(environment)
    .map(([key, value]) => `set "${key}=${value}"`)
    .join(' && ');

  const command = [
    'cmd',
    '/c',
    `${sets} && "${spec.execPath}" "${spec.scriptPath}" --json`,
  ].join(' ');

  return {
    unit: SERVICE_UNIT,
    /*
     * There is no file. Task Scheduler keeps the definition in its own database,
     * and pretending otherwise would make the status check look for something
     * that never exists.
     */
    definitionPath: '',
    probe: {
      kind: 'command',
      argv: ['schtasks', '/Query', '/TN', SERVICE_UNIT],
      what: 'ask Task Scheduler about the task',
    },
    files: [],
    install: [
      {
        argv: [
          'schtasks',
          '/Create',
          // Without /F, creating over an existing task prompts, and a prompt in
          // an installer is a hang.
          '/F',
          '/TN',
          SERVICE_UNIT,
          '/SC',
          'MINUTE',
          '/MO',
          String(spec.everyMinutes),
          '/TR',
          command,
        ],
        what: 'register the scheduled task',
      },
      {
        argv: ['schtasks', '/Run', '/TN', SERVICE_UNIT],
        what: 'run it once, so a mistake shows up now',
        optional: true,
      },
    ],
    remove: [],
    uninstall: [
      {
        argv: ['schtasks', '/Delete', '/F', '/TN', SERVICE_UNIT],
        what: 'remove the scheduled task',
        optional: true,
      },
    ],
  };
}

/** Plist values are XML text, and a path is allowed to contain `&`. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
