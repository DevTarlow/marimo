# AGENTS.md — Marimo Agent

Working notes for anyone — human or agent — changing this repository. The
project's design decisions live in `README.md`; this file is the shorter, blunter
list of things that are easy to get wrong and expensive to discover.

## What this is

A standalone, always-on desktop agent. A chat window and a floating companion,
an agent harness whose capabilities are opt-in, and a headless runner that keeps
scheduled jobs going while the app is closed.

## Layout

```
packages/protocol   The typed contract: zod schemas for every IPC call, the
                    AgentUiEvent union, providers, cron, the profile and job
                    documents. No Electron, no Node, no React.
packages/agent      Everything ADK: the OpenAI-compatible provider, tool set,
                    skills that compose the system instruction, the file-backed
                    memory and session stores, AgentHost, and the
                    document-version machinery. No Electron.
packages/runtime    The Electron-free half of the app proper: where files live,
                    secrets with the cipher injected, and the jobs/profiles/
                    settings/skills/proposals stores. Re-exports the version
                    machinery it uses, so a caller still finds it beside them.
apps/desktop        The Electron app: src/main (window, IPC, tray, adapters),
                    src/preload (the sandboxed bridge), src/runner (the headless
                    job runner), src/renderer (React), src/shared.
```

**The dependency rule that matters:** `packages/*` import nothing from Electron.
That is not a style preference — it is what lets the *same* agent core run in the
window and in the headless runner, which is the same binary started as plain
Node. Adding `import {app} from 'electron'` to a package breaks the background
service, quietly, at boot rather than at build time.

## The invariants

Each of these is silent when it breaks. That is the whole reason they are listed.

1. **One turn at a time, and the conversation on disk is the state machine.** A
   paused turn's pending calls are derived from the stored thread, never held in
   memory — that is what lets a reloaded window answer a card, and a restarted
   process lose a typing animation rather than a conversation.
2. **A gate is live only in the newest invocation.** A turn is one invocation,
   and starting a new one abandons whatever the previous turn was waiting on.
   Note the shape of a real approval: the question is asked in one invocation and
   answered in the *next* one, because resuming is a new turn carrying the
   confirmation. So `pendingGatesIn` tracks the newest invocation rather than
   looking for unanswered calls anywhere — get this wrong and a card the user
   walked away from comes back on every reload, with an Approve button that asks
   ADK to confirm a call belonging to a finished turn.
3. **Every tool call gets an answer.** An assistant message with tool calls must
   be followed by one result per call or the provider refuses the whole request —
   on that turn *and every later turn of that conversation*.
4. **Reasoning is replayed.** DeepSeek rejects a tool-carrying turn whose
   `reasoning_content` is missing from a later request. It is not decoration.
5. **Gated means gated in code, not in the prompt.** Whether a call pauses the
   turn is decided before the tool is offered to the model.
6. **A refused path is refused after resolution.** `..`, an absolute path outside
   the workspace, and a symlink that leaves it are one refusal.
7. **Truncation is visible.** A capped tool result says so, so the model knows
   there is more rather than believing it read everything.
8. **Secrets never cross to the renderer.** Settings report `hasKey`, never a key.
9. **A capability the user turned off is absent, not discouraged.**
10. **One turn at a time holds across processes.** The app and the runner are
    serialised by a lock, not by hope.
11. **Unattended means unapproved stays unapproved.** A headless run never
    answers its own approval gate.
12. **A newer document is never overwritten.** See "Documents" below.
13. **The app and the runner resolve the same user-data directory.** When they do
    not, nothing errors: the window writes one `jobs.json`, the service reads
    another, finds nothing due, and exits 0.
14. **An MCP server's tools cannot take a built-in name.** The reserved set is
    every built-in name *before* the profile filter — a tool the profile has
    switched off still owns its name, because the profile can change between
    turns.

## Documents

Every file the app owns carries a `version` and is read through
`readVersionedDocument` in `@marimo/runtime`:

- **Older** → upgraded step by step by a declared migration.
- **Current** → used.
- **Newer** → refused, and the file is left untouched.
- **Unreadable** → the *reader* decides. `load()` is lenient so the window still
  opens; `loadChecked()` reports the reason so the runner can exit non-zero; and
  `mutate()` moves an unreadable file aside (`.unreadable`) before writing.

