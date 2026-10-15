# Marimo Agent: technical notes

How the app is built, why it is built that way, and how to work on it. If you
want to know what the app does and how to use it, read
[README.md](./README.md). The blunt working notes, and the rules that break
silently when you get them wrong, are in [AGENTS.md](./AGENTS.md).

## Running from source

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
gigabyte of download would not run in CI. `model:fetch` prints a ready-to-paste
`MARIMO_MODEL_DIR=... pnpm --filter @marimo/desktop dev` line when it finishes;
`model:fetch high` fetches the larger tier instead.

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

The wider loop — what to run before a commit, and what has to be true before a
push — is in [AGENTS.md](./AGENTS.md). The short version:

```bash
pnpm typecheck   # every project, including the test ones
pnpm test        # vitest everywhere
pnpm build       # tsc -b for every project, but not the renderer bundle
pnpm build:web   # the renderer bundle — `build` alone leaves it stale
```

## What is built

| State       | Feature                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done        | The model: Qwen3.5-4B run by a llama.cpp engine the app owns, on loopback, with no account and no key. Two sizes — Q4_K_M on a 4 GB card, Q8_0 on a 6 GB one — chosen from what the GPU reports, and downloaded on first run            |
| Done        | The chat: streamed answers rendered as markdown, tool calls that fold away, copy buttons, a workspace rail with the conversations filed under the folder they work in, light and dark following the OS or chosen                        |
| Done        | Two sizes of app: a simple screen and a power screen, with one switch between them                                                                                                                                                      |
| Done        | The agent core: `AgentHost` over Google ADK, an OpenAI-compatible streaming client over one backend, ~28 built-in tools of which the app offers the ones its services can carry out, skills, `memory.md`, JSONL conversations           |
| Done        | Approvals that survive a restart, because a pending call is derived from the stored conversation rather than held in memory                                                                                                             |
| Done        | MCP connectors: add one by pasting a command, test it from the same form, and choose whether to trust it — untrusted servers ask before every call                                                                                      |
| Done        | Per-agent capabilities: every tool is a switch, and a tool that is off is not offered to the model at all                                                                                                                               |
| Done        | The stores: jobs, profiles, settings, skills, memory proposals — with format versioning that refuses to overwrite a document it cannot read                                                                                             |
| Done        | Secrets in the OS keychain: connector tokens, encrypted at rest, with a machine that has no keychain told so rather than written to in the clear                                                                                        |
| Done        | Scheduled jobs while the app is open, and a headless runner plus an OS service that keeps them going while it is closed                                                                                                                 |
| Done        | The desktop companion: a frameless, transparent, click-through moss ball that answers in bubbles above itself, with its own chat bar underneath and its own settings for how long it answers, how much it shows, and whether it floats  |
| Done        | A first run that downloads the model it needs, with progress and a resumed download, instead of showing a chat that refuses                                                                                                             |
| Done        | A memory review: after a conversation goes quiet the agent proposes what is worth remembering and asks before writing it — reading a long session in stretches rather than only once it ends, and remembering the facts you turned down |
| Done        | Memory in two halves: who the user is, which follows them between projects, and what this folder is, which does not — with a correction able to replace an old fact rather than sit beside it, and every bullet dated |
| Done        | A way to say an answer was wrong. It is recorded, never written straight into memory, and the next review reads it |
| Done        | Recall: find things by what they mean rather than by the words they use, across the folder you loaded, memory, your own conversations and — with one more download — images, audio and video, from a search box or the agent's own tool |
| Done        | Dream-RSI: off by default, a turn's search recorded as a tree of what was offered, proposed and run, and a command that re-decides those turns under other settings without a model |
| In progress | Windows and macOS installers (the config is written and both package; the installers are unbuilt — see [Building a release](#building-a-release))                                                                                       |

## Why it is built this way

### Three packages, and none of them know about Electron

`@marimo/protocol` is the typed contract — every IPC call, every event, the
profile and job documents. `@marimo/agent` is the agent itself. `@marimo/runtime`
is where files live, how documents are versioned, and where the model and recall
engines are supervised.

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
runner _does_ need is the same user-data directory the window is using, which is
why the service definition bakes that path in.

### The model the app downloads

There is one model the app answers with, Qwen3.5-4B, run by a llama.cpp
`llama-server` the app starts and supervises on loopback. No account, no key, no
address to type, and nothing typed into the chat leaves the machine. There is no
provider catalogue, no address to edit and no model list to fetch — a menu of
services was three ways of describing a choice this app does not offer.

**It comes in two sizes and the app picks one.** `low` is the model at Q4_K_M
(2.7 GB, a 16K window) and `high` is the same weights at Q8_0 (4.5 GB, 32K). Both
are the same model, the same chat template and the same tool calls; the only
difference is how much of the weights survived quantization. Which one runs is
decided from what the graphics card reports as free, and the Model card in
Settings says which and why — in the plan's own words, because the number it was
decided on is one a person can disagree with. The switch beside it is `auto`, the
small one or the large one; an explicit choice is honoured and warned about rather
than overruled.

**The tier is chosen from free video memory, and the arithmetic is an estimate.**
One tier wants its weights, a quantized cache at 16 KiB per token, a 384 MB compute
buffer and a 384 MB safety margin. At its full window that comes to about 3.6 GB of
free video memory for Low at 16K and about 5.4 GB for High at 32K. So the planner
takes High at 32K on a card reporting 6 GB, Low at 16K on one reporting 4 GB, Low
at the 8K floor on one reporting 3.5 GB, and refuses below about 2 GB or with no
usable device. Those are judgements rather than measurements, which is why the
override exists and why the reason string on the Model card shows the number the
decision was made on.

**Nothing is bundled, and the first run downloads.** A packaged app carries no
weights and no engine, because an installer with a gigabyte inside it is a
gigabyte in every release and every rebuild. The first run downloads a 32 MB
engine and then the tier the machine can use, verifying each against a pinned
sha256 and resuming an interrupted download rather than starting it again. That is
the one moment this app needs the network before it can answer, and the screen says
so; the only download after it belongs to recall, and that one happens only if the
user asks for the feature.

**There is no CPU path.** Every engine asset is a GPU build — Vulkan on Linux and
Windows, Metal on macOS — and a machine with no usable device is refused with a
sentence rather than quietly run on a processor. A model this size on a CPU is a
wait rather than an answer, and shipping the option would mean shipping a
configuration nobody should be in. The deliberate exception is recall's embedding
model below, which is small enough that the processor is the right home for it.

The engine's address is the one thing here that is _not_ an answer. It comes up on
whatever port was free, so no address is stored anywhere: the resolver takes the
live one from the process that started it, and a turn asked for without a running
engine is refused with a sentence rather than sent to whichever process happens to
be listening. That matters more than it looks — a conversation is not something to
hand to a stranger.

Both processes get the same answer from the same place. The pins are a module both
of them _import_ rather than a file either of them has to find, and the model
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

### Recall: finding things by meaning, on the machine that has them

Searching for a word finds the places that word appears. Recall finds the places a
thing is _about_, which is the only kind of search that works when somebody
half-remembers something — the file about retries, the preference they stated two
weeks ago, the picture with the receipt in it. It is a second model rather than a
second feature bolted onto the first: embeddinggemma-2, a 270M backbone at Q8_0
(310 MB, 768 dimensions, 8K of context), served by its own pinned llama.cpp build
on loopback. "Its own" is load-bearing, and it was learned by running the build
rather than by reading about it: the engine the chat model runs on predates this
model's architecture entirely (`unknown model architecture: gemma-embedding2`), so
recall pins a newer build instead of moving the chat engine onto one whose
template has never been verified against.

**It is off until somebody asks.** Turning it on downloads 310 MB and starts a
second process, so it is not a default; the question is asked once, on the screen
that follows the first model download, and afterwards the switch lives in Settings
where every other capability does. The corpora are separate switches because they
are separate consents: the folder is the work, memory is what the agent wrote down
_about_ the user, a conversation is everything they said, and media needs a second
555 MB download — not a preference but the image and audio encoder itself, absent
from the process unless it is fetched. A corpus that is off is not searched and
not offered: the tool's own scope enum is built from what exists, so a model
cannot ask for something the service would answer "nothing" about.

**The index holds no text.** It holds vectors and a digest per record, so a hit is
read back from its source and checked before it is shown; a file that changed
since it was indexed comes back marked changed, with no text, rather than quoted
from a copy that is no longer there. The index refreshes when a question is asked
rather than on a timer, in bounded slices that report what they covered. And there
is a floor below which a nearest vector is not an answer — measured at 0.68 rather
than chosen, because a list of the least-unrelated things in a folder reads as a
list of answers. The window can ask for the withheld ones when the phrasing, and
not the corpus, was the problem; a tool call cannot, and should not.

**It runs on the processor, and the index lives with the folder it describes.**
The chat tier is estimated on the engine having all the free device memory, and a
second client holding a slice would make that estimate a lie; the embedding model
is small enough that the slower path costs seconds. The index sits in
`<folder>/.marimo/<agent>/recall/` beside memory, so a project that moves takes
its index with it; an agent with no folder loaded gets one under user data
instead.

**Two ways in, one service behind them.** The window has a search box on `Ctrl+K`
that returns the same hits, scores and staleness claims the tool does — somebody
who half-remembers where something is should not need a model to look it up. The
agent gets `recall` beside `search_knowledge_base`: one takes the identifier, the
other takes the description, and a model that knows the words should not have to
phrase them as a question. Memory is a third caller rather than a way in, and it
is the one that changes every turn: when recall is on, the memory block is
narrowed to the bullets that answer the question instead of the whole file, with
the whole file as the fallback whenever retrieval did not work. The sections that
constrain behaviour — tone, conventions, boundaries — ride along whole whatever
was asked, because a missed rule is a wrong action and a missed fact is only a
worse answer.

### Memory is two files, and the layer decides which

Memory is markdown, and there are two of them. `memory/<profile>/memory.md` under
user data holds the facts about the *person* — who they are, how they want to be
talked to, what they have asked never to happen. `<folder>/.marimo/<profile>/`
holds the facts about *this workspace* — its conventions, its paths, one pointer
per project to wherever it keeps its state.

The split is by **layer**, and the vocabulary already knew which was which: the
canonical sections in `sections.ts` carry a `scope`, separate from the `always`
flag. It had to be separate. `Environment and conventions` rides along whole in
every prompt *and* is a fact about one repository, so collapsing the two axes
would have put one project's rules in every other project's prompt.

Both files are read as one document, so everything above this — the prompt block,
the recall index, the staleness hash, the block that narrows memory per question —
never learned there are two. Only the write path knows, and it routes by section:
a canonical name answers its own scope, and a heading the app never named stays in
the workspace file, which is where it already is. That default is the careful
half — nothing a user typed by hand moves on upgrade.

The move itself happens once, on the first read after upgrading, and it is the
same shape as the folders' adoption: data moving between two documents cannot be
a migration, which is a pure function of one. Person-level sections are copied out
of the workspace file and then removed from it, in that order, because the other
order loses them if it throws in between. The merged read de-duplicates bullets,
so the transient state where a fact is in both is invisible rather than doubled.

Two things this deliberately does not do. A prune that never mentions the person
leaves that half exactly as it was and says so in the tool result: the document
the model sends replaces memory, and with two files "I did not mention it" and "I
want it gone" are otherwise the same sentence. And no layer is ever deleted for
being old — `provenance.json` records when each bullet was first written and the
Memory card shows them oldest first, so what is stale is visible and the decision
stays with the person.

### An answer can be judged, and the judgement goes to the reviewer

Everything in this app could be corrected except the thing the agent actually
said. A fact can be replaced, a suggestion refused, a manner written down — but
"you had that wrong, it is like this" had nowhere to go, and that is the
difference between a store of facts and something that improves.

There is now a quiet **Not quite** under an answer, in the window and on the moss,
which records an optional line about what was right instead. Nothing is written to
memory and nothing is said back: the transcript is left as it was, because a
correction is a note *about* a conversation rather than a turn in it. What reads
it is the next memory review, which gets the corrections as a block of their own —
the strongest evidence it ever receives, because the person has already done the
work of stating what is true. It is deliberately not the same as a refusal: a
refusal says "do not remember that", a correction says "this is right".

The store holds the user's words verbatim and bounded, and it is scoped to the
profile, because one agent being told it was wrong about a deployment is not a
fact about the other one. It reads leniently so a corrupt file still opens the
window, and it moves that file aside before writing rather than over it.

### Dream-RSI: the search is recorded, so it can be re-decided offline

A turn is a search. The model proposes a tool call, the controller decides whether
it may be taken, the tool answers, and the turn either continues or ends. For a
long time only the last of those was visible: the transcript shows one path
through the work and has no way to represent the actions that were considered and
refused, so "which tools should this turn have been offered" was not a question
anybody could ask.

Dream-RSI is the three pieces that make it askable. It is off until the user turns
it on, and off means absent rather than discouraged: no recorder is constructed,
and the runner is given the repeat-only plugin it has always had.

**The recorder writes a tree, and a proposal is not a call.** `dream/recorder.ts`
emits a `turn` node per model request, a `propose` node per call the model asked
for, and a `call` node per call that ran, linked by `parentId`. Splitting those last
two is the whole point: between them sits the entire policy, so collapsing them
loses the only measurement the feature has — a withheld action would be
indistinguishable from one the model never thought of. Trees are appended as whole
snapshots rather than mutated in place, so a process killed mid-turn leaves a
readable prefix rather than a truncated object; the turn most worth replaying is
the one that crashed.

**The controller is pure, and that is load-bearing.** `dream/search.ts` is
`SearchPolicy`: UCB1 over an action's visit count and mean reward, an explicit
exploration weight, and a pruning threshold. It takes history as an argument
rather than reading it from anywhere, which is what lets the live turn and the
offline replay call the *same function* — so a setting measured offline is the
setting that runs live, by construction rather than by two implementations kept in
step. Every temptation to make the score cleverer had to survive that constraint,
which is why the reward is an arithmetic function of the recorded result rather
than a model's opinion of it: a reward that needs a model cannot be recomputed
from a log, and a replay that cannot recompute it is either impossible or a liar.

The action's statistics and the repeat rule are deliberately separate numbers.
`visits` counts calls that ran, and drives the reward estimate; `attempts` counts
proposals whether or not they ran, and drives the loop breaker inherited from
`RepeatedToolCallPlugin`. Confusing them is a real bug rather than a tidiness
question — `read_file` three times on three different files is a model doing its
job, and one counter cannot tell that from a loop. A withheld call is counted as an
attempt and *not* as a visit, because counting a refusal as a zero-reward visit
would make pruning self-reinforcing: the evidence for pruning an action would be
the pruning itself.

**Pruning removes the tool from the menu.** It is applied through ADK's
`beforeToolSelection`, so a pruned tool is not merely refused — it is absent, and
the model spends no tokens proposing it and the turn spends no round trip saying
no. `beforeToolCallback` is the safety net beneath it, catching a call already in
flight and the repeat rule, which is about a specific call rather than a tool set.
The default threshold prunes nothing, and that direction is deliberate: the failure
mode of pruning too eagerly is invisible from the outside — the agent answers from
less than it could have, competently and wrongly — while the failure mode of
pruning too little is a slow turn. With the file and shell tools in the menu, the
choice between actions is real, which is what makes the threshold worth measuring
rather than decorative.

**The log records the world, not what one policy approved of.** The `offered` set
on a step node is the *unfiltered* tool set. Recording the narrowed set would be
the obvious thing and it would quietly make the replay useless: a pruned tool would
be absent from its own history, so no candidate threshold could ever be evaluated
against it. Off-policy evaluation needs the whole action space the turn had.

**The replay reports what a setting would have withheld, and refuses to report an
outcome.** `pnpm --filter @marimo/desktop replay:dream` reads the logs, re-decides
every recorded step under a grid of weights and thresholds, and prints a table —
with no model call and no tool call, because every number comes from a log that
already exists. Withheld actions, and how many of those the model actually reached
for, are counts in that log. What would have happened *next* is not: the model
chose each step from the result of the one before it, so withholding a step changes
the conversation, and the recorded continuation is the one that happened under the
old settings. The output says so in its own words rather than leaving a reader to
assume the numbers are a prediction.

One consequence is worth stating because it bounds what a threshold can do. The
first step of a turn has no history, so every action on the menu is untried and
saves every threshold — the first call always happens. A setting can save the
second and third attempts, never the first, which is why the honest pitch is "the
turn stops sooner" rather than "the turn does not go wrong".

**The card reports the last write, not the last error message.** The trees are
written from inside a tool callback, where a full disk must not fail the turn — so
the store keeps the last failure and the card in Settings says so while it is true.
It is a status rather than a one-shot notice because the card is drawn from a
settings payload the window reads for its own reasons, and a message that cleared
on read could be swallowed by a read nobody was showing the card for.

### Two sizes, and one switch between them

Everything the app can do is still a switch somebody turns on. What changed is
that there are two screens to turn it on from: a simple one with three choices in
plain words, and the power screen with the temperature, the engine's command
line and every individual tool. They are the same app, the same stores and the
same grants — the preset a user picks writes `enabledTools`, exactly as ticking
the switches would, and the card that is lit is _worked out_ by comparing that
grant against the lists. There is one source of truth for what an agent may do,
and it is still the profile.

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

Every store the app owns carries a `version`. Reading is explicit about the five
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
started rather than the user — a Discord mention, once that connector is wired —
are listed under "Social" instead of inside a folder that had nothing to do with
them.

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
packages/runtime    Where files live, secrets, the stores, document versions,
                    the model and recall engines, the OS service plans.
apps/desktop
  src/main          Window, IPC, tray, the OS service, path and secret adapters,
                    the model and recall hosts, media decoding
  src/preload       The sandboxed bridge — the window's entire reach
  src/runner        The headless job runner
  src/renderer      The React UI, including the search panel
  src/shared        Facts both entry points need, such as the product name
  scripts/smoke.mjs Boots a real window and proves the bridge and the UI work
```

## Data

Everything lives under Electron's user-data directory — on Linux,
`~/.config/Marimo Agent`. `MARIMO_USER_DATA_DIR` relocates all of it, which is
how development, the tests and the smoke check keep their state out of yours.

```
secrets/                one file per secret, encrypted — a machine without a
                        keychain is refused rather than written readable
sessions/               one JSONL file per conversation, plus an index
memory/<profile>/       the half of memory that is about the *person*, plus the
                        dates of every remembered bullet — it lives under user
                        data because it has to outlive the folder
profiles.json           the agents: identity and capabilities
workspaces.json         the folders every agent can work in, and the current one
jobs.json               scheduled jobs and how their last run went
settings.json           preferences and connectors
skills.json             skills you wrote
memory-proposals.json   what the agent would remember, waiting for an answer
feedback.json           answers the user said were wrong, which the next review reads
trees/<session>.json    what the agent tried on each turn — only while the
                        recording is on, so an install that never turns it on
                        creates no directory at all
window-state.json       where the main window was left
companion-state.json    where the moss was left
local-model.pid         the engine this process started, so a crash cannot orphan it
recall.pid              the embedding engine, for the same reason
recall/                 the search index, when a profile has no folder to keep it in
app.lock                the running app, so the headless runner leaves the jobs alone
```

The other half of memory is the project's, and it is not here: it is
`<folder>/.marimo/<profile>/memory.md`, so a folder you put on a stick takes its
own remembered conventions with it and none of your personal facts.

The model is in there too, under `model/`: the chat engine, whichever tier was
downloaded, and a marker naming the engine asset it was unpacked from so a build
that moves to a new llama.cpp re-fetches it. The recall model and its own engine
sit beside it in `model/recall/`. It is downloaded rather than bundled, which is
why it lives beside the rest of the user's data instead of inside the app — and why
`MARIMO_MODEL_DIR` points one process at a different copy, which is what a checkout
does.

Each store document carries a `version`, and a file written by a _newer_ build is
refused rather than overwritten — including the one holding your agents, which is
the reason the rule exists. A file that cannot be read is moved aside rather than
replaced, so a parse bug is never the end of your data. The exceptions are the two
geometry files, the secret files and the search index: geometry is rewritten every
time a window moves, a secret says in its own prefix whether it is encrypted, and
the index is rebuilt from the folder it describes rather than being the only copy
of anything.

**The settings file is the exception that proves it.** It has never carried a
version, so every settings file in existence looks like an older format; treating
that as "not mine" would reset everybody's connectors and preferences on upgrade.
It names its version explicitly, and stamps one from the next write on. A file
written by a build that had the provider catalogue still loads: the fields this
build no longer knows are ignored, and every preference beside them survives.

## Status and next steps

Everything in the M0–M8 plan is built, and recall landed after it. What is left is
verification rather than construction — the two installers above that cannot be
produced from Linux, and code signing, which needs certificates.

Known gaps, stated plainly:

- **No auto-update.** A release is a file you download again.
- **A `.deb` is not built.** It needs a `homepage` in its metadata and this
  project has no published URL; the AppImage is self-contained and runs anywhere.
- **Discord and the notes/to-do desk are not wired into the app.** The tools and
  the schemas are there and the settings schema still carries the fields, but
  nothing in the window configures them, so they are unreachable. They are
  scheduled for nothing — somebody should either wire them or remove them.
- **Skills are carried but no longer authored.** `skills.json`, its schema and the
  per-profile grant all work, and the agent loads any skill it is granted, but the
  `save_skill` tool and the `/learn` command that wrote them are not wired into the
  window — so a skill today is added by editing the file by hand.
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

MIT. See [LICENCE](./LICENCE).
