# Marimo Agent

A standalone desktop AI agent you can bolt capabilities onto.

Marimo Agent is a chat window with a marimo moss ball living in it, a minimal
harness that runs one turn at a time, and a small floating companion that sits on
your desktop and answers in bubbles above itself. It runs on your machine, with
your own API key or a local model, and nothing about it requires an account.

Two things make it different from a chat window with a plugin folder. **Nothing
is on until you turn it on** — a fresh install can read your files and search the
web, and everything with reach (writing, running commands, fetching an arbitrary
URL, spawning a helper) is granted deliberately, per agent. And **it keeps
working when the window is closed**: scheduled jobs run from a background service
whether or not the app is open.

## What works today

| | |
|---|---|
| ✅ | The chat: streamed answers rendered as markdown, tool calls that fold away, copy buttons, a conversation rail, light and dark following the OS or chosen |
| ✅ | The agent core: `AgentHost` over Google ADK, an OpenAI-compatible streaming provider, 4 backends, ~30 tools, skills, `memory.md`, JSONL conversations |
| ✅ | Approvals that survive a restart, because a pending call is derived from the stored conversation rather than held in memory |
| ✅ | MCP connectors: add one by pasting a command, test it before saving, and choose whether to trust it — untrusted servers ask before every call |
| ✅ | Helper agents: `spawn_agent` hands a separable piece of work to a sub-agent that shares the conversation, so its approvals are visible and its words are labelled |
| ✅ | Per-agent capabilities: every tool is a switch, and a tool that is off is not offered to the model at all |
| ✅ | The stores: jobs, profiles, settings, skills, memory proposals — with format versioning that refuses to overwrite a document it cannot read |
| ✅ | Secrets in the OS keychain, with a plain-text opt-in for the machine with no keychain and for running jobs while the app is closed |
| ✅ | Scheduled jobs while the app is open, and a headless runner plus an OS service that keeps them going while it is closed |
| ✅ | The desktop companion: a frameless, transparent, click-through moss ball with its own chat bar |
| ✅ | A first run that asks for a key instead of showing a chat that refuses |
| ✅ | A memory review: after a conversation goes quiet the agent proposes what is worth remembering, and asks before writing it |
| 🚧 | Windows and macOS installers (the config is written and both package; the installers are unbuilt — see [Building a release](#building-a-release)) |

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
secrets/                one file per secret, encrypted or plainly opted out
sessions/               one JSONL file per conversation, plus an index
profiles.json           the agents: identity, workspace, capabilities
jobs.json               scheduled jobs and how their last run went
settings.json           preferences, providers, connectors
skills.json             skills you wrote
memory-proposals.json   what the agent would remember, waiting for an answer
window-state.json       where the main window was left
companion-state.json    where the moss was left
```

Each carries a `version`, and a file written by a *newer* build is refused rather
than overwritten — including the one holding your agents, which is the reason the
rule exists. A file that cannot be read is moved aside rather than replaced, so a
parse bug is never the end of your data.

**The settings file is the exception that proves it.** It has never carried a
version, so every settings file in existence looks like an older format; treating
that as "not mine" would reset everybody's providers and connectors on upgrade.
It names its version explicitly, and stamps one from the next write on.

## Status and next steps

Everything in the M0–M8 plan is built. What is left is verification rather than
construction — the two installers above that cannot be produced from Linux, and
code signing, which needs certificates.

Known gaps, stated plainly:

- **No auto-update.** A release is a file you download again.
- **A `.deb` is not built.** It needs a `homepage` in its metadata and this
  project has no published URL; the AppImage is self-contained and runs anywhere.
- **Discord and the notes/to-do desk are not wired into the app.** The tools and
  the schemas are there and the settings schema still carries the fields, but
  nothing in the window configures them, so they are unreachable. They are
  scheduled for nothing — somebody should either wire them or remove them.
- **The `.deb` and the two installers** need a platform each; see the table
  above for what is verified and what is not.

## Building a release

```bash
pnpm --filter @marimo/desktop package       # Linux AppImage
pnpm --filter @marimo/desktop package:win   # Windows NSIS installer
pnpm --filter @marimo/desktop package:mac   # macOS DMG
pnpm --filter @marimo/desktop package:dir   # unpacked, no installer
```

Each is built on its own platform in the normal way. What has actually been
verified, and where:

| Target | State |
| --- | --- |
| Linux AppImage | **Built and run.** Both windows open, the bridge answers, and the packaged runner exits 0. |
| Windows `--dir` | **Packages.** `marimo-agent.exe` and a converted `.ico`, built from Linux. |
| Windows NSIS | Not built. Needs Wine on Linux, macOS to sign. Config is written; the installer is unproven. |
| macOS `.app` | **Packages**, with a converted `.icns`, built from Linux. |
| macOS DMG | Not built. Needs `sips`, which is macOS-only. |
| Code signing | Not configured. Needs certificates, and they are the maintainer's to buy. |

**`asar` is off, and that is deliberate rather than an oversight.**
electron-builder warns about it and suggests `asarUnpack` instead. It cannot be
used here: the job runner is this same binary started with
`ELECTRON_RUN_AS_NODE=1`, and in that mode Electron does not patch `fs` to read
inside an asar archive — a script inside one fails with `Invalid package`. So a
packaged app with `asar` on has a background runner that cannot start, which is
the whole of "jobs run while the app is closed" broken in every release while
working perfectly in development. `asarUnpack` would mean enumerating every
transitive dependency of the runner, which is a list that goes stale silently.

## Licence

MIT. See [LICENCE](LICENCE).