The rule behind all of it: **a lenient read plus a write is how a user's data
disappears.** If you add a store that reads leniently, its write path must call
`assertWritable` or quarantine first.

`migrations.ts` lives in `packages/agent` rather than `packages/runtime`, because
the conversation index needs it and the dependency runs one way — `runtime`
imports `agent`, not the reverse. `runtime` re-exports it so a caller still finds
it beside the stores.

**Every document is covered**, and an audit is the only way to know that: the
session index was the last one missing the guard, and its lenient read plus an
unguarded write meant a corrupt index became an empty one on the very next
message — every conversation gone from the sidebar. When you add a store, add it
to that list.

## The loop

**A task is done when it is committed; the branch moves when a human says so.**
That is the whole rule, and the rest of this section is what makes it cheap to
follow.

```bash
# 1. While working: the narrow loop, a few seconds each.
pnpm --filter @marimo/runtime exec vitest --watch   # one package, watching
pnpm --filter @marimo/desktop typecheck             # ~13s, desktop only

# 2. Before committing: prove the change, not the workspace.
pnpm typecheck        # ~27s, every project including the test ones
pnpm test             # ~34s, vitest everywhere

# 3. Before pushing, or when the change touches the window:
pnpm build            # tsc -b for every project
pnpm build:web        # then the renderer bundle — step 3 is two commands and
                      # `pnpm build` alone leaves the bundle stale
MARIMO_NO_SANDBOX=1 pnpm --filter @marimo/desktop smoke   # only in a container
```

**`--watch` has to be spelled out, and the *script* cannot do it.** Each
package's `test` script is `vitest run`, and `run` ignores a `--watch` after it —
so `pnpm --filter @marimo/runtime test -- --watch` runs the suite once and exits,
looking like a watcher that never fires. Bare `exec vitest` is not reliable
either: with no TTY attached, as in an agent's shell, Vitest quietly falls back
to running once. `exec vitest --watch` is explicit and behaves the same either
way.

**Commit when the task is verified, not when the files are saved.** One commit
per task, and it is the agent's job to make it — nobody should have to ask. A
commit is not a push: it is local, reversible, and the thing that makes the next
task's diff readable.

**Never push on your own initiative.** There is no remote configured in this
checkout by default; when one is added it is
`https://github.com/DevTarlow/marimo-agent.git`, and pushing is done when asked,
usually after a review of the commit. If a push is refused for authentication,
say so — do not reach for a token or rewrite a remote.

Messages follow the history rather than a convention document:

- Subject is a sentence, capitalised, no `feat:`/`fix:` noise. Milestone work
  carries its tag — `M5: the desktop companion`; everything else is a plain
  clause — `Audit: three real defects, including two I introduced`.
- The body is where the value is: what was wrong, what it now does, and *why
  that shape*. Written in the same voice as the comments in the code, because
  it is the same kind of explanation with a longer shelf life.
- No `Generated with` footer and no co-author trailer. The author is already
  `DevTarlow`.
- A commit that only touches documentation still gets a body if a reader would
  otherwise wonder why it exists.

**Verification scales with the change, and the ordering matters.** A
renderer-only change needs `typecheck`, the desktop tests and `build:web` — not
the agent's 435 tests. A change to `packages/agent` needs the lot, because that
package is what the window *and* the headless runner both run. Anything that
touches the preload, the IPC schemas or the built bundles needs `build:web` and
the smoke check, because those three failing looks like something else.

**Two speed notes that are worth knowing before optimising.** TypeScript's
`-b` is not incremental here in practice — a warm `pnpm typecheck` costs about
the same as a cold one — so scoping it to the package you touched is the only
lever. And the suite's cost is process startup, not test count: one package's
tests are a few seconds, all four are ~34. Vitest watches a package well; it
watches the workspace poorly.

## Commands

```bash
pnpm install          # the store lives in .pnpm-store, per pnpm-workspace.yaml
pnpm build            # tsc -b for every project — but NOT the renderer bundle
pnpm build:web        # the renderer bundle: `tsc -b` + vite build, desktop only
pnpm typecheck        # including test projects
pnpm test             # vitest, everywhere
pnpm --filter @marimo/desktop dev     # tsc -b, then Vite + Electron
pnpm --filter @marimo/desktop smoke   # boot a real window and prove it works
pnpm --filter @marimo/desktop jobs-check   # prove a due job runs in the app
```

