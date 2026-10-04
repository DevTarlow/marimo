#!/usr/bin/env node
/**
 * The smoke check: does the app actually open, and does the window actually
 * work?
 *
 * It launches a real Electron window against a throwaway user-data directory,
 * attaches to it over the DevTools protocol, and asks the renderer to prove
 * itself: that the preload bridge is there, that it can answer a call, and that
 * the React tree mounted. Then it takes a picture, because "the DOM says it
 * rendered" and "it rendered" are different claims and only one of them is worth
 * anything.
 *
 * Three things about how it is built are deliberate:
 *
 * - **It measures the real thing.** The checks run inside the packaged renderer
 *   over the same IPC path the app uses, not against a mocked bridge, so a
 *   preload that was never rebuilt fails here.
 * - **It has no dependencies.** Node 22 ships a WebSocket client, so the
 *   DevTools protocol is spoken directly rather than through puppeteer — one
 *   less package to keep current for a check that must not itself rot.
 * - **It never touches real state.** `MARIMO_USER_DATA_DIR` points at a fresh
 *   temporary directory, which is also what keeps it from fighting a running
 *   copy of the app for the single-instance lock.
 *
 * Usage:
 *   node scripts/smoke.mjs [--shot <file.png>]
 *
 * `MARIMO_NO_SANDBOX=1` adds `--no-sandbox`, which is needed in a container
 * where `chrome-sandbox` cannot be setuid-root. It is opt-in because it is a
 * real reduction in isolation and must not be what a normal run quietly gets.
 */
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electron = join(appRoot, 'node_modules', '.bin', 'electron');

/** A port nothing else is likely to want, overridable for a busy machine. */
const DEBUG_PORT = Number(process.env['MARIMO_DEBUG_PORT'] ?? 9317);
const DEADLINE_MS = Number(process.env['MARIMO_SMOKE_TIMEOUT'] ?? 45_000);

const shotIndex = process.argv.indexOf('--shot');
const shotFile = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined;

/**
 * `--theme light|dark` clicks the switch before capturing.
 *
 * Both token blocks have to be looked at. A token declared in one and missed in
 * the other is not a styling bug that shows up as "slightly off" — it is a
 * component that renders invisibly in one mode, which is a bug exactly half the
 * users would have and nobody would report clearly.
 */
const themeIndex = process.argv.indexOf('--theme');
const wantedTheme = themeIndex >= 0 ? process.argv[themeIndex + 1] : undefined;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

/** Waits for something, or gives up. */
async function until(what, attempt, {everyMs = 250, withinMs = DEADLINE_MS} = {}) {
  const deadline = Date.now() + withinMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await attempt();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

async function main() {
  const userData = await mkdtemp(join(tmpdir(), 'marimo-smoke-'));
  const args = [appRoot, `--remote-debugging-port=${DEBUG_PORT}`];
  if (process.env['MARIMO_NO_SANDBOX'] === '1') {
    args.push('--no-sandbox');
  }

  const child = spawn(electron, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, MARIMO_USER_DATA_DIR: userData},
  });

  const log = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => log.push(chunk));
  }

  let socket;
  try {
    /*
     * `/json/list` answers only once the first page exists, so this doubles as
     * "the window was created" — there is nothing to attach to before that.
     */
    const page = await until('the window to appear', async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      return targets.find((entry) => entry.type === 'page');
    });

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', () => {
        reject(new Error('could not attach to the window'));
      }, {once: true});
    });

    const send = await attach(socket);

    const probe = await until('the renderer to mount', async () => {
      const {result} = await send('Runtime.evaluate', {
        expression: PROBE,
        awaitPromise: true,
        returnByValue: true,
      });
      const value = result?.value;
      return value?.mounted === true ? value : undefined;
    });

    ok(`the window opened (${probe.title})`);
    ok(`the preload bridge answered: ${probe.product} ${probe.version}`);
    ok(`the renderer mounted with ${probe.rootChildren} child element(s)`);

    if (probe.theme !== 'dark' && probe.theme !== 'light') {
      fail(`the theme attribute is "${probe.theme}", not light or dark`);
    } else {
      ok(`the theme resolved to ${probe.theme}`);
    }

    if (probe.userData !== userData) {
      fail(
        `the app is using ${probe.userData} but the check gave it ${userData} — ` +
          'the isolated directory did not take effect',
      );
    } else {
      ok('the app honoured the throwaway user-data directory');
    }

    if (wantedTheme !== undefined) {
      const clicked = await send('Runtime.evaluate', {
        expression: `(() => {
          const wanted = ${JSON.stringify(wantedTheme)};
          const button = [...document.querySelectorAll('.shell-theme-btn')]
            .find((entry) => entry.textContent.trim().toLowerCase() === wanted);
          if (button === undefined) return false;
          button.click();
          return true;
        })()`,
        returnByValue: true,
      });

      if (clicked.result?.value !== true) {
        fail(`there is no "${wantedTheme}" control to switch to`);
      } else {
        await until(`the theme to become ${wantedTheme}`, async () => {
          const {result} = await send('Runtime.evaluate', {
            expression: 'document.documentElement.dataset.theme',
            returnByValue: true,
          });
          return result?.value === wantedTheme ? true : undefined;
        });
        ok(`switched to the ${wantedTheme} theme`);
      }
    }

    if (shotFile !== undefined) {
      /*
       * A screenshot is a bonus, not the assertion. It needs a compositor that
       * can hand back a frame, which a headless or GPU-less machine may refuse —
       * `webContents.capturePage` does exactly that — and failing to take a
       * picture is not evidence that the window is broken.
       */
      try {
        const {data} = await send('Page.captureScreenshot', {format: 'png'});
        await writeFile(shotFile, Buffer.from(data, 'base64'));
        ok(`wrote a screenshot to ${shotFile}`);
      } catch (error) {
        console.warn(`! could not take a screenshot: ${error.message}`);
      }
    }
  } catch (error) {
    fail(error.message);
    const output = log.join('').trim();
    if (output.length > 0) {
      console.error('\n--- app output ---\n' + output.slice(-4_000));
    }
  } finally {
    socket?.close();
    child.kill('SIGTERM');
    // Give it a moment to release the user-data directory, then insist.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await rm(userData, {recursive: true, force: true});
  }
}

/**
 * Wraps the socket in a request/response `send`.
 *
 * DevTools has no correlation beyond the id the client invents, so the pending
 * map is the whole of the protocol handling this check needs.
 */
async function attach(socket) {
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message));
    } else {
      entry.resolve(message.result);
    }
  });

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`${method} did not answer within 10s`));
        }
      }, 10_000);
    });
}

/**
 * Runs inside the page, over the same bridge the app uses.
 *
 * `mounted` is the gate: it is only true once the bridge answered *and* React
 * rendered. Anything else is a partial start that would otherwise pass.
 */
const PROBE = `(async () => {
  const result = {
    hasBridge: typeof window.marimo === 'object' && window.marimo !== null,
    mounted: false,
    title: document.title,
    theme: document.documentElement.dataset.theme ?? null,
    rootChildren: document.getElementById('root')?.childElementCount ?? 0,
  };
  if (!result.hasBridge) {
    return result;
  }
  try {
    const info = await window.marimo.call('app.info', {});
    result.product = info.name;
    result.version = info.version;
    result.userData = info.userData;
    result.secretsEncrypted = info.secretsEncrypted;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    return result;
  }
  result.mounted = result.rootChildren > 0;
  return result;
})()`;

await main();
