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
| ✅  | The model: Qwen3.5-4B run by a llama.cpp engine the app owns, on loopback, with no account and no key. Two sizes — Q4_K_M on a 4 GB card, Q8_0 on a 6 GB one — chosen from what the GPU reports, and downloaded on first run |
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
| ✅  | A first run that downloads the model it needs, with progress and a resumed download, instead of showing a chat that refuses                                                                                                            |
| ✅  | A memory review: after a conversation goes quiet the agent proposes what is worth remembering and asks before writing it — reading a long session in stretches rather than only once it ends, and remembering the facts you turned down |
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

# A model, for a checkout. A packaged app downloads its own on first run, so
# this is only what a development run needs — 2.7 GB for the low tier.
pnpm --filter @marimo/desktop model:fetch
export MARIMO_MODEL_DIR="$PWD/apps/desktop/.model-cache/local-model"

# Open the app
pnpm --filter @marimo/desktop dev

# Prove a real window opens and its renderer mounted
pnpm --filter @marimo/desktop smoke
```

**A checkout has no weights in it, and `MARIMO_MODEL_DIR` is how it finds them.**
Without it the app looks in its own user-data directory, finds nothing, and opens
on the screen that offers to download a model — which is a state it has to handle
anyway, and exactly what the smoke check exercises, since a check that needed a
gigabyte of download would not run in CI. `model:fetch` prints the line above when
it finishes; `model:fetch high` fetches the larger tier instead.

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

### The model the app downloads

There is one model, Qwen3.5-4B, run by a llama.cpp `llama-server` the app starts
and supervises on loopback. No account, no key, no address to type, and nothing
typed into the chat leaves the machine. There is no provider catalogue, no
address to edit and no model list to fetch — a menu of services was three ways of
describing a choice this app does not offer.

**It comes in two sizes and the app picks one.** `low` is the model at Q4_K_M
(2.7 GB, a 16K window) and `high` is the same weights at Q8_0 (4.5 GB, 32K). Both
are the same model, the same chat template and the same tool calls; the only
difference is how much of the weights survived quantization. Which one runs is
decided from what the graphics card reports as free, and the Model card in
Settings says which and why — in the plan's own words, because the number it was
decided on is one a person can disagree with. The switch beside it is `auto`, the
small one or the large one; an explicit choice is honoured and warned about rather
than overruled.

**Nothing is bundled, and the first run downloads.** A packaged app carries no
weights and no engine, because an installer with a gigabyte inside it is a
gigabyte in every release and every rebuild. The first run downloads a 32 MB
engine and then the tier the machine can use, verifying each against a pinned
sha256 and resuming an interrupted download rather than starting it again. That is
the one moment this app needs the network, and the screen says so.

**There is no CPU path.** Every engine asset is a GPU build — Vulkan on Linux and
Windows, Metal on macOS — and a machine with no usable device is refused with a
sentence rather than quietly run on a processor. A 4.7B model on a CPU is a wait
rather than an answer, and shipping the option would mean shipping a configuration
nobody should be in.

The engine's address is the one thing here that is _not_ an answer. It comes up on
whatever port was free, so no address is stored anywhere: the resolver takes the
live one from the process that started it, and a turn asked for without a running
engine is refused with a sentence rather than sent to whichever process happens to
be listening. That matters more than it looks — a conversation is not something to
hand to a stranger.

Both processes get the same answer from the same place. The pins are a module both
of them *import* rather than a file either of them has to find, and the model
directory is the user-data directory [invariant 13](./AGENTS.md) is about — so a
scheduled job runs the tier the window would, at the same context. When the two
disagreed, nothing errored: a job quietly reported the model as not installed
while the window answered questions.

`--jinja` is the flag the whole feature rests on, and it is verified rather than
assumed. Without it llama.cpp does not apply the model's own chat template, and
Qwen3.5's template is the only thing that turns its `<tool_call>` block into a
call this app can see — so the agent would be offered no tools, every request
would succeed, and nothing would ever be called. The pinned build was checked
end to end: a tool call arrives as a structured `tool_calls` delta with its
arguments, the token counts arrive with it, and `enable_thinking:false` is
honoured so thinking costs nothing on the questions that do not need it.

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

The model is in there too, under `model/`: the engine, whichever tier was
downloaded, and a marker naming the engine asset it was unpacked from so a build
that moves to a new llama.cpp re-fetches it. It is downloaded rather than bundled,
which is why it lives beside the rest of the user's data instead of inside the
app — and why `MARIMO_MODEL_DIR` points one process at a different copy, which is
what a checkout does.

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
- **Vulkan is the only GPU backend shipped**, and macOS's Metal, which needs no
  choice. CUDA and ROCm exist upstream and are not pinned: Vulkan is 32 MB and
  covers NVIDIA, AMD and Intel from one asset per platform, while the Windows CUDA
  build is 264 MB and needs a further 391 MB of cudart DLLs. Adding one later is an
  asset in `pins.ts` and nothing else, because the probe asks the engine rather
  than a vendor tool.
- **The tier boundary is an estimate rather than a measurement.** Whether a 6 GB
  card runs the large tier is computed from the weights, a quantized cache and a
  compute buffer with a margin — not from starting it. The override exists because
  an estimate can be wrong, and the numbers want checking against real cards.
- **The download is verified but not signed.** Each file is checked against a
  sha256 pinned in the app, which catches a corrupted or substituted download over
  a hostile network only as far as the pin itself is trusted — there is no
  signature chain behind it.
- **The `.deb` and the two installers** need a platform each; see the table
  above for what is verified and what is not.

## Building a release

```bash
pnpm --filter @marimo/desktop package       # Linux AppImage
pnpm --filter @marimo/desktop package:win   # Windows NSIS installer
pnpm --filter @marimo/desktop package:mac   # macOS DMG
pnpm --filter @marimo/desktop package:dir   # unpacked, no installer
```

All four are plain builds. They used to fetch the model first and copy ~1.1 GB of
weights into the app's resources, with `MARIMO_SKIP_MODEL=1` as the escape hatch
CI needed; the model is downloaded on a user's first run now, so there is nothing
to fetch and no variable to remember. A packaged app ships an app that offers to
download a model, which is also the state a checkout is in and the state the smoke
check runs in.

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
