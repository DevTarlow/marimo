/**
 * The name the app prints, and the one the folder keeps.
 *
 * Two failures are silent and this file is the only warning for either. If
 * `productName` and `PRODUCT_NAME` part company, the packaged app is called one
 * thing and says another. If `USER_DATA_NAME` is ever tidied up to match the
 * product, the folder moves and every installed copy opens empty — which looks
 * exactly like a fresh install rather than like a mistake.
 *
 * Both names are spelled out below rather than read back out of the constants,
 * because a test that derives its expectation from the value it is checking
 * asserts nothing about the one thing that matters: the string on disk.
 */
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {defaultUserDataDir} from '@marimo/runtime';

import {
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

describe('the product name', () => {
  it('matches package.json, which is what the packaged app is called', async () => {
    const pkg = await manifest();
    expect(pkg['productName']).toBe(PRODUCT_NAME);
  });

  it('is Marimo, while the folder is still the old name', () => {
    expect(PRODUCT_NAME).toBe('Marimo');
    expect(USER_DATA_NAME).toBe('Marimo Agent');
  });

  it('leaves the runner appending the folder name to the platform directory', () => {
    const dir = defaultUserDataDir({
      appName: USER_DATA_NAME,
      platform: 'linux',
      env: {},
      home: '/home/someone',
    });
    // Spelled out on purpose: editing this string moves everybody's data.
    expect(dir).toBe('/home/someone/.config/Marimo Agent');
  });

  it('is decided in one place, for the window and the runner alike', () => {
    // `resolveRunnerPaths` calls this too, so the rule cannot exist twice and
    // drift — a difference that is invisible until a scheduled job never fires.
    expect(userDataDirFor({})).toBe(
      defaultUserDataDir({appName: 'Marimo Agent', env: {}}),
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
