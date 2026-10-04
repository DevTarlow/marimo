# Marimo Agent

A standalone desktop AI agent you can bolt capabilities onto.

Marimo Agent is a chat window with a marimo moss ball living in it, a minimal
harness that runs one turn at a time, and — when you want it — a small floating
companion that sits on your desktop and answers in bubbles above itself. It runs
on your machine, with your own API key or a local model, and nothing about it
requires an account.

**It is early.** The engine, the stores and the shell are in place; the
conversation surface, the capability panels and the companion are next. The
sections below say what works and what does not, because a README that describes
the intention rather than the build is worse than no README.

## What works today

| | |
|---|---|
| ✅ | The Electron shell: a sandboxed window, a validated IPC bridge, light and dark themes with OS following |
| ✅ | The agent core: `AgentHost` over Google ADK, an OpenAI-compatible streaming provider, 4 backends, ~30 tools, skills, `memory.md`, JSONL conversations |
| ✅ | The stores: jobs, profiles, settings, skills — with format versioning that refuses to overwrite a document it cannot read |
| ✅ | Secrets in the OS keychain, with a plain-text opt-in for the case where there is no keychain |
| ✅ | The headless job runner: finds due jobs from a terminal with no display, and exits non-zero when it cannot read them |
| 🚧 | The chat UI, the capability toggles, MCP servers, sub-agents, the floating companion, packaging |

## Quick start

```bash
pnpm install
pnpm build
pnpm test

# Open the app
pnpm --filter @marimo/desktop dev

# Prove a real window opens and its renderer mounted
pnpm --filter @marimo/desktop smoke
```

Two environment quirks are worth knowing about up front, both covered in
[AGENTS.md](./AGENTS.md):

- If Electron's binary download fails with `ENOENT ... ~/.cache/electron`, wrap
  the command: `./scripts/with-local-caches.sh pnpm install`. The project keeps
  every tool cache inside the repository.
- In a container, Electron refuses to start because `chrome-sandbox` cannot be
  setuid-root. The smoke check alone takes `MARIMO_NO_SANDBOX=1` for that.

## Why it is built this way

### Three packages, and none of them know about Electron

`@marimo/protocol` is the typed contract — every IPC call, every event, the
profile and job documents. `@marimo/agent` is the agent itself. `@marimo/runtime`
is where files live and how documents are versioned.

None of them import Electron, and that is load-bearing rather than tidy. The
background service that keeps scheduled jobs running while the app is closed is
**the same binary started as plain Node** (`ELECTRON_RUN_AS_NODE=1`). That is what
gives it the same agent core and the same conversation files without a second
runtime or a second copy of the logic — and it is what lets it run from a timer at
boot, over SSH, or in a container, none of which a plain Electron process can do.

The cost is real and worth stating: with no `app` object there is no
`safeStorage`, so an encrypted API key cannot be read. **Running jobs while the
app is closed needs the plain-text secret opt-in**, and the app says so rather
than failing quietly.

### The window and the service must agree about where data lives

Electron derives its user-data directory from the app's `productName`. The runner
has no `app` to ask, so it derives the same path from the platform's rules. If
those ever disagree, nothing errors: the window writes one `jobs.json`, the
service reads another, finds nothing due, and exits 0 — a background service that
looks healthy and never does anything. There is a test on the name, and the app
checks the two paths against each other at launch.

### Documents are versioned, and a newer one is never overwritten

Every file the app owns carries a `version`. Reading is explicit about the four
outcomes — absent, current, older, newer, unreadable — because the alternative is
what the previous generation of this code did: a schema mismatch made the read
return an empty document, the user watched their jobs disappear, and the next
save made it true on disk.

When a file is unreadable the reader decides what it deserves. The window reads
leniently so the app still opens and can be fixed by hand. The runner reads
strictly so it can exit non-zero, which is the only signal a timer gets. And the
write path refuses a file from a newer build, or moves a corrupt one aside,
rather than storing an empty document over it.

## Layout

```
packages/protocol   The typed contract. No Node, no Electron, no React.
packages/agent      The agent: ADK, the provider, tools, skills, memory, sessions.
packages/runtime    Where files live, secrets, the stores, document versions.
apps/desktop
  src/main          Window, IPC, path and secret adapters, (next: tray, connectors)
  src/preload       The sandboxed bridge — the window's entire reach
  src/runner        The headless job runner
  src/renderer      The React UI
  src/shared        Facts both entry points need, such as the product name
  scripts/smoke.mjs Boots a real window and proves the bridge and the UI work
```

## Data

Everything lives under Electron's user-data directory — on Linux,
`~/.config/Marimo Agent`. `MARIMO_USER_DATA_DIR` relocates all of it, which is
how development, the tests and the smoke check keep their state out of yours.

```
secrets/          one file per secret, encrypted or plainly opted out
sessions/         one JSONL file per conversation
profiles.json     the agents: identity, workspace, capabilities
jobs.json         scheduled jobs
settings.json     preferences
skills.json       skills you wrote
```

## Status and next steps

The plan runs M0–M8. What works today:

- **The agent.** MCP servers connect, their tools are offered to the model, and a
  server the user has not trusted asks before each call — a gate that survives a
  restart, because it is derived from the stored conversation rather than held in
  memory. `web_search` works with no API key, through a hidden window.
- **The window.** A chat with a conversation rail, streaming answers, tool calls
  that fold away, and approval cards.
- **Scheduled jobs**, while the app is open *and* while it is closed. The app and
  the headless runner share one job file, and an occurrence is claimed by a
  compare-and-set so it runs once whichever process gets there first.
- **The headless runner** (`dist/runner/run-due.js`) — the same binary started as
  plain Node, so it needs no display and can be woken by an OS timer.

Next: the tray and the OS service that wakes the runner, the agent's sub-agents
and memory review, the chat's markdown and code rendering, the floating
companion, the capability panels, and packaging for Linux, then Windows and
macOS.

## Licence

Not yet chosen. Nothing here may be redistributed until it is.
