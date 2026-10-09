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
 * And it puts the app away again before it exits, on every path out, including a
 * Ctrl-C: this opens a real window on whatever display the check is running on,
 * and an agent left sitting in somebody's tray afterwards is a mess they have to
 * clean up rather than a result. `app-process.mjs` is where that lives, and why
 * it means the process group rather than the pid.
 *
 * Usage:
 *   node scripts/smoke.mjs [--shot <file.png>]
 *
 * `MARIMO_NO_SANDBOX=1` adds `--no-sandbox`, which is needed in a container
 * where `chrome-sandbox` cannot be setuid-root. It is opt-in because it is a
 * real reduction in isolation and must not be what a normal run quietly gets.
 */
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {startApp, stopApp} from './app-process.mjs';

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

  const child = startApp({
    command: electron,
    args,
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
      /*
       * The main window by name, not the first page. There are two windows now —
       * the app and the floating pet — and "the first page" is whichever the
       * debugger happened to list first, which changes with the order they open
       * in. Picking the wrong one made this check fail on a build that was fine.
       */
      return targets.find(
        (entry) => entry.type === 'page' && entry.url.includes('index.html'),
      );
    });

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', () => {
        reject(new Error('could not attach to the window'));
      }, {once: true});
    });

    const {send, console: pageConsole} = await attach(socket);

    /**
     * An expression in the window, answered as a value.
     *
     * Every DOM assertion below is this, so that the checks read as what they
     * are asking rather than as DevTools protocol plumbing.
     */
    const evaluate = async (expression) => {
      const {result} = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result?.value;
    };

    /**
     * Reloads the window and waits for the *new* document.
     *
     * A reload is not instant, and the document being replaced answers every
     * question just as well — so a marker set before it is what says which
     * window is on screen. Without one, a check can pass against the window it
     * was about to replace, which is exactly the state a stale bundle looks
     * healthy in.
     */
    const reload = async () => {
      await evaluate(`window.__smokeReload = true`);
      await send('Page.reload', {});
      await until('the window to come back', async () =>
        (await evaluate(`window.__smokeReload === true`)) === false
          ? true
          : undefined,
      );
    };

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

    /*
     * The agent's own spine. A preload that loads proves nothing about whether
     * the runtime, the stores and the IPC handlers behind it are connected —
     * these three calls are what prove it.
     */
    if (typeof probe.profileCount !== 'number' || probe.profileCount < 1) {
      fail('the app has no agent profiles, so the agent did not start');
    } else {
      ok(`the agent is running with ${probe.profileCount} profile(s)`);
    }

    if (typeof probe.sessionId !== 'string' || probe.sessionId.length === 0) {
      fail('a conversation could not be started');
    } else {
      ok(`a conversation was created (${probe.sessionId})`);
    }

    /*
     * At least one, not exactly one: the window opens a conversation of its own
     * on first paint, so by the time this check runs there are usually two. What
     * is being asserted is that a conversation this probe created is *listed* —
     * which is what proves the store, the index and the IPC path agree.
     */
    if (
      typeof probe.sessionCount !== 'number' ||
      probe.sessionCount < 1 ||
      !Array.isArray(probe.listedIds) ||
      !probe.listedIds.includes(probe.sessionId)
    ) {
      fail(
        `the conversation just created was not listed (${probe.sessionCount} listed)`,
      );
    } else {
      ok('the conversation was listed and read back');
    }

    /*
     * The rail, end to end.
     *
     * Folders are the part of the window no unit test can prove: the shape
     * travels schema → IPC → store → renderer, and a break anywhere along it
     * looks like a folder that simply never appears. The chat's own id in its
     * `…` menu is the other half, because that is what a bug report quotes.
     *
     * State is changed over the bridge and then read back from the DOM after a
     * reload. A window cannot be asked to re-read without one, and reloading is
     * what a second launch does anyway — so this is also the check that the two
     * lists survive a restart.
     */
    const secondFolder = join(userData, 'second-folder');
    await mkdir(secondFolder, {recursive: true});

    const activeRowId = async () =>
      await evaluate(`(() => {
        const row = document.querySelector('.rail-row[data-active="true"]');
        return row === null ? null : row.getAttribute('data-session-id');
      })()`);

    const chatId = await activeRowId();
    if (typeof chatId !== 'string' || chatId.length === 0) {
      fail('the rail does not list the open conversation under a folder');
    } else {
      ok(`the rail lists the open conversation (${chatId})`);
    }

    /*
     * The menu, opened the way a person opens it — a click on the row's `…`,
     * not a call to a handler.
     */
    await evaluate(
      `document.querySelector('.rail-row[data-active="true"] .rail-row-menu')?.click()`,
    );
    const menu = await until('the conversation menu to open', async () =>
      await evaluate(`(() => {
        const menu = document.querySelector('.rail-menu');
        if (menu === null) return undefined;
        const id = menu.querySelector('.rail-menu-id code');
        return JSON.stringify({
          id: id === null ? null : id.textContent,
          copy: [...menu.querySelectorAll('button')].some((button) =>
            /copy/i.test(button.textContent ?? ''),
          ),
          actions: [...menu.querySelectorAll('.rail-menu-item')].map(
            (item) => item.textContent ?? '',
          ),
        });
      })()`),
    );
    const shown = JSON.parse(menu);
    if (shown.id !== chatId) {
      fail(`the menu shows id ${shown.id} for a row filed as ${chatId}`);
    } else if (
      shown.copy !== true ||
      !shown.actions.includes('Rename…') ||
      !shown.actions.includes('Delete chat…')
    ) {
      fail(`the conversation menu is missing actions: ${menu}`);
    } else {
      ok('the conversation menu shows its id, a copy button, rename and delete');
    }
    // Escape closes it, and the check is that the listener is real rather than
    // that React re-rendered.
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`,
    );
    if ((await evaluate(`document.querySelector('.rail-menu') === null`)) !== true) {
      fail('Escape did not close the conversation menu');
    } else {
      ok('Escape closes the conversation menu');
    }

    /*
     * Settle the window before moving anything.
     *
     * A conversation with no messages is listed only while it is the one on
     * screen, and the chat the window opened with is not necessarily the newest —
     * the probe created one too. Reloading makes boot land on the newest, so the
     * chat this check files is one that will still be visible afterwards.
     */
    await reload();
    const openId = await until('the rail to settle on the newest chat', async () => {
      const id = await activeRowId();
      return typeof id === 'string' && id.length > 0 ? id : undefined;
    });

    /*
     * Load a folder, rename it, file the open chat under it and rename the chat
     * — every one of those over the same bridge the window uses.
     */
    const changed = JSON.parse(
      await evaluate(`(async () => {
        const added = await window.marimo.call('workspaces.add', {
          path: ${JSON.stringify(secondFolder)},
        });
        const folder = added.workspaces.find(
          (entry) => entry.path === ${JSON.stringify(secondFolder)},
        );
        const renamed = await window.marimo.call('workspaces.rename', {
          workspaceId: folder.id,
          name: 'Smoke folder',
        });
        const {profiles, activeProfileId} = await window.marimo.call('profiles.list', {});
        const moved = await window.marimo.call('sessions.move', {
          profileId: activeProfileId,
          sessionId: ${JSON.stringify(openId)},
          workspaceId: folder.id,
        });
        const {session: retitled} = await window.marimo.call('sessions.rename', {
          profileId: activeProfileId,
          sessionId: ${JSON.stringify(openId)},
          title: 'Smoke chat',
        });
        return JSON.stringify({
          added: added.added,
          folderId: folder.id,
          named: renamed.workspaces.find((entry) => entry.id === folder.id)?.name,
          filed: moved.session.workspaceId,
          title: retitled.title,
          profileCount: profiles.length,
        });
      })()`),
    );
    if (
      changed.added !== true ||
      changed.named !== 'Smoke folder' ||
      changed.filed !== changed.folderId ||
      changed.title !== 'Smoke chat'
    ) {
      fail(`filing over the bridge did not take: ${JSON.stringify(changed)}`);
    } else {
      ok('a folder was loaded, renamed, and the chat filed under it');
    }

    // The reload is the restart: both lists are read again from disk. The wait
    // is for the *chat*, not for the folders: boot reads the folders first, so a
    // poll can see two of them a moment before the conversations arrive under
    // them — which is a window, not a failure.
    await reload();
    const rail = JSON.parse(
      await until('the rail to show the filed chat', async () => {
        const state = await evaluate(`(() => {
          const read = (row) => ({
            id: row.getAttribute('data-session-id'),
            title: row.querySelector('.rail-row-title')?.textContent ?? '',
          });
          const folders = [...document.querySelectorAll('.rail-workspace')];
          if (folders.length < 2) return undefined;
          const group = (label) => {
            const found = [...document.querySelectorAll('.rail-group')].find(
              (entry) => entry.querySelector('.rail-group-head')?.textContent === label,
            );
            return found === undefined
              ? []
              : [...found.querySelectorAll('.rail-row')].map(read);
          };
          return JSON.stringify({
            folders: folders.map((folder) => ({
              id: folder.getAttribute('data-workspace-id'),
              name: folder.querySelector('.rail-workspace-label')?.textContent ?? '',
              path: folder.querySelector('.rail-workspace-path')?.textContent ?? '',
              chats: [...folder.querySelectorAll('.rail-row')].map(read),
            })),
            social: group('Social'),
            otherChats: group('Other chats'),
          });
        })()`);
        if (state === undefined) {
          return undefined;
        }
        const parsed = JSON.parse(state);
        const filed = parsed.folders.some((folder) =>
          folder.chats.some((row) => row.id === openId),
        );
        return filed ? state : undefined;
      }),
    );
    const loaded = rail.folders.find((folder) => folder.id === changed.folderId);
    if (loaded === undefined) {
      fail('the folder that was loaded is not in the rail after a reload');
    } else if (
      loaded.name !== 'Smoke folder' ||
      !loaded.chats.some((row) => row.id === openId)
    ) {
      fail(`the chat was not filed under the loaded folder: ${JSON.stringify(loaded)}`);
    } else if (
      loaded.chats.find((row) => row.id === openId)?.title !== 'Smoke chat'
    ) {
      fail('the renamed chat did not keep its name in the rail');
    } else {
      ok('the loaded folder and the filed chat survive a reload');
    }

    /*
     * Forgetting a folder. The chat has to move to "Other chats" rather than
     * vanish with it, and the directory has to be exactly where it was: "remove
     * from list" is what the menu promised.
     */
    const removed = JSON.parse(
      await evaluate(`(async () => {
        const state = await window.marimo.call('workspaces.remove', {
          workspaceId: ${JSON.stringify(changed.folderId)},
        });
        return JSON.stringify({
          removed: state.removed,
          stillListed: state.workspaces.some(
            (entry) => entry.id === ${JSON.stringify(changed.folderId)},
          ),
        });
      })()`),
    );
    if (removed.removed !== true || removed.stillListed !== false) {
      fail(`removing the folder did not take: ${JSON.stringify(removed)}`);
    }

    await reload();
    const after = JSON.parse(
      await until('the chat to move to Other chats', async () => {
        const state = await evaluate(`(() => {
          const folders = [...document.querySelectorAll('.rail-workspace')];
          if (folders.some((folder) =>
            folder.getAttribute('data-workspace-id') === ${JSON.stringify(changed.folderId)})) {
            return undefined;
          }
          return JSON.stringify({
            folderIds: folders.map((folder) => folder.getAttribute('data-workspace-id')),
            otherChats: [...document.querySelectorAll('.rail-group')].flatMap((group) =>
              group.querySelector('.rail-group-head')?.textContent === 'Other chats'
                ? [...group.querySelectorAll('.rail-row')].map((row) =>
                    row.getAttribute('data-session-id'),
                  )
                : [],
            ),
          });
        })()`);
        if (state === undefined) {
          return undefined;
        }
        // Both halves of the end state: the folder is gone *and* the chat that
        // was filed under it is reachable elsewhere. Waiting only for the first
        // would pass during the window before boot has read the conversations.
        return JSON.parse(state).otherChats.includes(openId) ? state : undefined;
      }),
    );
    if (after.folderIds.includes(changed.folderId)) {
      fail('the removed folder is still in the rail');
    } else if (!after.otherChats.includes(openId)) {
      fail('the chat filed under the removed folder did not move to Other chats');
    } else {
      ok('a forgotten folder takes its chats to Other chats');
    }

    if ((await stat(secondFolder).catch(() => undefined)) === undefined) {
      fail('removing a folder from the list deleted the directory');
    } else {
      ok('the folder itself was left exactly where it was');
    }

    if (probe.theme !== 'dark' && probe.theme !== 'light') {
      fail(`the theme attribute is "${probe.theme}", not light or dark`);
    } else {
      /*
     * A fresh data directory has no timer installed and no key to encrypt, so
     * this is what the row should say on a first run.
     */
    if (probe.serviceInstalled !== false || probe.serviceKeysReadable !== true) {
      fail(
        `the background-service row is wrong: installed=${String(probe.serviceInstalled)} ` +
          `keysReadable=${String(probe.serviceKeysReadable)}`,
      );
    } else {
      ok('the background-service row answered, and is off on a fresh install');
    }

    /*
     * The scheduling tools are the specific ones that were unreachable, so they
     * are the specific ones asserted. A count alone would pass on a catalogue
     * that listed eleven read-only tools and nothing else.
     */
    const needed = ['read_file', 'write_file', 'run_shell', 'spawn_agent', 'create_job'];
    const missing = needed.filter((name) => !probe.catalogNames?.includes(name));
    if (missing.length > 0 || probe.catalogBlurbs !== true) {
      fail(
        `the tool catalogue is incomplete: missing ${missing.join(', ') || '(none)'}` +
          `, blurbs ${String(probe.catalogBlurbs)}`,
      );
    } else {
      ok(`the tool catalogue offers ${String(probe.catalogNames?.length)} tools`);
    }

    /*
     * The companion window. Asserted from here rather than photographed: the
     * DevTools protocol cannot capture a transparent always-on-top window, so
     * the evidence that it is up and *transparent* comes from the page itself.
     */
    const pages = await (await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/list`)).json();
    const pet = pages.find(
      (entry) => entry.type === 'page' && entry.url.includes('companion.html'),
    );
    if (pet === undefined) {
      fail('the desktop companion window did not open');
    } else {
      const petSocket = new WebSocket(pet.webSocketDebuggerUrl);
      await new Promise((resolve) => petSocket.addEventListener('open', resolve));
      const answer = await new Promise((resolve) => {
        petSocket.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.id === 1) {
            resolve(message.result?.result?.value ?? '');
          }
        });
        petSocket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(() => {
                const moss = document.querySelector('.pet-moss');
                const bar = document.querySelector('.pet-input');
                const column = document.querySelector('.pet-column');
                return JSON.stringify({
                  moss: !!document.querySelector('.pet-moss img'),
                  input: !!bar,
                  transparent:
                    getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)',
                  /*
                   * The companion's shape, measured rather than assumed:
                   * answers, then the moss, then the bar. Geometry rather than
                   * DOM order, because what the user sees is where the boxes
                   * land — a stylesheet that stacked them the other way round
                   * would pass an order check and still put the bar in the way.
                   */
                  mossAboveBar:
                    moss !== null && bar !== null
                      ? moss.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top
                      : false,
                  columnAboveMoss:
                    column !== null && moss !== null
                      ? column.getBoundingClientRect().bottom <= moss.getBoundingClientRect().top
                      : false,
                });
              })()`,
              returnByValue: true,
            },
          }),
        );
        setTimeout(() => { resolve(''); }, 5_000);
      });
      const state = answer.length > 0 ? JSON.parse(answer) : {};
      if (state.moss !== true || state.input !== true || state.transparent !== true) {
        fail(`the companion is wrong: ${answer}`);
      } else if (state.mossAboveBar !== true || state.columnAboveMoss !== true) {
        fail(`the companion's layout is out of order: ${answer}`);
      } else {
        ok('the desktop companion is up, transparent, and shaped answers → moss → bar');
      }

      /*
       * And now the thing that actually broke: does the pet *hear* the turn?
       *
       * The companion is not a decoration of the main window — it has no
       * transcript of its own to fall back on. Bubbles come from the event
       * stream, so a window that is broadcast to but not broadcast *at* looks
       * perfectly healthy and completely silent, while the same conversation
       * visibly progresses next door. Nothing about that is visible from the
       * main window, from the stores, or from any unit test: the pet's calls all
       * work, and only the answers were missing.
       *
       * A fresh install has no API key, so the honest expectation is not an
       * answer — it is a reaction. Sending from the pet must produce *something*
       * in the pet, and on this install that something is the refusal. Either
       * outcome passes; silence does not.
       */
      const reacted = await new Promise((resolve) => {
        const timer = setTimeout(() => { resolve('timed out'); }, 20_000);
        let step = 0;
        petSocket.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          const value = message.result?.result?.value;
          if (message.id === 2) {
            // The send is away; give the turn a moment to be refused.
            setTimeout(() => {
              petSocket.send(JSON.stringify({
                id: 3,
                method: 'Runtime.evaluate',
                params: {
                  expression: `JSON.stringify({
                    bubbles: document.querySelectorAll('.pet-bubble').length,
                    error: !!document.querySelector('.pet-error'),
                    text: [...document.querySelectorAll('.pet-bubble')].map((b) => b.textContent).join(' ').slice(0, 80),
                  })`,
                  returnByValue: true,
                },
              }));
            }, 6_000);
          }
          if (message.id === 3) {
            clearTimeout(timer);
            resolve(value ?? 'no value');
          }
        });
        // Type and press Enter the way a person does, through the real input.
        petSocket.send(JSON.stringify({
          id: 2,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => {
              const input = document.querySelector('.pet-input');
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, 'smoke: does the pet hear the answer?');
              input.dispatchEvent(new Event('input', {bubbles: true}));
              input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
              return 'sent';
            })()`,
            returnByValue: true,
          },
        }));
      });
      if (reacted === 'timed out' || reacted === 'no value') {
        fail(`the companion never answered the check: ${reacted}`);
      } else {
        const seen = JSON.parse(reacted);
        if (seen.bubbles === 0 && seen.error !== true) {
          fail(
            'the companion received no events at all — it drew nothing after a ' +
              'turn was started from its own chat bar, which is what a window ' +
              'missing from broadcast() looks like',
          );
        } else {
          ok(`the companion hears the turn stream (${seen.text || 'shown as an error'})`);
        }
      }
      petSocket.close();
    }

    /*
     * A fresh install opens by pointing at Settings rather than by showing a
     * chat that refuses. Checked here because it is the first thing a new user
     * sees and the only part of the first run that no unit test covers. The
     * control is asserted, not just the copy: a welcome that says "add a key in
     * Settings" with nothing to press is the dead end this screen exists to
     * avoid.
     */
    const asked = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        onboarding: !!document.querySelector('.onboarding'),
        cta: !!document.querySelector('.onboarding .button-primary'),
        composer: !!document.querySelector('.composer-box'),
      })`,
      returnByValue: true,
    });
    const first = JSON.parse(asked.result.value);
    if (first.onboarding !== true || first.cta !== true) {
      fail(`a fresh install did not point at Settings: ${asked.result.value}`);
    } else if (first.composer !== true) {
      // Not blocking: somebody who wants to look around first still can.
      fail('the first run took the message box away');
    } else {
      ok('a fresh install points at Settings, without taking the window over');
    }

    /*
     * The provider picker, opened the way a person opens it.
     *
     * Its list is drawn from the protocol catalogue and its value comes from the
     * settings schema, so a provider on one side and not the other is a menu
     * that quietly offers the wrong set — and a `<select>` whose value matches no
     * option shows its first entry instead of what is stored. Neither is visible
     * from a unit test, because each side is right on its own.
     */
    await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.head button')]
        .find((entry) => entry.textContent.trim() === 'Settings')
        ?.click()`,
      returnByValue: true,
    });
    const picker = await until('the provider picker to appear', async () => {
      const {result} = await send('Runtime.evaluate', {
        expression: `(() => {
          const section = [...document.querySelectorAll('.settings-section')]
            .find((entry) => entry.querySelector('h3')?.textContent === 'Provider');
          if (section === undefined) return undefined;
          const [providers, models] = section.querySelectorAll('select');
          const baseUrl = section.querySelector('input[type="text"]');
          if (providers === undefined || models === undefined || baseUrl === null) {
            return JSON.stringify({incomplete: true});
          }
          /*
           * The key box and the Fetch button are asserted *in this section*:
           * they were moved here from a separate API key card, and a section
           * that lost them would still pass every check above.
           */
          const keyInput = section.querySelector('input[type="password"]');
          const fetchButton = [...section.querySelectorAll('button')]
            .find((entry) => entry.textContent.trim() === 'Fetch Models');
          return JSON.stringify({
            labels: [...providers.options].map((option) => option.textContent),
            active: providers.value,
            models: [...models.options].map((option) => option.textContent),
            baseUrl: baseUrl.value,
            hasKeyInput: keyInput !== null,
            hasFetchButton: fetchButton !== undefined,
            fetchDisabled: fetchButton?.disabled ?? null,
          });
        })()`,
        returnByValue: true,
      });
      return typeof result?.value === 'string'
        ? JSON.parse(result.value)
        : undefined;
    });

    const providerLabels = picker.labels ?? [];
    const sortedLabels = [...providerLabels].sort((a, b) => a.localeCompare(b));
    if (picker.incomplete === true) {
      fail('the provider section is missing one of its controls');
    } else if (providerLabels.length < 2) {
      fail(`the provider picker offers ${providerLabels.length} provider(s)`);
    } else if (providerLabels.join('\u0000') !== sortedLabels.join('\u0000')) {
      fail(
        `the provider picker is out of alphabetical order: ${providerLabels.join(', ')}`,
      );
    } else if (!Array.isArray(picker.models) || picker.models.length === 0) {
      fail(`the model picker is empty for "${picker.active}"`);
    } else if (!/^https?:\/\//u.test(picker.baseUrl ?? '')) {
      fail(`the base URL box holds "${picker.baseUrl}"`);
    } else if (picker.hasKeyInput !== true) {
      fail('the API key box is not in the provider section');
    } else if (picker.hasFetchButton !== true) {
      fail('the provider section has no Fetch Models button');
    } else if (picker.fetchDisabled !== true) {
      // A fresh install has no key stored, so there is nothing to ask the
      // endpoint yet — the button is present but refused.
      fail('Fetch Models is offered before a key is stored');
    } else {
      ok(
        `the provider picker offers ${String(providerLabels.length)} providers, ` +
          `alphabetically: ${providerLabels.join(', ')}`,
      );
      ok(
        'the provider section carries the key box and a key-gated Fetch Models ' +
          'button',
      );
    }

    /*
     * Back to the chat before anything else is measured. The dialog covers the
     * window, and every check after this one — and the screenshot — is about the
     * window.
     */
    await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.settings-head button')]
        .find((entry) => entry.textContent.trim() === 'Back to chat')
        ?.click()`,
      returnByValue: true,
    });

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
          const button = [...document.querySelectorAll('.theme-button')]
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

    /*
     * The renderer's own complaints. Printed on every run rather than only on
     * failure: a React warning or a rejected call that the checks happen not to
     * assert on is still something somebody needs to see.
     */
    const complaints = pageConsole.filter((line) =>
      /^(error|warning|assert)/u.test(line),
    );
    if (complaints.length > 0) {
      console.log('--- renderer ---');
      for (const line of complaints.slice(-20)) {
        console.log(`  ${line}`);
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
    if (!(await stopApp())) {
      fail('the app could not be stopped, and is still running');
    }
    await rm(userData, {recursive: true, force: true});
  }
}

