# Marimo Agent

A standalone desktop AI agent you can bolt capabilities onto.

Marimo Agent is a chat window with a marimo moss ball living in it, a minimal
harness that runs one turn at a time, and a small floating companion that sits on
your desktop and answers in bubbles above itself. It comes with a model that runs
on your machine, so there is no account to make and nothing to configure before
it answers — and nothing you type leaves the computer.

Two things make it different from a chat window with a plugin folder. **Nothing
is on until you turn it on** — a fresh install can read your files and search the
web, and everything with reach (writing, running commands, fetching an arbitrary
URL, spawning a helper) is granted deliberately, per agent. And **it keeps
working when the window is closed**: scheduled jobs run from a background service
whether or not the app is open.

It is also built at two sizes. **Simple** is the everyday screen: a name, one
choice about what the agent may do, and the model. **Power user mode** is
everything — the temperature, the folder widths, the engine's own command line,
every tool as its own switch. One switch in Settings, and neither screen is a
different app.

## What works today

|     |                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅  | The built-in model: Qwen3-1.7B (Q4_K_M) run by a llama.cpp engine the app owns, on loopback, with no account, no key and your own hardware. It is what a fresh install answers with                                                    |
| ✅  | The chat: streamed answers rendered as markdown, tool calls that fold away, copy buttons, a workspace rail with the conversations filed under the folder they work in, light and dark following the OS or chosen                       |
| ✅  | Two sizes of app: a simple screen and a power screen, with one switch between them                                                                                                                                                     |
| ✅  | The agent core: `AgentHost` over Google ADK, an OpenAI-compatible streaming client over one backend, ~30 tools, skills, `memory.md`, JSONL conversations                                                                             |
| ✅  | Approvals that survive a restart, because a pending call is derived from the stored conversation rather than held in memory                                                                                                            |
| ✅  | MCP connectors: add one by pasting a command, test it before saving, and choose whether to trust it — untrusted servers ask before every call                                                                                          |
| ✅  | Helper agents: `spawn_agent` hands a separable piece of work to a sub-agent that shares the conversation, so its approvals are visible and its words are labelled                                                                      |
| ✅  | Per-agent capabilities: every tool is a switch, and a tool that is off is not offered to the model at all                                                                                                                              |
| ✅  | The stores: jobs, profiles, settings, skills, memory proposals — with format versioning that refuses to overwrite a document it cannot read                                                                                            |
| ✅  | Secrets in the OS keychain: connector tokens, encrypted at rest, with a machine that has no keychain told so rather than written to in the clear                                                                                       |
| ✅  | Scheduled jobs while the app is open, and a headless runner plus an OS service that keeps them going while it is closed                                                                                                                |
| ✅  | The desktop companion: a frameless, transparent, click-through moss ball that answers in bubbles above itself, with its own chat bar underneath and its own settings for how long it answers, how much it shows, and whether it floats |
| ✅  | A first run that says what is ready instead of showing a chat that refuses                                                                                                                                                             |
| ✅  | A memory review: after a conversation goes quiet the agent proposes what is worth remembering, and asks before writing it                                                                                                              |
| 🚧  | Windows and macOS installers (the config is written and both package; the installers are unbuilt — see [Building a release](#building-a-release))                                                                                      |

## Quick start

```bash
pnpm install
pnpm build
pnpm test

# Linux only, once per Electron version: let Electron's sandbox start. It asks
# for sudo. Distribution versions that do not restrict user namespaces exit
# immediately, so it is safe to paste blindly.
./scripts/fix-linux-sandbox.sh

# The model the app ships, for a checkout. A packaged build fetches this itself;
# this is what a development run needs, and it is 1.1 GB.
pnpm --filter @marimo/desktop model:fetch
export MARIMO_MODEL_DIR="$PWD/apps/desktop/.model-cache/local-model"

# Open the app
pnpm --filter @marimo/desktop dev

# Prove a real window opens and its renderer mounted
pnpm --filter @marimo/desktop smoke
```

**A checkout has no weights in it, and `MARIMO_MODEL_DIR` is how it finds them.**
Without it the app opens on its welcome screen saying the model engine is not
installed — which is a state the app has to handle anyway, and exactly what the
smoke check exercises, since a check that needed a 1.1 GB download would not run
in CI. `model:fetch` prints the line above when it finishes; `model:where` prints
the directory on its own.

Two environment quirks are worth knowing about up front, both covered in
[AGENTS.md](./AGENTS.md):

- If Electron's binary download fails with `ENOENT ... ~/.cache/electron`, wrap
  the command: `./scripts/with-local-caches.sh pnpm install`. The project keeps
  every tool cache inside the repository.
- The sandbox line is the only step in the quick start that fixes the machine
  rather than the checkout, which makes it the one place a failure has nothing to
  do with the code. Without it Electron dies — _after_ Vite has printed its URL,
  so it reads as a renderer that failed to paint rather than a host policy that
  refused a syscall:
  `The SUID sandbox helper binary was found, but is not configured correctly`.
  In a container, where AppArmor cannot be configured at all, the smoke check
  takes `MARIMO_NO_SANDBOX=1` instead.

If you change the Electron version, run the sandbox script again: the AppArmor
profile is attached to the versioned path inside `.pnpm`, so a stale one stops
matching and the abort returns.

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
`safeStorage`, so an encrypted secret cannot be read. It stopped mattering when
the app stopped having a model key — a background run needs no secret at all,
because the model is a local engine and the runner dials no connectors. What the
runner *does* need is the same user-data directory the window is using, which is
why the service definition bakes that path in.

### The model the app carries

A fresh install has a model: Qwen3-1.7B at Q4_K_M, run by a llama.cpp
`llama-server` that the app starts and supervises on loopback. No account, no
key, no address to type, and nothing typed into the chat leaves the machine.

It is the *only* model, and that is a decision rather than an omission. There is
no provider catalogue, no address to edit, no key to paste and no model list to
fetch — a menu of services was three ways of describing a choice this app no
longer offers. The engine's argv is fixed too: an 8K context window, thinking off
because most questions are the easy kind, and `--jinja` because without it the
agent is offered no tools at all. `MARIMO_MODEL_DIR` is the one override, and it
exists for a development checkout rather than for a user.

The engine's address is the one thing here that is _not_ an answer. It comes up
on whatever port was free, so no address is stored anywhere: the resolver takes
the live one from the process that started it, and a turn asked for without a
running engine is refused with a sentence rather than sent to whichever process
happens to be listening. That matters more than it looks — a conversation is not
something to hand to a stranger.

Both processes start an engine, and they find its files through one function.
The window hands it Electron's `process.resourcesPath`; the headless runner has
no `app` at all and lets the path be derived from its own executable. That is
[invariant 13's](./AGENTS.md) sibling, and it fails the same way: when the two
disagree nothing errors, and a scheduled job quietly reports the model as not
installed while the window answers questions.

The weights are fetched at **package** time, not on a user's first launch. An
installer with the model inside works offline, behind a proxy, and for somebody
who would rather not wait two minutes after opening the app they just installed;
the cost is one 1.1 GB download in a build, which is what
`apps/desktop/scripts/local-model.mjs` does. It pins the llama.cpp release, the
Hugging Face revision and both digests, because a downloaded binary that is not
the one that was tested is a bug that reaches users and not this machine.

`--jinja` is the flag the whole feature rests on. Without it llama.cpp does not
apply the model's own chat template, and Qwen3's template is the only thing that
turns a `<tool_call>` block in the output into a call this app can see — so the
agent would be offered no tools, every request would succeed, and nothing would
ever be called. It is asserted in three places, one of which is the command line
a power user can read in Settings.

### Two sizes, and one switch between them

Everything the app can do is still a switch somebody turns on. What changed is
that there are two screens to turn it on from: a simple one with three choices in
plain words, and the power screen with the temperature, the engine's command
line and every individual tool. They are the same app, the same stores and the
same grants — the
preset a user picks writes `enabledTools`, exactly as ticking the switches would,
and the card that is lit is _worked out_ by comparing that grant against the
lists. There is one source of truth for what an agent may do, and it is still the
profile.

The line between the two screens is **tuning versus repair**. A number to adjust —
a context window, a memory limit, a temperature — is tuning and lives in power. A
switch that fixes something the user is looking at — the moss floating over a
film, the moss not answering the mouse — stays where they are, because hiding an
escape hatch from the person hitting the problem is how a setting comes to look
like a bug.

Which screen a fresh install opens on is decided by _how_ the settings file was
read rather than by what it holds. No file at all means somebody meeting this app
for the first time, and gets the simple screen; a file that exists with no such
field means somebody already using the app, and gets the app in full. A schema
default cannot tell those two apart, which is why the store owns that decision
and the field carries a `.catch` for the hand-edited typo.

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

### A conversation is filed under the folder it works in

Workspaces are folders, they belong to the install rather than to an agent — two
agents asked about the same project work in the same one — and the rail is where
they are managed: load one, rename it, open it in your file manager, forget it.
The folder is what an agent's file tools and shell are confined to, and
`memory.md` travels with it in `<folder>/.marimo/<agent>/`, so a project carries
its own remembered facts.

The folder a turn runs in is resolved **from the conversation**, at the moment
the turn starts, rather than from whichever folder the rail has current. That is
not a detail: opening a chat is a read, and a read that moved the working folder
would abort an answer that is still streaming — so a turn that began in one
project finishes there even if the user has since clicked around. The current
folder is only what a _new_ chat is filed under, and the fallback for a
conversation whose folder has been forgotten.

Forgetting a folder only forgets it. The directory, everything in it and every
conversation file are untouched, and the chats filed under it stay reachable
under "Other chats" until they are moved somewhere else. Conversations the app
started rather than the user — a Discord mention — are listed under "Social"
instead of inside a folder that had nothing to do with them.

### The companion shares the conversation, not the manner

The floating moss ball is not a second agent. It reads and writes the same
thread the window does, through the same profile, tools and grants — so asking it
something and reading the answer in the window later is one conversation rather
than two that drift apart. What it does _not_ share is how long the answer should
be: a question asked over whatever you are working in wants the answer, and a
bookmarklet-sized bubble cannot hold a survey.

So "answer briefly" travels with the turn instead of living on the conversation.
The renderer says which surface asked, the runtime turns the settings into a
sentence, and `AgentHost` appends it to the system instruction for that turn
only — cleared on the way into the next one, so a question asked at the pet does
not make the window terse as well. It is prompt text, like a skill, which is why
changing it never aborts a turn in flight.

## Layout

```
packages/protocol   The typed contract. No Node, no Electron, no React.
packages/agent      The agent: ADK, the OpenAI-compatible client, tools, skills,
                    memory, sessions.
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
profiles.json           the agents: identity and capabilities
workspaces.json         the folders every agent can work in, and the current one
jobs.json               scheduled jobs and how their last run went
settings.json           preferences and connectors
skills.json             skills you wrote
memory-proposals.json   what the agent would remember, waiting for an answer
window-state.json       where the main window was left
companion-state.json    where the moss was left
local-model.pid         the engine this process started, so a crash cannot orphan it
```

The model is not in there. It is part of the install: the engine and the weights
live in the app's own resources (`Contents/Resources/local-model` on macOS,
`resources/local-model` beside the executable elsewhere), read-only, replaced by
installing a newer build — and `MARIMO_MODEL_DIR` points one process at a
different copy, which is what a checkout does. Nothing in the user-data directory
is 1.1 GB, and nothing there has to be re-downloaded to repair the app.

Each carries a `version`, and a file written by a _newer_ build is refused rather
than overwritten — including the one holding your agents, which is the reason the
rule exists. A file that cannot be read is moved aside rather than replaced, so a
parse bug is never the end of your data.

**The settings file is the exception that proves it.** It has never carried a
version, so every settings file in existence looks like an older format; treating
that as "not mine" would reset everybody's connectors and preferences on upgrade.
It names its version explicitly, and stamps one from the next write on. A file
written by a build that had the provider catalogue still loads: the fields this
build no longer knows are ignored, and every preference beside them survives.

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
- **The built-in engine is the CPU build**, and the macOS one, which is Metal.
  Vulkan and CUDA builds exist upstream and are not shipped: a per-GPU build
  matrix is a lot of machinery for a 1.7B model. There used to be a "Local"
  provider a user with a GPU could point at their own server; it went with the
  catalogue, so a GPU build is now a packaging job rather than a setting.
- **The `.deb` and the two installers** need a platform each; see the table
  above for what is verified and what is not.

## Building a release

```bash
pnpm --filter @marimo/desktop package       # Linux AppImage
pnpm --filter @marimo/desktop package:win   # Windows NSIS installer
pnpm --filter @marimo/desktop package:mac   # macOS DMG
pnpm --filter @marimo/desktop package:dir   # unpacked, no installer
```

The first three fetch the model first — engine and weights, ~1.1 GB, cached in
`apps/desktop/.model-cache/` and verified against `local-model.json` on every
build. `package:dir` does not, and `MARIMO_SKIP_MODEL=1` skips it anywhere:

```bash
MARIMO_SKIP_MODEL=1 pnpm --filter @marimo/desktop package   # no model inside
```

CI uses that, because what its packaging step proves is that the app packages and
the packaged runner still starts — not that 1.1 GB of weights were downloaded.
**A release build must not set it**, and it is the one difference between an
installer that answers the first question and one that says the model is not
installed.

Each is built on its own platform in the normal way. What has actually been
verified, and where:

| Target          | State                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| Linux AppImage  | **Built and run.** Both windows open, the bridge answers, and the packaged runner exits 0.   |
| Windows `--dir` | **Packages.** `marimo-agent.exe` and a converted `.ico`, built from Linux.                   |
| Windows NSIS    | Not built. Needs Wine on Linux, macOS to sign. Config is written; the installer is unproven. |
| macOS `.app`    | **Packages**, with a converted `.icns`, built from Linux.                                    |
| macOS DMG       | Not built. Needs `sips`, which is macOS-only.                                                |
| Code signing    | Not configured. Needs certificates, and they are the maintainer's to buy.                    |

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
