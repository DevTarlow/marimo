# Marimo Agent

A private AI assistant that runs on your own computer.

Marimo Agent is a desktop app with two faces. There is a chat window, and there
is a small moss ball that floats on your screen and answers in a speech bubble.
The model that writes the answers runs on your machine, so you do not need an
account and there is nothing to paste in before it works.

## What it can do

Ask it a question and the answer streams in as it is written, with the thread of
the conversation kept.

Point it at a folder and it can read the files inside, so you can ask about your
own documents or code. It cannot see anything outside that folder.

Web search is there for questions that need something current.

Things you tell it, such as a preference or how a project is set up, are
remembered and brought up in later conversations.

It can also find a file or a note from a description of what it was about, even
when you do not know the words in it. This one is off until you turn it on,
because it needs a second download. Once it is on, press `Ctrl+K` and describe
what you are looking for.

Scheduled tasks, such as a summary every morning, keep running after you close
the window.

The moss ball and the chat window share the same conversation. Ask something at
the moss ball and you can read it in the window later.

## Getting started

There is no public download page yet. The Linux version builds to a
self-contained AppImage; the Windows and macOS installers are not built. If
someone gave you the app, or you built it yourself, this is what happens when you
open it.

The first time you start it, it downloads the model it needs. The screen shows
the size before you agree, and you can stop and continue later. That is the one
time it uses the network unless you ask it to search or fetch something.

Then give it a folder to work in. It can read there and nowhere else, and a chat
is filed under the folder it started in so you can keep projects apart.

Next, choose how much it may do. There are three choices in plain words: "Just
chat", "Help around my computer", and "Do things for me". You can change this at
any time.

Anything that changes something on your machine, such as writing a file or
running a command, shows you what it wants to do and waits for your approval.
That request survives a restart, so closing the window does not lose it.

If the app cannot run the model, it says so on the first screen. The model needs
a graphics card and there is no slower fallback.

Closing the window does not quit the app. It stays in the system tray so the moss
ball and any scheduled tasks keep working, and you quit it from the tray menu.

## Everyday use

Ask about your files by naming the file or the folder, for example "what does the
retry code in upload.ts do?".

Press `Ctrl+K` to search your folder by meaning. Each result shows how close the
match is, and says when a file has changed since it was indexed.

The moss ball floats above other windows. You can drag it, ask it something from
the bar underneath, and change how long its answers are or whether it stays on
top in Settings.

There are two versions of the settings screen. Simple has the agent's name, one
choice about what it may do, and the model. Power user shows everything, including
the temperature and every tool as its own switch. One switch in Settings moves
between them, and neither is a different app.

When a conversation gets long, you can compact the older half into a summary from
the `+` menu. The messages stay in the conversation file; the agent simply stops
being sent them.

## Your files and privacy

The model runs on this computer, so your conversations are not sent anywhere. Two
things do go over the network, and only when you use them: a web search sends your
query to DuckDuckGo and reads the results, and a connector you set up talks to the
server you configured.

Your data lives in one folder. On Linux that is `~/.config/Marimo Agent`. It holds
your conversations, the folders you have loaded, your settings, and the model it
downloaded. You can move it with the `MARIMO_USER_DATA_DIR` environment variable,
and you can delete it to start over. The model downloads again the next time you
open the app.

Connector passwords and tokens are kept in the operating system's keychain,
encrypted. If the machine has no keychain, the app says so and refuses to store
the secret rather than writing it somewhere readable.

## What is not finished yet

The Windows and macOS installers are written but not built. Only the Linux
AppImage has been packaged and run.

There is no auto update, so a new version is a file you download again.

Discord and the notes and to-do tools exist in the code, but nothing in the window
turns them on. They cannot be used yet.

Skills are read from a file, but nothing in the window writes them. You have to
edit the file by hand.

The download itself is checked against a checksum pinned inside the app. That
catches a damaged or swapped file, but there is no signature chain behind it.

## What your computer needs

The model runs on your graphics card, and there is no fallback that runs it on
the processor. The app measures what the card has free the first time it starts
and picks a size for you.

About 4 GB of free video memory runs the smaller size, which the app calls Low,
with a 16K window of conversation. About 6 GB runs the larger one, High, with a
32K window, or roughly twice as much conversation. Between those the smaller size
runs with a shorter window. Below about 2 GB, or with no usable graphics device,
the model cannot run at all and the app says so.

You can force either size in Settings. The app warns you when the choice looks too
big for the card, and lets you try it anyway.

The rest it wants:

- A 64-bit version of Linux, Windows or macOS. The Linux and Windows builds use
  Vulkan, so the graphics driver needs to support it. macOS uses Metal.
- Disk space. The first download is about 2.7 GB for the smaller size and about
  4.5 GB for the larger one. Turning on search adds about 310 MB, or about
  555 MB more if you want it to search pictures and sounds. Leave about 3 GB
  free for the smaller size, or about 6 GB if you use the larger one with search.
- The Windows and macOS installers are not built yet, so Linux is the only
  platform with something you can run today.

A couple of suggestions. Close games and video editors before you switch to the
larger size, since they use the same video memory. Keep the app's data folder on
a disk with a few gigabytes free, because the model and the search index both
live there.

## For developers

The design decisions, the code layout, and how to build a release are in
[TECHNICAL.md](./TECHNICAL.md). The blunt working notes, including the rules that
are easy to break, are in [AGENTS.md](./AGENTS.md).

## Licence

MIT. See [LICENCE](./LICENCE).
