/**
 * Every on-disk location the app owns, resolved from a user-data directory that
 * is handed in rather than read from Electron.
 *
 * This module is deliberately Electron-free, and that is load-bearing rather
 * than tidy. Two very different processes resolve these same paths: the Electron
 * main process, which knows its directory because `app.getPath('userData')`
 * told it, and the headless job runner, which is the same binary running as
 * plain Node and has no `app` at all. Taking the directory as an argument is
 * what lets both share one definition instead of drifting into two layouts that
 * disagree about where a conversation lives.
 */
import {homedir} from 'node:os';
import {join} from 'node:path';

import {PROVIDER_IDS} from '@marimo/protocol';
import type {ProviderId} from '@marimo/protocol';

export interface AppPaths {
  /** The directory everything below lives under. */
  userData: string;
  /** One JSONL file per conversation, plus the index the sidebar reads. */
  sessions: string;
  /** Window geometry, rail widths, theme, and the plain preferences. */
  settings: string;
  /**
   * Secrets, one file each.
   *
   * A directory rather than a single file, because a secret that cannot be
   * cleared without touching another one is a secret nobody dares rotate. Each
   * file records in its own prefix whether it is encrypted or readable on disk,
   * so the choice stays visible to anyone who looks.
   */
  secretsDir: string;
  /** The provider API keys, by provider id. */
  providerSecrets: Record<ProviderId, string>;
  /** Agent profiles: identities and the capabilities they carry. */
  profiles: string;
  /**
   * The folders every agent can work in, and which one is current.
   *
   * Its own document rather than a field on each profile: a folder is a place on
   * the machine, not a fact about which agent is talking.
   */
  workspaces: string;
  /** Scheduled jobs: what to do, when, and which conversation they report into. */
  jobs: string;
  /**
   * The agent's memory suggestions, waiting for the user to agree.
   *
   * A file of its own rather than part of settings: it is neither a preference
   * nor a secret, it is written by a background review rather than by a person,
   * and a document the user never edits should not share a write path with the
   * one holding their API-key configuration.
   */
  memoryProposals: string;
  /**
   * Where a running app says so.
   *
   * The headless runner reads it to answer one question: is the app already
   * running the jobs? It is not what makes a job run once — the store's own
   * claim does that — but it is what stops the runner building an agent, dialling
   * every MCP server and ticking, once a minute, beside an app doing the same.
   */
  appLock: string;
  /** Skills the user wrote, which ride in every request. */
  skills: string;
  /**
   * Where a brand-new profile may work.
   *
   * The home directory rather than a subfolder of it: the agent's file tools are
   * confined to whatever the user picks, and a fresh install has not picked
   * anything yet. Choosing for them — and silently confining them to a folder
   * they have never seen — would be worse than starting somewhere they recognise.
   */
  defaultWorkspace: string;
}

/**
 * Resolves every location from the one directory the caller owns.
 *
 * `userData` is Electron's own name for it and is kept here so a bug report and
 * a Settings screen call the same place the same thing. In the runner the same
 * value arrives from `MARIMO_USER_DATA_DIR` or the platform default.
 */
export function resolveAppPaths(userData: string): AppPaths {
  const secretsDir = join(userData, 'secrets');

  const providerSecrets = {} as Record<ProviderId, string>;
  for (const id of PROVIDER_IDS) {
    providerSecrets[id] = secretFileIn(secretsDir, id);
  }

  return {
    userData,
    sessions: join(userData, 'sessions'),
    settings: join(userData, 'settings.json'),
    secretsDir,
    providerSecrets,
    profiles: join(userData, 'profiles.json'),
    workspaces: join(userData, 'workspaces.json'),
    jobs: join(userData, 'jobs.json'),
    memoryProposals: join(userData, 'memory-proposals.json'),
    appLock: join(userData, 'app.lock'),
    skills: join(userData, 'skills.json'),
    defaultWorkspace: homedir(),
  };
}

/**
 * Where Electron would put this app's user data, worked out rather than asked.
 *
 * The app does not need this — it has `app.getPath('userData')`. The headless
 * job runner does, and it is the same binary running as plain Node with no
 * `app` object at all, so it has to derive the path from the platform's own
 * rules. Getting this wrong is one of the quieter possible bugs: the runner
 * would read a *different* `jobs.json` from the one the window writes, find
 * nothing due, and exit 0 — a background service that looks healthy and never
 * does anything.
 *
 * Electron's rule, which this mirrors, is the platform's application-data
 * directory with the app's name appended:
 *
 * - Linux — `$XDG_CONFIG_HOME` or `~/.config`
 * - macOS — `~/Library/Application Support`
 * - Windows — `%APPDATA%`, which is the roaming profile
 *
 * The `MARIMO_USER_DATA_DIR` override is applied by the caller rather than here,
 * because Electron has to apply it before its single-instance lock is taken and
 * this function has no opinion about when it runs.
 */
export function defaultUserDataDir(options: {
  /** The name in `productName`, which is what Electron appends. */
  appName: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', options.appName);
  }

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    // A Windows process without APPDATA is unusual but possible in a service
    // context; falling back to the profile directory beats returning a relative
    // path that would resolve against whatever the working directory happens to
    // be.
    return join(appData && appData.length > 0 ? appData : home, options.appName);
  }

  const configHome = env['XDG_CONFIG_HOME'];
  const base =
    configHome && configHome.length > 0 ? configHome : join(home, '.config');
  return join(base, options.appName);
}

/**
 * The file holding one non-provider secret, such as a connector token.
 *
 * A function rather than a pre-computed map because connector identifiers are
 * user-supplied (`mcp:notes`, `discord`), so the set is not knowable at startup.
 */
export function secretFile(paths: AppPaths, name: string): string {
  return secretFileIn(paths.secretsDir, name);
}

/**
 * A secret name turned into a file name that cannot leave the secrets directory.
 *
 * Connector names reach this from a Settings field, which makes them the one
 * piece of this path a user types. Everything outside `[a-z0-9._-]` becomes `-`,
 * which folds `/`, `\` and a leading `..` into a name that stays put; the result
 * can only be a single path segment, so `secretFile(paths, '../../etc/passwd')`
 * lands inside `secretsDir` like any other name.
 *
 * Empty after sanitising (a name made entirely of slashes, say) falls back to
 * `secret`, so a malformed name still yields a real file instead of a directory.
 */
export function secretFileName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 80);
  return `${safe.length > 0 ? safe : 'secret'}.bin`;
}

function secretFileIn(directory: string, name: string): string {
  return join(directory, secretFileName(name));
}
