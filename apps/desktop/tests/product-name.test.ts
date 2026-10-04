/**
 * The product name is the same in every place that spells it.
 *
 * Electron derives the user-data directory from `productName` in
 * `package.json`; the headless runner has no `app` object and derives the same
 * directory from `PRODUCT_NAME`. Nothing fails when these disagree — the window
 * writes one `jobs.json`, the background service reads another, finds nothing
 * due, and exits 0 — so a test is the only warning anyone would get.
 */
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {defaultUserDataDir} from '@marimo/runtime';

import {PRODUCT_NAME, USER_DATA_ENV} from '../src/shared/product.js';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function manifest(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(appRoot, 'package.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('the product name', () => {
  it('matches package.json, which is what Electron appends', async () => {
    const pkg = await manifest();
    expect(pkg['productName']).toBe(PRODUCT_NAME);
  });

  it('is what the runner appends to the platform config directory', () => {
    const dir = defaultUserDataDir({
      appName: PRODUCT_NAME,
      platform: 'linux',
      env: {},
      home: '/home/someone',
    });
    expect(dir).toBe(`/home/someone/.config/${PRODUCT_NAME}`);
  });

  it('is named by the variable the app and the runner both read', () => {
    expect(USER_DATA_ENV).toBe('MARIMO_USER_DATA_DIR');
  });

  it('does not contain a path separator', () => {
    // It becomes a directory name, so a slash in it would silently create an
    // extra level that the app and the runner would both have to agree about.
    expect(PRODUCT_NAME).not.toMatch(/[/\\]/u);
  });
});
