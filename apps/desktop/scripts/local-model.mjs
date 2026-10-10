#!/usr/bin/env node
/**
 * Fetches the model the app carries: the engine, and the weights.
 *
 * Run at package time rather than on a user's first launch. That is the whole
 * choice this file exists to serve: an installer with the model inside it works
 * offline, on a machine behind a proxy, and for somebody who never opens a
 * browser to go and find one — and the cost, which is a build step that needs
 * 1.1 GB of network once, is paid here rather than in the first two minutes of
 * a new user's first conversation.
 *
 * Three things are pinned and checked, because a downloaded binary that is
 * quietly not the one that was tested is the sort of thing that only shows up as
 * "the app is broken on some machines":
 *
 * - the llama.cpp release **tag**, and the sha256 of each platform's archive;
 * - the Hugging Face repo **revision**, so the weights cannot change under a
 *   mutable branch name;
 * - the sha256 of the weights themselves.
 *
 * `apps/desktop/local-model.json` is where all of that lives, as data.
 *
 * Usage:
 *   node scripts/local-model.mjs fetch    # download, verify, unpack
 *   node scripts/local-model.mjs verify   # check the cache, download nothing
 *   node scripts/local-model.mjs where    # print the directory, for MARIMO_MODEL_DIR
 *
 * `MARIMO_SKIP_MODEL=1` makes `fetch` a no-op that still creates the directory,
 * which is what CI uses: the workflow proves the app packages and the runner
 * starts, and a gigabyte of weights is not part of that claim.
 */
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {
  cp,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pins = JSON.parse(
  await readFile(join(appRoot, 'local-model.json'), 'utf8'),
);

/** Where everything lands. Gitignored, and cached between builds. */
const cacheDir = join(appRoot, '.model-cache');
const outDir = join(cacheDir, 'local-model');
const engineDir = join(outDir, 'engine');

/** The platform key the pins use, which is Node's own pair with a dash. */
function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function assetFor(key) {
  const asset = pins.engine.assets[key];
  if (asset === undefined) {
    throw new Error(
      `There is no llama.cpp build pinned for ${key}. The platforms that are ` +
        `pinned are: ${Object.keys(pins.engine.assets).join(', ')}. Add one to ` +
        'local-model.json, or package on a platform that has one.',
    );
  }
  return asset;
}

function engineUrl(asset) {
  return `${pins.engine.baseUrl}/${pins.engine.tag}/${asset.file}`;
}

function modelUrl() {
  return (
    `https://huggingface.co/${pins.model.repo}/resolve/` +
    `${pins.model.revision}/${pins.model.file}`
  );
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

/**
 * Downloads a file unless the copy already there is the pinned one.
 *
 * The skip is by digest rather than by presence: a half-written download from an
 * interrupted build is exactly the file that would otherwise be reused forever,
 * and the failure it produces is an engine that cannot start.
 */
async function download(url, destination, expected, label) {
  if ((await sha256(destination).catch(() => '')) === expected) {
    console.log(`  ${label}: already here`);
    return;
  }

  const temporary = `${destination}.part`;
  console.log(`  ${label}: downloading ${url}`);
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok) {
    throw new Error(`${label}: ${url} answered ${String(response.status)}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let written = 0;
  let shown = 0;
  const body = new TransformStream({
    transform(chunk, controller) {
      written += chunk.byteLength;
      const percent = total === 0 ? 0 : Math.floor((written / total) * 100);
      // Every ten percent: a line per chunk would bury the rest of the output.
      if (percent >= shown + 10) {
        shown = Math.floor(percent / 10) * 10;
        console.log(
          `    ${String(shown)}% of ${total === 0 ? '?' : formatBytes(total)}`,
        );
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(response.body.pipeThrough(body), createWriteStream(temporary));

  const actual = await sha256(temporary);
  if (actual !== expected) {
    await rm(temporary, {force: true});
    throw new Error(
      `${label}: the download does not match the pinned digest.\n` +
        `  expected ${expected}\n  got      ${actual}\n` +
        'Refusing to install it. Check local-model.json against the release page.',
    );
  }
  await rm(destination, {force: true});
  await cp(temporary, destination);
  await rm(temporary, {force: true});
  console.log(`  ${label}: verified ${formatBytes(await sizeOf(destination))}`);
}

/**
 * Unpacks one archive and puts the engine where the app looks for it.
 *
 * The archives differ between platforms — tar.gz for Linux and macOS, zip for
 * Windows — and each may or may not wrap its contents in a version directory.
 * Rather than encode that, the archive is unpacked into a scratch directory and
 * the binary is found; whatever sits beside it (the shared libraries) is what
 * gets moved, because that is what the engine needs at run time.
 */
async function unpackEngine(archive, key) {
  const scratch = join(cacheDir, 'unpack');
  await rm(scratch, {recursive: true, force: true});
  await mkdir(scratch, {recursive: true});

  try {
    await run('tar', ['-xf', archive, '-C', scratch]);
  } catch (failure) {
    // GNU tar does not read zip, and the Windows archive is one. `unzip` may not
    // be installed at all, in which case the failure above is the useful one.
    try {
      await run('unzip', ['-o', '-q', archive, '-d', scratch]);
    } catch {
      throw new Error(
        `Could not unpack ${archive}: ${failure.message}\n` +
          'Install `tar` (which reads zip on Windows and macOS) or `unzip`.',
      );
    }
  }

  const binary = key.startsWith('win32') ? 'llama-server.exe' : 'llama-server';
  const found = await findFile(scratch, binary);
  if (found === undefined) {
    throw new Error(`${archive} does not contain ${binary}.`);
  }

  await rm(engineDir, {recursive: true, force: true});
  await mkdir(engineDir, {recursive: true});
  /*
   * The whole directory the binary lives in: it carries the shared libraries,
   * and the released builds expect to be run from beside them.
   *
   * `verbatimSymlinks` is load-bearing and was learned the hard way. The archive
   * links its libraries with *relative* names — `libllama-common.so.0` →
   * `libllama-common.so.0.6.0` — and Node's `cp` resolves a relative link into
   * an absolute one unless told not to. The copy then points back at the scratch
   * directory, which is deleted a line later, and the engine fails at run time
   * with "error while loading shared libraries" while every file it names is
   * visibly present.
   */
  await cp(dirname(found), engineDir, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await rm(scratch, {recursive: true, force: true});
  console.log(`  engine: unpacked to ${engineDir}`);
}

/**
 * Puts the verified download where the app looks, without a second copy of it.
 *
 * A hard link, because the cache and the packaged directory are the same file on
 * the same disk: the cache is what makes a rebuild free, and the packaged copy is
 * what `electron-builder` picks up, and there is no reason for 1.1 GB to be
 * stored twice to serve both. Falls back to a copy on a filesystem that will not
 * link — a cache on another mount, which costs disk and nothing else.
 */
async function place(source, destination) {
  await rm(destination, {force: true});
  try {
    await link(source, destination);
  } catch {
    await cp(source, destination);
  }
}

async function findFile(root, name) {
  const entries = await readdir(root, {withFileTypes: true});
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found !== undefined) {
        return found;
      }
    } else if (entry.name === name) {
      return path;
    }
  }
  return undefined;
}

async function fetchAll() {
  await mkdir(outDir, {recursive: true});

  if (process.env['MARIMO_SKIP_MODEL'] === '1') {
    console.log(
      'MARIMO_SKIP_MODEL=1: packaging without the model. The app reports it as ' +
        'not installed, which is a state it has to handle anyway.',
    );
    return;
  }

  const key = platformKey();
  const asset = assetFor(key);
  const engineArchive = join(cacheDir, asset.file);

  console.log(`Fetching the built-in model for ${key}`);
  await download(engineUrl(asset), engineArchive, asset.sha256, 'engine');

  const weights = join(cacheDir, pins.model.file);
  await download(modelUrl(), weights, pins.model.sha256, 'weights');

  await unpackEngine(engineArchive, key);
  await place(weights, join(outDir, pins.model.file));

  const total =
    (await sizeOf(join(outDir, pins.model.file))) + (await dirSize(engineDir));
  console.log(
    `\nThe model is ready in ${outDir} (${formatBytes(total)}).\n` +
      `A development run points at it with:\n` +
      `  MARIMO_MODEL_DIR=${outDir} pnpm --filter @marimo/desktop dev`,
  );
}

async function verify() {
  const key = platformKey();
  const problems = [];

  const engineBinary = join(
    engineDir,
    key.startsWith('win32') ? 'llama-server.exe' : 'llama-server',
  );
  if ((await sizeOf(engineBinary)) < 0) {
    problems.push(`the engine is missing: ${engineBinary}`);
  }
  const weights = join(outDir, pins.model.file);
  if ((await sizeOf(weights)) !== pins.model.bytes) {
    problems.push(
      `the weights are missing or the wrong size: ${weights} (expected ` +
        `${String(pins.model.bytes)} bytes)`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`✓ the model is in place at ${outDir}`);
}

async function dirSize(dir) {
  let total = 0;
  const walk = async (path) => {
    for (const entry of await readdir(path, {withFileTypes: true})) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        total += await sizeOf(child);
      }
    }
  };
  await walk(dir).catch(() => undefined);
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const command = process.argv[2] ?? 'fetch';

try {
  if (command === 'fetch') {
    await fetchAll();
  } else if (command === 'verify') {
    await verify();
  } else if (command === 'where') {
    // What a development run sets MARIMO_MODEL_DIR to, and what the README says.
    console.log(
      await mkdir(outDir, {recursive: true}).then(() => resolve(outDir)),
    );
  } else {
    console.error(`Unknown command "${command}". Use fetch, verify or where.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