`pnpm build` and `pnpm build:web` are not alternatives and neither implies the
other. The root `build` is `tsc -b` alone; the renderer bundle only comes from
the desktop package's own `build`, which is what `build:web` filters to. Running
one and believing you ran both is how a window is tested against a bundle that
predates the change — verified the tedious way, by watching `pnpm build` leave
`dist/renderer/index.html` untouched.

The job runner is the same binary started as plain Node, so it can be run by
hand the way the OS timer will:

```bash
ELECTRON_RUN_AS_NODE=1 ./apps/desktop/node_modules/.bin/electron \
  apps/desktop/dist/runner/run-due.js --json
```

It exits 0 when there was nothing to do, and non-zero only when it could not do
its job — an unreadable jobs file, a data directory it cannot read. Keep that
distinction: for a timer, "exit 0, nothing happened" and "exit 0, I could not
read the file" are the same observation, and the second is the failure nobody
notices.

The service layer that wakes it is in `packages/runtime/src/service` and is split
in two on purpose: `plan.ts` produces the unit/plist/task as *data*, and
`apply.ts` is the only part that touches the machine. Every mistake worth
catching is in the content of what gets written, so that is what the tests assert
on — a host is injected, and no test ever installs a timer.

`ELECTRON_RUN_AS_NODE=1` in those definitions is load-bearing rather than tidy.
Without it the timer launches a GUI, fails to find a display, and dies with
SIGTRAP — a service that is enabled, runs every minute, and does nothing. The
`MARIMO_USER_DATA_DIR` beside it is invariant 13 made structural: baking the path
in means the app and the service agree even for a portable install and after a
product-name change, which are exactly when they would silently stop agreeing.

If Electron's binary download fails with `ENOENT ... ~/.cache/electron`, the
environment does not allow writes outside the repository. Use the wrapper, which
points every tool cache inside it:

```bash
./scripts/with-local-caches.sh pnpm install
```

In a container where `chrome-sandbox` cannot be setuid-root, Electron aborts with
`The SUID sandbox helper binary was found, but is not configured correctly`. The
smoke check takes `MARIMO_NO_SANDBOX=1` for that case, and nothing else does —
it is a real reduction in isolation and must not become the quiet default.

## Packaging

```bash
pnpm --filter @marimo/desktop package   # AppImage into apps/desktop/release/
```

**`asar` stays off.** The runner is this binary started with
`ELECTRON_RUN_AS_NODE=1`, and Node mode has no asar support: reading a file
inside one fails with `Invalid package`. Turning it on produces a release whose
background runner cannot start — verified, not assumed — and it works perfectly
in development, so nothing catches it until somebody installs the app.
`asarUnpack` is the tempting alternative and a worse one: it means enumerating
the runner's whole transitive dependency tree.

Packaging changes what `app.getAppPath()` returns, and the OS service plan
writes the runner's path into a systemd unit. Check `pnpm --filter
@marimo/desktop package` still produces a runnable runner when that path moves.

## House style

- **Comments explain why.** The code says what it does. A comment that restates
  the line below it is noise; one that records the failure the line prevents is
  the most valuable thing in the file.
- **No dead code, no speculative options.** A flag nothing sets is a branch
  nobody tests.
- Reach for the existing helper before writing a new one. `window-state.ts`,
  `migrations.ts` and the theme tokens all exist because a version of this app
  got them wrong once.

## Testing

- Unit and integration tests sit beside the code (`src/**/*.test.ts`) in packages,
  and in `apps/desktop/tests` for the app.
- `scripts/smoke.mjs` boots a real window, attaches over the DevTools protocol
  and asserts the bridge answers and React mounted — then screenshots it. It is
  the only check that proves the preload and the renderer bundle agree;
  `--theme light` checks the other token block.
- Tests that touch the filesystem use `mkdtemp` under the working directory
  (`.marimo-*`, gitignored) rather than `/tmp`, so a sandbox that only permits
  writes inside the repository still runs them.
