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
                    AgentUiEvent union, the model id, cron, the profile and job
                    documents. No Electron, no Node, no React.
packages/agent      Everything ADK: the OpenAI-compatible client, tool set,
                    skills that compose the system instruction, the file-backed
                    memory and session stores, AgentHost, and the
                    document-version machinery. No Electron.
packages/runtime    The Electron-free half of the app proper: where files live,
                    secrets with the cipher injected, the jobs/profiles/
                    workspaces/settings/skills/proposals stores, the supervisor
                    for the model the app downloads, and the pins. Re-exports the
                    version machinery it uses, so a caller still finds it beside
                    them.
apps/desktop        The Electron app: src/main (window, IPC, tray, adapters),
                    src/preload (the sandboxed bridge), src/runner (the headless
                    job runner), src/renderer (React), src/shared.
```

**The dependency rule that matters:** `packages/*` import nothing from Electron.
That is not a style preference — it is what lets the _same_ agent core run in the
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
   answered in the _next_ one, because resuming is a new turn carrying the
   confirmation. So `pendingGatesIn` tracks the newest invocation rather than
   looking for unanswered calls anywhere — get this wrong and a card the user
   walked away from comes back on every reload, with an Approve button that asks
   ADK to confirm a call belonging to a finished turn.
3. **Every tool call gets an answer.** An assistant message with tool calls must
   be followed by one result per call or the provider refuses the whole request —
   on that turn _and every later turn of that conversation_.
4. **Reasoning is replayed.** DeepSeek rejects a tool-carrying turn whose
   `reasoning_content` is missing from a later request. It is not decoration.
5. **Gated means gated in code, not in the prompt.** Whether a call pauses the
   turn is decided before the tool is offered to the model.
6. **A refused path is refused after resolution.** `..`, an absolute path outside
   the workspace, and a symlink that leaves it are one refusal.
7. **Truncation is visible.** A capped tool result says so, so the model knows
   there is more rather than believing it read everything.
8. **Secrets never cross to the renderer.** Settings report whether a connector's
   secret is _set_, never its value — and there is a test that walks the payload
   rather than trusting one call site.
9. **A capability the user turned off is absent, not discouraged.**
10. **One turn at a time holds across processes.** The app and the runner are
    serialised by a lock, not by hope.
11. **Unattended means unapproved stays unapproved.** A headless run never
    answers its own approval gate.
12. **A newer document is never overwritten.** See "Documents" below.
13. **The app and the runner resolve the same user-data directory.** When they do
    not, nothing errors: the window writes one `jobs.json`, the service reads
    another, finds nothing due, and exits 0. **The model used to be a second case
    of this and no longer is**: it was bundled, so the window found it through
    Electron's `process.resourcesPath` while the runner derived the path from its
    own executable. It is downloaded into the user-data directory now and the pins
    are _imported_ rather than located, so there is one derivation instead of two —
    and `resolveTier`/`localModelSpecFor` are what both processes call to get the
    same tier at the same context.
14. **An MCP server's tools cannot take a built-in name.** The reserved set is
    every built-in name _before_ the profile filter — a tool the profile has
    switched off still owns its name, because the profile can change between
    turns.
15. **A turn that says nothing is a failure, not an answer.** A small model can
    end a turn with reasoning in `thought` parts, no content and no tool call.
    ADK calls that a completed turn and the window draws an empty bubble, so
    `drive` treats a turn with no visible text and no pending gate as broken: it
    asks once more with the model's own reasoning handed back, stores the reply,
    and reports `turn.failed` if that is empty too. `tool-loop-plugin.ts` is its
    sibling and the same rule from the other end — the third identical tool call
    in a turn is refused rather than run, because a model that loops arrives at
    that silence by itself. Nothing here is a prompt: a prompt is what a small
    model loses first.
16. **The engine's address exists only in the process that started it.** The
    engine comes up on whatever port was free, so no address is stored anywhere:
    the resolver takes the live one from the caller or refuses, with a sentence.
    There is no placeholder to fall back to, which is the point — a fixed port
    would send a conversation to whatever else is listening there. `--jinja` is
    the other half of the same feature and is just as silent when missing: the
    engine runs perfectly and the agent is offered no tools at all.

## Documents

Every file the app owns carries a `version` and is read through
`readVersionedDocument` in `@marimo/runtime`:

- **Older** → upgraded step by step by a declared migration.
- **Current** → used.
- **Newer** → refused, and the file is left untouched.
- **Unreadable** → the _reader_ decides. `load()` is lenient so the window still
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

**One document's data sometimes has to move to another's.** The folders used to
be a field on each profile; they are `workspaces.json` now, adopted on the first
read of that file and _preserved_ on every profiles write until the adoption has
landed. That second half is the point: a migration in `migrations.ts` is a pure
function of one document and cannot write another, so the only thing standing
between a user's folders and a profile edit during the upgrade is the write path
carrying them forward until the new store has taken them.

## The loop

**A task is done when it is committed; the branch moves when a human says so.**
That is the whole rule, and the rest of this section is what makes it cheap to
follow.

**CI exists, and it is `.github/workflows/ci.yml`.** Nothing in this file used to
mention it, which is how a push went up against a workflow whose first step could
not run. It re-runs what you just ran — `pnpm -r build`, `typecheck`, `test` —
and then does the two things a local shell usually skips: the smoke check under
`xvfb-run`, and a real `electron-builder` package whose unpacked runner is
started to prove asar is still off. Read it before changing a build script, a
dependency's version, or anything the package step assumes about
`apps/desktop/release/`.

**It has never run here, and the red X does not mean it failed.** The remote is a
Gitea instance with no runner registered, so every push records a run that
executed nothing — `Waiting`, `0s`, annotated _No matching online runner with
label: ubuntu-latest_. That annotation is the whole story; the older runs that
read `Failure` were Gitea giving up on jobs nothing claimed, not tests that
failed. So nothing in the workflow is exercised by a push, and a change that
touches the preload, the IPC schemas or the bundles is still only verified by the
local commands above. Registering a runner is the job that turns that tab into a
signal — worth doing closer to release than now — and the workflow is ready for
one: nothing in it is on Gitea's unsupported list, with `${{ runner.temp }}` in
the package step the single expression to watch, because an unexpanded context
there fails the step rather than the job.

Two consequences worth internalising. **A green local run is not a green CI run**
— the steps above are the difference, so a packaging or preload change is not
verified until CI has said so. And **a version belongs in exactly one place**:
`package.json`'s `packageManager` is the pnpm version, and the workflow
deliberately does not repeat it, because `pnpm/action-setup` fails outright when
both are present rather than picking one.

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
MARIMO_NO_SANDBOX=1 pnpm --filter @marimo/desktop smoke   # only where AppArmor
                                                          # cannot help; see below
```

**`--watch` has to be spelled out, and the _script_ cannot do it.** Each
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

**Never push on your own initiative.** Pushing is done when asked, usually after
a review of the commit. The remote this checkout has is the Gitea instance
`git remote -v` names — the same one the CI section above is about — and `main`
tracks it, so the push is `git push` with no arguments and no second remote
invented for the job. If a push is refused for authentication, say so — do not
reach for a token or rewrite a remote.

Messages follow the history rather than a convention document:

- Subject is a sentence, capitalised, no `feat:`/`fix:` noise. Milestone work
  carries its tag — `M5: the desktop companion`; everything else is a plain
  clause — `Audit: three real defects, including two I introduced`.
- The body is where the value is: what was wrong, what it now does, and _why
  that shape_. Written in the same voice as the comments in the code, because
  it is the same kind of explanation with a longer shelf life.
- No `Generated with` footer and no co-author trailer. The author is already
  `DevTarlow`.
- A commit that only touches documentation still gets a body if a reader would
  otherwise wonder why it exists.

**Verification scales with the change, and the ordering matters.** A
renderer-only change needs `typecheck`, the desktop tests and `build:web` — not
the agent package's own suite, which is most of the workspace and none of what
changed. A change to `packages/agent` needs the lot, because that package is what
the window _and_ the headless runner both run. Anything that touches the preload,
the IPC schemas or the built bundles needs `build:web` and the smoke check,
because those three failing looks like something else.

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
pnpm --filter @marimo/desktop model:fetch   # 2.7 GB, for a checkout; see below
pnpm build:web        # the renderer bundle: `tsc -b` + vite build, desktop only
pnpm typecheck        # including test projects
pnpm test             # vitest, everywhere
pnpm --filter @marimo/desktop dev     # tsc -b, then Vite + Electron
pnpm --filter @marimo/desktop smoke   # boot a real window and prove it works
pnpm --filter @marimo/desktop jobs-check   # prove a due job runs in the app
```

**Those last three open a real window, on whatever display you are running on,
and this app is tray-resident: closing its window does not end it.** That is the
point of it and it is also the trap — an agent left behind is an icon in
somebody's tray that only they can clear, holding the single-instance lock and a
user-data directory while it sits there.

The pid a launcher hands back is the trap inside the trap: `.bin/electron` is a
shim that execs a node script which _spawns_ the real binary, so a kill aimed at
that pid stops the wrapper and leaves the app running. `scripts/app-process.mjs`
is where that is handled once for both driver scripts — the app is started
`detached`, so it leads a process group, and `stopApp` signals the group and waits
for it to empty, on Ctrl-C as well as on the way out. Anything you start by hand
is still yours to put down. Before you call the work finished, check:

```bash
ps -eo pid,cmd | grep '[e]lectron/dist/electron'   # empty is the only good answer
```

If it is not empty, close it — the `^/` keeps this from matching the shell that
runs it:

```bash
pkill -f '^/.*electron/dist/electron'
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
in two on purpose: `plan.ts` produces the unit/plist/task as _data_, and
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

Electron aborts with `The SUID sandbox helper binary was found, but is not
configured correctly` when it cannot create the user namespace Chromium's sandbox
is built on. Ubuntu 24.04 made that a default rather than a container quirk:
`kernel.apparmor_restrict_unprivileged_userns` is 1, so the namespace sandbox is
unavailable and the setuid fallback is tried instead. Electron ships that
fallback as an ordinary user-owned 0755 file, which is what aborts.

`./scripts/fix-linux-sandbox.sh` installs the fix Ubuntu uses for its own
browsers — an AppArmor profile naming the binary and granting `userns,`. It has
to be re-run when the Electron version changes, because the profile attaches to
the versioned path inside `.pnpm`, and a stale one fails exactly the way no
profile did. The setuid alternative, `chown root:root` plus `chmod 4755` on
`chrome-sandbox`, works too but is undone by the next `pnpm install` that
re-extracts Electron.

The smoke check still takes `MARIMO_NO_SANDBOX=1` for the case AppArmor cannot
cover — a container — and nothing else does, because it is a real reduction in
isolation and must not become the quiet default.

Either way the symptom is misleading and worth recognising: the dev launcher
prints Vite's URL _first_ and Electron dies immediately after, so a host policy
that refused a syscall reads as a renderer that failed to paint.

## The model the app downloads

**Nothing is bundled.** The app carries no weights and no engine, and downloads
them on a user's first run into `<user-data>/model/`. That is a deliberate
inversion of what this file used to say: an installer with 1.1 GB inside it worked
offline out of the box, and the cost was a build that needed a gigabyte of network
and a release that could only be rebuilt by downloading it again. The trade now is
one download on first run, and the pins — tag, revision, per-asset sha256 — live in
`packages/runtime/src/local-model/pins.ts`, which both processes _import_ rather
than find on disk.

**There are two tiers of one model, and no CPU path.** `low` is Qwen3.5-4B at
Q4_K_M (2.7 GB, 16K) and `high` is the same model at Q8_0 (4.5 GB, 32K). Every
engine asset is a GPU build — Vulkan on Linux and Windows, Metal on macOS — and a
machine with no usable device is refused with a sentence rather than quietly run on
a processor. `local-model/plan.ts` decides the tier from what the engine reports as
free, and the decision is an _estimate_: weights, a quantized cache and a compute
buffer, plus a margin. It probes and then downloads; it never tries and falls back.
The estimate is why `modelTier` exists as a settings field — `auto`, `low` or
`high` — and an explicit choice is never second-guessed, only warned about.

**The engine is fetched before the tier, and that order is forced.** Nothing can
ask the hardware until something can run on it, so the 32 MB engine goes first, then
the probe, then the tier the probe chose. That is what stops a first run downloading
4.5 GB for a card that cannot hold it — and it is why `LocalModelHost.install` is
three steps rather than one.

Five things here are easy to get wrong and expensive to find:

- **`--jinja` is load-bearing.** Without it llama.cpp does not apply the model's
  own chat template, and Qwen3.5's template is what turns its `<tool_call>` block
  into a call this app can see. The engine runs perfectly, every request succeeds,
  and the agent is offered no tools at all. Verified against the pinned build: with
  it, a tool call arrives as a structured `tool_calls` delta with its arguments.
- **`enable_thinking:false` is honoured, and that is not universal.** One shipped
  template ignores the flag entirely and forces thinking on, which reads as "off"
  while every turn pays for it. Qwen3.5's honours it, so the thought stream is
  absent when it should be and arrives as `reasoning_content` when it is not.
- **`--flash-attn on` is not optional.** The KV cache is `q8_0`, and a quantized V
  cache needs flash attention; an engine that resolved `auto` to `off` would store
  the cache at f16 and use the memory the quantization exists to save.
- **`fs.cp` rewrites relative symlinks to absolute ones** unless
  `verbatimSymlinks: true`. The released engine archives link their libraries
  relatively, so a copy points into a scratch directory that is deleted a line
  later — and the engine then fails with `error while loading shared libraries`
  while every file it names is visibly present.
- **Never leave an engine behind.** It is gigabytes of memory and a spinning fan
  with no window to explain it. `LocalModelService` stops it on the way out and
  writes a pid file so the next run can reap one that outlived a crash; the command
  to check by hand is `pgrep -x llama-server`.

Tests for all of this inject `spawn`, `fetch` and `tar`, so nothing in the suite
touches the network, spawns an archive tool, or loads a weight. Start a real one by
hand only when you mean it:

```bash
pnpm --filter @marimo/desktop model:fetch          # low tier, into .model-cache/
pnpm --filter @marimo/desktop model:fetch high     # or the big one
MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/local-model \
  pnpm --filter @marimo/desktop dev
```

## Packaging

```bash
pnpm --filter @marimo/desktop package   # AppImage into apps/desktop/release/
```

**Packaging no longer fetches anything.** It used to be a build plus 1.1 GB of
weights copied into the app's resources, with `MARIMO_SKIP_MODEL=1` as the escape
hatch CI used. The model is downloaded on first run now, so `package`,
`package:win` and `package:mac` are plain builds and there is no variable to
remember. What a packaged app ships is an app that says it needs to download a
model — which is the state a checkout is in too, and the state the smoke check
runs in.

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
- **One test loads the real embedding model, and it is skipped unless asked for.**
  `packages/runtime/src/recall/memory-retrieval.live.test.ts` asserts that a
  question actually retrieves the memory bullet that answers it, through the
  pinned model, revision, prefixes and pooling — the one thing a fake embedder
  cannot check, because a regression there returns a plausible result list rather
  than an error. Run it by hand when you touch `prefixes.ts`, the scoring floor,
  the pooling, or the model pins:

  ```bash
  # a directory holding the weights, the pinned engine in engine/, and nothing else
  MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/live-model \
    pnpm --filter @marimo/runtime test:live
  ```

  `$PWD` and not a relative path: the filter runs the suite with the package as
  its working directory, so `apps/desktop/...` from inside `packages/runtime/` is
  a directory that does not exist — which reports as a skipped test rather than as
  a bad path.

  The directory has to be laid out the way the app uses it — weights at its root,
  engine in `engine/` — because that is where the supervisor takes the engine's
  shared libraries from, so an engine binary kept elsewhere is given the app's
  libraries and fails with `unknown model architecture`. That is also why
  `pins.ts` carries a second `RECALL_ENGINE`: the app's own build cannot load this
  model at all. `model:fetch` populates the chat side only, so a live run usually
  means pointing this at a directory assembled by hand — symlinking the pinned
  weights beside an extracted `RECALL_ENGINE` archive is enough. An unset
  environment, missing weights or a missing engine all report as skipped rather
  than failing, because none of them is a broken build.
