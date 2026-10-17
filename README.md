# Marimo Bot

> [!WARNING]
> Marimo Bot is under construction. It is developed in the open and changes often,
> and some of those changes are breaking: what one build saved, the next may
> rewrite or refuse. Download and run it at your own risk, and keep your own
> copies of anything you care about.

A desktop AI assistant that lives on your own computer.

Point it at a folder and it reads and writes the files in there, remembers what
matters between conversations, and can keep working on a schedule while the
window is closed. You make bots for the work you repeat, and Marimo Bot hands the
work to them.

Marimo Bot shows up twice: a chat window, and a small moss ball that floats above
your other windows and answers in a speech bubble. They share one conversation,
so asking at the moss and reading it in the window later works.

The app carries no model of its own. The first time you open it, it asks which
service should write the answers: one you have an account with, or a llama.cpp
server you run yourself. It says nothing until you choose.

## What it can do

- Load a folder and it becomes a Space: the chats you start there, the bot you
  keep for that work, and a Documents drawer that lists the markdown already in
  the folder and edits it in place. There is no import and no second copy. Ask
  about a file by name, or let a bot write one and watch the same file appear in
  the drawer. If a file changed since you opened it, the save is refused, your
  draft stays, and you choose which version wins.
- Make as many bots as you like in Settings. Each one gets a name, an icon, an
  identity you write, its own tools, the Space it works in and, if you want, a
  model of its own. The bots sit at the top of the sidebar; pick one to see its
  conversations, and choose one of five shipped icons or upload your own picture
  in Settings. Several can share a chat; type `@` to put a question to one of
  them. Ask Marimo Bot for a blog post and it can hand the writing to Writer,
  whose answer comes back into the same conversation under its own name, with
  any approval it needs asked under the turn you are reading.
- Removing a bot asks first and says what goes: the bot, its conversations, the
  jobs it had scheduled and what it remembered about you. Files it wrote inside
  your Spaces stay where they are, and the last bot stays too, because something
  has to answer.
- It keeps a long conversation in bounds. Once the history grows past a
  conservative size, the older part is replaced by a summary the model writes;
  the transcript keeps everything, and **Compact** in the composer's `+` menu is
  still there when you want it on your terms.
- It remembers what you tell it. Facts about you follow you between Spaces, and
  the conventions of a project stay with that project. Settings shows everything
  it remembers and when each line was written. When an answer is wrong, "Not
  quite" under the reply records what was right instead, and the next time the
  bot reads a conversation back it proposes that correction for you to accept or
  drop.
- Search by meaning with `Ctrl+K` when you do not know the words that are in the
  file. Each result shows how close the match is and whether the file has changed
  since it was indexed. It is off until you turn it on, because it brings its own
  model.
- Schedule a task, such as a summary every morning. It keeps running after you
  close the window.
- Approve what it does. A command, or a write over a file that already exists,
  waits for your answer first; a new file is written without asking. The request
  survives a restart, so closing the window does not lose it.
- Search the web for anything current.
- Record how it decides, if you are curious. Every turn is written down as a
  tree: which tools it was offered, which it asked for, and how each one turned
  out. A command in Settings replays your own recorded turns under different
  settings without calling a model, and shows what each setting would have
  hidden. It cannot show what would have happened next, because the bot picks
  each step from the result of the last one. The recording is off by default and
  nothing in it is sent anywhere, since it is a record of your work.

## Getting started

There is no public download yet. The Linux version builds to a self-contained
AppImage; the Windows and macOS installers are not built. If someone gave you the
app, or you built it yourself, opening it starts a short setup.

- A Space: the folder Marimo Bot may read and write. It can see nothing outside it,
  and every chat is filed under the Space it started in.
- A bot: a name, and how much it may do, in plain words. The choices are "Just
  chat", "Help around my computer" and "Do things for me". Tick **let Marimo Bot hand
  work to your bots** if you want Marimo Bot to be able to give it a job.
- How to talk to me, which is your side of it: what to call you, how long an
  answer should be, whether to admit when it is unsure. It is read after
  everything the app says about itself, so it wins wherever the two disagree,
  and leaving it empty is fine. **Reset to default** puts the app's starting text
  back without touching what you wrote there.
- The service that answers: DeepSeek, Google Gemini, OpenCode Go, OpenRouter, or
  a [llama.cpp](https://github.com/ggml-org/llama.cpp) server you run yourself at
  an address you type. The hosted ones need an account and an API key. **Fetch
  models** asks the service what it serves, so you choose from its current list.
  Until a service is chosen and reachable the window offers no message box,
  because there would be nothing to answer with.

Keys go into your operating system's keychain, encrypted. One box is worth
understanding: **let scheduled jobs use this key while the app is closed**. A
scheduled task runs with no window and no keychain to unlock, so on a hosted
service that box is what makes it possible, and it means the key sits on disk
readable. It is off unless you tick it.

Closing the window does not quit Marimo Bot. It stays in the tray so the moss ball
and your scheduled tasks keep working, and you quit it from the tray menu.

Settings is one screen. It holds the bots and their icons, what each one may do,
the service that answers, memory, search, connectors and the recording; every
tool is a switch, and a tool that is off is not offered to the model at all.

## Privacy

What answers decides where your words go, and the app says which on the provider
card. On a llama.cpp server of your own, nothing you type leaves the machine or
your network. On a hosted service, your conversations go there under your account
and its terms. Two other things go over the network, and only when you use them:
a web search sends the query to DuckDuckGo, and a connector you set up talks to
the server you configured.

Everything Marimo Bot keeps is in one folder, `~/.config/Marimo Bot` on Linux: your
conversations, the folders you loaded, your settings and your keys. A Space's
documents are not in it; those are your files, read and written where they are.
**Reset Marimo Bot**, at the bottom of Settings, erases that folder, switches off
start-at-login and the background job timer, and quits so that opening it again
is a first run. There is no undo.

## What is not finished yet

- The Windows and macOS installers are written but not built. Only the Linux
  AppImage has been run.
- There is no auto update, so a new version is a file you download again.
- Discord and the notes and to-do tools exist in the code, but nothing in the
  window turns them on yet.
- Skills are read from a file, and nothing in the window writes them: you edit
  that file by hand.
- The search model's download is checked against a checksum pinned inside the
  app, which catches a damaged or swapped file. There is no signature chain
  behind it, and nothing else is downloaded.

## What your computer needs

The app is small because it runs no model of its own. What your machine has to do
depends on the service you pointed it at. A llama.cpp server you run yourself
wants the graphics card, and it can be another machine on your network. A hosted
service wants a connection and your key.

The one model that runs here is search, and only once you turn it on. It embeds
text on the processor, so the graphics card is not involved in that. The first
time you turn it on it downloads about 310 MB, or about 555 MB more if you want
pictures, sounds and video searched as well.

- A 64-bit version of Linux, Windows or macOS. The search engine's builds use
  Vulkan on Linux and Windows and Metal on macOS, so that driver has to load.
- A few gigabytes free: a few hundred megabytes for the search model, plus an
  index that grows with the folder you point it at. The index is written inside
  that folder.
- An account and a key with a hosted service, if that is what you picked.
- Linux today, since the Windows and macOS installers are not built.

If you run llama.cpp on this machine, close games and video editors before
starting it, since the weights and the game want the same video memory.

## For developers

The design decisions, the code layout and how to build a release are in
[TECHNICAL.md](./TECHNICAL.md). The blunt working notes, including the rules that
are easy to break, are in [AGENTS.md](./AGENTS.md).

## Licence

Apache-2.0. See [LICENCE](./LICENCE) and [NOTICE](./NOTICE).