/**
 * Wraps the socket in a request/response `send`.
 *
 * DevTools has no correlation beyond the id the client invents, so the pending
 * map is the whole of the protocol handling this check needs.
 *
 * The same socket carries the page's own console output, which is collected
 * rather than ignored: when a check fails, the renderer's complaint is usually
 * the only thing that says why, and it is not visible from the main process.
 */
async function attach(socket) {
  let nextId = 1;
  const pending = new Map();
  const console = [];

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.method === 'Runtime.consoleAPICalled') {
      const level = message.params?.type ?? 'log';
      const text = (message.params?.args ?? [])
        .map((arg) => arg?.value ?? arg?.description ?? '')
        .join(' ');
      if (text.length > 0) {
        console.push(`${level}: ${text}`);
      }
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

  const send = (method, params = {}) =>
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

  // Asks for the console stream before anything else, so a complaint made
  // during startup is not missed by being early.
  await send('Runtime.enable');

  return {send, console};
}

/**
 * Runs inside the page, over the same bridge the app uses.
 *
 * `mounted` is the gate: it is only true once the bridge answered *and* React
 * rendered. Anything else is a partial start that would otherwise pass.
 *
 * It goes past `app.info` on purpose. That call proves the preload is loaded; it
 * says nothing about whether the agent behind it came up. Asking for the agents
 * and starting a conversation is what proves the whole spine — the runtime, the
 * stores, and the IPC handlers — is connected, and it does it without needing a
 * provider, because a conversation is a file and does not require one.
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

    const {profiles, activeProfileId} = await window.marimo.call('profiles.list', {});
    result.profileCount = profiles.length;
    result.activeProfileId = activeProfileId;

    const {session} = await window.marimo.call('sessions.create', {
      profileId: activeProfileId,
    });
    result.sessionId = session.id;

    const {sessions} = await window.marimo.call('sessions.list', {
      profileId: activeProfileId,
    });
    result.sessionCount = sessions.length;
    result.listedIds = sessions.map((entry) => entry.id);

    /*
     * The background-service row. Asked here rather than only photographed: the
     * switch is the one control in the window that reaches outside the app's own
     * files, and a call that threw would leave a row that silently never appears.
     */
    const service = await window.marimo.call('service.status', {});
    result.serviceInstalled = service.installed;
    result.serviceKeysReadable = service.keysReadable;

    /*
     * The catalogue the settings screen draws. Asserted because a tool the host
     * builds but the catalogue omits is a capability that exists and cannot be
     * granted: the switch for it does not exist. That happened — the scheduling
     * tools were missing — and it is invisible from the chat window.
     */
    const catalog = await window.marimo.call('profiles.catalog', {});
    result.catalogNames = catalog.tools.map((tool) => tool.name);
    result.catalogBlurbs = catalog.tools.every(
      (tool) => typeof tool.blurb === 'string' && tool.blurb.length > 0,
    );

    const {messages, pending} = await window.marimo.call('sessions.get', {
      profileId: activeProfileId,
      sessionId: session.id,
    });
    result.messageCount = messages.length;
    result.pendingCount = pending.length;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    return result;
  }
  result.mounted = result.rootChildren > 0;
  return result;
})()`;

await main();
