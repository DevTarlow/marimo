/**
 * The directory the window pins itself to, and the check that the runner agrees.
 *
 * This exists because the app is Marimo Bot and its folder is `Marimo Bot`. Left
 * to Electron's own derivation the window would create a second, empty
 * directory beside the one holding everybody's conversations — and nothing about
 * that errors. One process writes `jobs.json`, the other reads a different file,
 * finds nothing due, and exits 0. So both halves are asserted here: that the
 * directory is created and handed to Electron, and that a disagreement with the
 * runner's rule is reported rather than shrugged at.
 */
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const captured = vi.hoisted(() => ({
  set: [] as {name: string; value: string}[],
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? captured.userData : ''),
    setPath: (name: string, value: string) => {
      captured.set.push({name, value});
      captured.userData = value;
    },
  },
}));

import {applyUserDataPath, userDataDisagreement} from '../src/main/paths.js';
import {USER_DATA_ENV, userDataDirFor} from '../src/shared/product.js';

/** Roots made here, so the workspace is as clean after the run as before it. */
const roots: string[] = [];

beforeEach(() => {
  captured.set.length = 0;
  captured.userData = '';
  delete process.env[USER_DATA_ENV];
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, {recursive: true, force: true});
  }
});

describe('pinning the user-data directory', () => {
  it('creates the directory and hands it to Electron', () => {
    /*
     * A path that does not exist yet, which is the fresh-install case and the
     * one Electron would refuse: `setPath` throws for a directory that is not
     * there, so the creation is the load-bearing half.
     */
    const root = mkdtempSync(join(process.cwd(), '.marimo-paths-'));
    roots.push(root);
    const dir = join(root, 'Marimo Bot');

    applyUserDataPath(dir);

    expect(existsSync(dir)).toBe(true);
    expect(captured.set).toEqual([{name: 'userData', value: dir}]);
  });
});

describe('the disagreement between the window and the runner', () => {
  it('says nothing when the two agree', () => {
    captured.userData = userDataDirFor();
    expect(userDataDisagreement()).toBeUndefined();
  });

  it('names both directories when they do not', () => {
    const elsewhere = join(tmpdir(), 'marimo-elsewhere');
    captured.userData = elsewhere;

    const complaint = userDataDisagreement();

    expect(complaint).toContain(elsewhere);
    expect(complaint).toContain(userDataDirFor());
  });
});
