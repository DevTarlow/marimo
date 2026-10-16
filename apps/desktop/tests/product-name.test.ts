/**
 * The name the app prints, and the name of the folder it keeps everything in.
 *
 * Two failures are silent and this file is the only warning for either. If
 * `productName` and `PRODUCT_NAME` part company, the packaged app is called one
 * thing and says another. And the folder is not the product's name to change
 * whenever the product's is: it was `Marimo Agent` for the whole life of the app
 * called Marimo, so moving it to `Marimo Bot` is a migration, and an install that
 * misses that migration opens empty — which looks exactly like a fresh install
 * rather than like a mistake.
 *
 * Both names are spelled out below rather than read back out of the constants,
 * because a test that derives its expectation from the value it is checking
 * asserts nothing about the one thing that matters: the string on disk.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';

import {afterEach, describe, expect, it} from 'vitest';

import {defaultUserDataDir} from '@marimo/runtime';

import {
  adoptFormerUserDataDir,
  FORMER_USER_DATA_NAME,
  formerUserDataDirFor,
  PRODUCT_NAME,
  USER_DATA_ENV,
  USER_DATA_NAME,
  userDataDirFor,
} from '../src/shared/product.js';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function manifest(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(appRoot, 'package.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

/*
 * A throwaway application-data root, so the move is watched somewhere it may
 * happen. Under the working directory rather than `/tmp`, because a sandbox that
 * only permits writes inside the repository still runs these.
 */
const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(process.cwd(), '.marimo-product-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, {recursive: true, force: true});
  }
});

describe('the product name', () => {
  it('matches package.json, which is what the packaged app is called', async () => {
    const pkg = await manifest();
    expect(pkg['productName']).toBe(PRODUCT_NAME);
  });

  it('is Marimo Bot, and so is the folder it keeps everything in', () => {
    expect(PRODUCT_NAME).toBe('Marimo Bot');
    expect(USER_DATA_NAME).toBe('Marimo Bot');
  });

  it('remembers what the folder was called, because installs still use it', () => {
    // The whole reason the migration exists. Deleting this constant would strand
    // every copy installed under the old name, and the failure would look like a
    // fresh install rather than like a deleted string.
    expect(FORMER_USER_DATA_NAME).toBe('Marimo Agent');
  });

  it('leaves the runner appending the folder name to the platform directory', () => {
    const dir = defaultUserDataDir({
      appName: USER_DATA_NAME,
      platform: 'linux',
      env: {},
      home: '/home/someone',
    });
    // Spelled out on purpose: editing this string moves everybody's data.
    expect(dir).toBe('/home/someone/.config/Marimo Bot');
  });

  it('is decided in one place, for the window and the runner alike', () => {
    // `resolveRunnerPaths` calls this too, so the rule cannot exist twice and
    // drift — a difference that is invisible until a scheduled job never fires.
    expect(userDataDirFor({})).toBe(
      defaultUserDataDir({appName: 'Marimo Bot', env: {}}),
    );
  });

  it('gives the override the last word, as both processes read it', () => {
    expect(userDataDirFor({[USER_DATA_ENV]: '/tmp/elsewhere'})).toBe(
      '/tmp/elsewhere',
    );
  });

  it('is named by the variable the app and the runner both read', () => {
    expect(USER_DATA_ENV).toBe('MARIMO_USER_DATA_DIR');
  });

  it('is a usable directory name', () => {
    // It becomes a directory name, so a slash in it would silently create an
    // extra level that the app and the runner would both have to agree about.
    expect(USER_DATA_NAME).not.toMatch(/[/\\]/u);
    expect(PRODUCT_NAME.length).toBeGreaterThan(0);
  });
});

describe('adopting the folder an install was already using', () => {
  it('moves the old folder to the new name, contents and all', () => {
    const root = tempRoot();
    const former = formerUserDataDirFor({}, root);
    const current = userDataDirFor({}, root);

    mkdirSync(join(former, 'memory'), {recursive: true});
    writeFileSync(join(former, 'jobs.json'), '{"jobs":[]}');

    adoptFormerUserDataDir({}, root);

    expect(existsSync(former)).toBe(false);
    expect(existsSync(join(current, 'jobs.json'))).toBe(true);
    expect(existsSync(join(current, 'memory'))).toBe(true);
  });

  it('is a no-op the second time, so neither process can undo the other', () => {
    const root = tempRoot();
    const former = formerUserDataDirFor({}, root);
    const current = userDataDirFor({}, root);

    mkdirSync(former, {recursive: true});
    writeFileSync(join(former, 'memory.md'), 'kept');
    adoptFormerUserDataDir({}, root);

    // A stamp the migration must not overwrite by moving the new folder back to
    // the old name, which is what a migration that did not check would do.
    writeFileSync(join(current, 'written-afterwards'), 'yes');
    adoptFormerUserDataDir({}, root);

    expect(existsSync(join(current, 'written-afterwards'))).toBe(true);
    expect(existsSync(join(current, 'memory.md'))).toBe(true);
    expect(existsSync(former)).toBe(false);
  });

  it('leaves a fresh install alone', () => {
    const root = tempRoot();
    adoptFormerUserDataDir({}, root);
    // Neither folder is created: the app makes the one it wants, and a migration
    // that created the old name would be a migration that made work for itself.
    expect(existsSync(formerUserDataDirFor({}, root))).toBe(false);
    expect(existsSync(userDataDirFor({}, root))).toBe(false);
  });

  it('does not move anything when the override names the directory', () => {
    const root = tempRoot();
    const former = formerUserDataDirFor({}, root);
    mkdirSync(former, {recursive: true});

    adoptFormerUserDataDir({[USER_DATA_ENV]: '/tmp/elsewhere'}, root);

    // An explicit directory is an explicit choice, and the app must not tidy it.
    expect(existsSync(former)).toBe(true);
  });
});

describe('a job definition written before the rename', () => {
  /*
   * `runnerEnvironment` bakes the user-data directory into the systemd unit, and
   * a rename cannot reach into a unit that is already on disk. Left unhandled,
   * the timer wakes up pointing at a directory that no longer exists: the runner
   * reads nothing, finds nothing due, and exits 0 — invariant 13's silent
   * failure, arriving through the back door.
   */
  it('is read as the folder that moved, not as one that is missing', () => {
    const root = tempRoot();
    const former = formerUserDataDirFor({}, root);
    const current = userDataDirFor({}, root);

    mkdirSync(former, {recursive: true});
    adoptFormerUserDataDir({}, root);

    expect(userDataDirFor({[USER_DATA_ENV]: former}, root)).toBe(current);
  });

  it('still wins while the folder it names is really there', () => {
    const root = tempRoot();
    const former = formerUserDataDirFor({}, root);
    mkdirSync(former, {recursive: true});
    mkdirSync(userDataDirFor({}, root), {recursive: true});

    // Both exist, so the override is somebody's actual answer rather than a
    // leftover — a dev run pointed at the old folder by hand, say.
    expect(userDataDirFor({[USER_DATA_ENV]: former}, root)).toBe(former);
  });

  it('does not capture an override that names somewhere else entirely', () => {
    const root = tempRoot();
    expect(userDataDirFor({[USER_DATA_ENV]: '/tmp/elsewhere'}, root)).toBe(
      '/tmp/elsewhere',
    );
  });
});
