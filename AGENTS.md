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
                    memory and session stores, AgentHost. No Electron.
packages/runtime    The Electron-free half of the app proper: where files live,
                    secrets with the cipher injected, the jobs/profiles/settings/
                    skills stores, and the document-version machinery.
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

## Commands

```bash
pnpm install          # the store lives in .pnpm-store, per pnpm-workspace.yaml
pnpm build            # tsc -b for every project, then the renderer bundle
pnpm typecheck        # including test projects
pnpm test             # vitest, everywhere
pnpm --filter @marimo/desktop dev     # Vite + Electron
pnpm --filter @marimo/desktop smoke   # boot a real window and prove it works
```

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
