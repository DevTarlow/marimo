#!/usr/bin/env node
/**
 * Puts a model in the cache for a development checkout.
 *
 * This used to be the *only* way the model got anywhere: it ran at package time,
 * downloaded 1.1 GB, and copied it into the installer's resources so the app worked
 * offline out of the box. The app downloads its own model now, on a user's first
 * run, so this is a convenience for working on the code — and it is deliberately
 * thin, because the interesting logic moved into `@marimo/runtime` where both
 * processes use it.
 *
 * What is left here is the two things the app cannot do for a checkout: choose a
 * directory inside the repository rather than in user data, and print the
 * `MARIMO_MODEL_DIR` line to paste into a dev run.
 *
 * Usage:
 *   node scripts/local-model.mjs fetch [low|high]   # default: low
 *   node scripts/local-model.mjs verify
 *   node scripts/local-model.mjs where
 *
 * Needs `@marimo/runtime` built — `pnpm build` — because it imports the same
 * downloader the app runs. That is the point: one implementation, so a digest
 * check that works here works there.
 */
import {join, resolve} from 'node:path';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let runtime;
try {
  runtime = await import('@marimo/runtime');
} catch (failure) {
  console.error(
    `✗ Could not load @marimo/runtime: ${failure.message}\n` +
      '  Run `pnpm build` first — this script uses the app\'s own downloader.',
  );
  process.exit(1);
}

const {
  engineAssetFor,
  engineIsPinned,
  installEngine,
  installedTiers,
  installTier,
  MODEL_PINS,
  modelDir,
  resolveLocalModelFiles,
} = runtime;

/** Where a checkout keeps the model: gitignored, and cached between builds. */
const dir = join(appRoot, '.model-cache', 'local-model');

function report(progress) {
  if (progress.percent === undefined) {
    return;
  }
  // Every ten percent: a line per percent buries everything else.
  if (progress.percent % 10 === 0) {
    console.log(`    ${String(progress.percent)}%`);
  }
}

async function fetchOne(tier) {
  const key = `${process.platform}-${process.arch}`;
  const found = engineAssetFor(MODEL_PINS);
  if (found === undefined) {
    console.error(`✗ There is no engine build pinned for ${key}.`);
    process.exit(1);
  }

  console.log(`Fetching the model for ${key} into ${dir}`);
  const engine = await installEngine({
    dir,
    manifest: MODEL_PINS,
    onProgress: report,
  });
  console.log(engine.installed ? '  engine: unpacked' : '  engine: already here');

  const weights = await installTier({dir, manifest: MODEL_PINS, tier, onProgress: report});
  const descriptor = MODEL_PINS.weights.tiers[tier];
  console.log(
    weights.installed
      ? `  ${descriptor.label}: downloaded ${descriptor.file}`
      : `  ${descriptor.label}: already here`,
  );

  console.log(
    `\nThe model is ready. A development run points at it with:\n` +
      `  MARIMO_MODEL_DIR=${dir} pnpm --filter @marimo/desktop dev`,
  );
}

async function verify() {
  const found = engineAssetFor(MODEL_PINS);
  const problems = [];

  if (found === undefined) {
    problems.push(`no engine build is pinned for ${process.platform}-${process.arch}`);
  } else if (!(await engineIsPinned(dir, found.asset))) {
    problems.push(`the engine is missing or is not ${found.asset.file}`);
  }

  const tiers = installedTiers({dir, manifest: MODEL_PINS});
  if (tiers.length === 0) {
    problems.push('no tier\'s weights are complete in the cache');
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`✓ ${tiers.join(' and ')} in place at ${dir}`);
}

const command = process.argv[2] ?? 'fetch';
const tier = process.argv[3] ?? 'low';

try {
  if (command === 'fetch') {
    if (tier !== 'low' && tier !== 'high') {
      console.error(`✗ Unknown tier "${tier}". Use low or high.`);
      process.exitCode = 2;
    } else {
      await fetchOne(tier);
    }
  } else if (command === 'verify') {
    await verify();
  } else if (command === 'where') {
    console.log(await mkdir(dir, {recursive: true}).then(() => resolve(dir)));
  } else {
    console.error(`Unknown command "${command}". Use fetch, verify or where.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
