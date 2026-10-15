# Marimo

A desktop AI assistant that lives on your own computer.

Marimo is a desktop app with two faces. There is a chat window, and there
is a small moss ball that floats on your screen and answers in a speech bubble.
It carries no model of its own: the first time you open it, it asks which service
should write the answers — one you have an account with, or a llama.cpp server
you run yourself — and it says nothing until you choose.

## What it can do

Ask it a question and the answer streams in as it is written, with the thread of
the conversation kept.

Load a folder and it becomes a Space. A Space is a folder with everything that
belongs to it: the chats you start in it, the documents in it — the markdown files
it already holds, listed in a drawer beside the chat and editable in the window —
and the bot you keep for that work. There is no import and no second copy, which
is the point: a file the bot writes with its own tools is in that list, and the
paragraph you type is what the bot reads next. It cannot see anything outside
the Space.

You are not limited to one bot. Settings has **+ New bot**, and a new one gets
a name, an identity you write, its own tools, the Spaces it works in, and — if you
want — a model of its own rather than the app's default. That is how you end up
with a Writer that drafts into the website folder and a Researcher you send off to
read things.

Several of them can share one chat. The first is the lead and answers by default;
type `@` and pick a name to put a question to somebody else. The lead can also
hand work over by itself — ask it for a blog post and it can tell Writer to write
it — and the writer's answer comes back into the same conversation, under its own
name. If a helper needs your permission for something, the card appears in the
chat you are already looking at.

Web search is there for questions that need something current.

Things you tell it, such as a preference or how a project is set up, are
remembered and brought up in later conversations. What it learns about *you* — a
name, an animal, how you like to be talked to — follows you between Spaces, while
the rules of a particular project stay with that project.

If an answer is wrong, say so: there is a small "Not quite" under every reply
where you can add one line about what was right instead. It is not written into
memory directly — the next time the bot reads a conversation back it proposes
that fact, and you decide. Settings shows you everything it remembers and when
each line was written, so you can see what has been sitting there a while.

It can also find a file or a note from a description of what it was about, even
when you do not know the words in it. This one is off until you turn it on,
because it brings its own model, fetched the first time you ask for it. Once it
is on, press `Ctrl+K` and describe what you are looking for.

If you are curious about how it decides what to do, there is a recording you can
turn on. With it on, every turn is written down as a tree: which tools it was
offered, which ones it asked for, which ones it ran and how each one turned out.
Nothing about that is sent anywhere and it is off by default, because it is a
record of your work. The point of it is the command in Settings — it replays your
own recorded turns under different search settings, without calling a model at
all, and shows what each setting would have hidden. It tells you what it would
have *withheld*, not what would have happened next: the bot picks each step
from the result of the last one, so a different setting is a different
conversation.

Scheduled tasks, such as a summary every morning, keep running after you close
the window.

The moss ball and the chat window share the same conversation. Ask something at
the moss ball and you can read it in the window later.

## Getting started

There is no public download page yet. The Linux version builds to a
self-contained AppImage; the Windows and macOS installers are not built. If
someone gave you the app, or you built it yourself, this is what happens when you
open it.

The first time you start it, it asks which service should answer, because this
app does not carry a model of its own. There are five to choose from, and one of
them is the one that keeps everything on your machine: a
[llama.cpp](https://github.com/ggml-org/llama.cpp) server you run yourself, at an
address you type. The others — DeepSeek, Google Gemini, OpenCode Go, OpenRouter —
need an account and an API key, and their screens say what that key is and where
to get it. Whichever you pick, the card has a **Fetch Models** button that asks
the service what it serves, so you choose from the list it reports rather than
from a list this app guessed at.

Keys are kept in your operating system's keychain, encrypted. The card also has
one box you may never need: **let the background runner read this key**. A
scheduled task runs without a window, so it has no keychain to unlock — if you
want a task to run on a service rather than on your own server, that box is what
makes it possible, and it means the key sits on disk readable. It is off unless
you tick it.

Then load a folder. The app calls it a Space, it can read there and nowhere else,
and a chat is filed under the Space it started in so you can keep projects apart.
The markdown files in it are the Space's documents, which the **Documents** button
above the chat lists and opens.

Next, choose how much it may do. There are three choices in plain words: "Just
chat", "Help around my computer", and "Do things for me". You can change this at
any time, and the same screen is where a second bot is made.

Anything that changes something on your machine, such as writing a file or
running a command, shows you what it wants to do and waits for your approval.
That request survives a restart, so closing the window does not lose it.

Closing the window does not quit the app. It stays in the system tray so the moss
ball and any scheduled tasks keep working, and you quit it from the tray menu.

## Everyday use

Ask about your files by naming the file or the folder, for example "what does the
retry code in upload.ts do?".

Press `Ctrl+K` to search the Space by meaning. Each result shows how close the
match is, and says when a file has changed since it was indexed.

The **Documents** button above the chat opens a column beside it: the Space's
files listed at the top, the one you pick underneath, and what you type saved as
you go. A bot writing to the same file at the same time does not cost either
of you your work. If the file moved since you opened it, the save is refused,
your draft stays on screen, and you choose whether to reload their version or
write yours over it.

The example worth walking through is the blog post. Say you have a Writer whose
Space is the website folder. You ask the lead bot for a post about last week's
outage and tell it to hand the writing over. Writer's name goes up over what it
says, and its file writes show up under it as its own work rather than as the
lead's. When it wants to save the draft it asks you, in this chat, under the turn
you are reading. When it finishes, the post is in the folder — and the Documents
drawer is showing the same file the bot just wrote.

The moss ball floats above other windows. You can drag it, ask it something from
the bar underneath, and change how long its answers are or whether it stays on
top in Settings.

There are two versions of the settings screen. Simple has the bot's name and one
choice about what it may do. Power user shows everything, including the
temperature and every tool as its own switch. Which service answers is on both,
because an app with no model of its own has to be fixable from the screen a first
run lands on. Connecting a tool from somewhere else is on both screens too: a
capability you have should not be behind a switch you have not turned on yet.
Deciding which of those tools each bot may use is in power, because that is one
switch per bot per connector. One switch moves between the two screens, and
neither is a different app.

When a conversation gets long, you can compact the older half into a summary from
the `+` menu. The messages stay in the conversation file; the bot simply stops
being sent them.

## Your files and privacy

**What answers decides where your words go, and the app says which.** If you
picked a llama.cpp server on your own machine, nothing you type leaves it. If you
picked one of the hosted services, your conversations go to that service under
your own account and its terms — which is the trade the app makes visible on the
provider card rather than in a footnote. Two other things go over the network,
and only when you use them: a web search sends your query to DuckDuckGo and reads
the results, and a connector you set up talks to the server you configured.

Your data lives in one folder. On Linux that is `~/.config/Marimo Agent` — the
folder keeps the name the app had before it was called Marimo, so an install that
predates the rename keeps everything it had. It holds
your conversations, the folders you have loaded, your settings and your keys. You
can move it with the `MARIMO_USER_DATA_DIR` environment variable, and you can
delete it to start over — the service you chose is asked for its key again the
next time you open the app, which is also what makes this folder safe to hand to
somebody else once the key files are gone. If you turned the recording on, that folder also holds one file per
conversation of what the bot tried; a conversation's file is moved aside when
you delete the conversation, so the record does not outlive the chat it is about.
A Space's documents are not in there at all: those are your own files, in your own
folders, and the app reads and writes them where they are.

Connector passwords and tokens are kept in the operating system's keychain,
encrypted, and so is the key for the service you chose. If the machine has no
keychain, the app says so and refuses to store the secret rather than writing it
somewhere readable — unless you ticked **let the background runner read this key**
for that one, which is you accepting that it sits on disk readable.

## What is not finished yet

The Windows and macOS installers are written but not built. Only the Linux
AppImage has been packaged and run.

There is no auto update, so a new version is a file you download again.

Discord and the notes and to-do tools exist in the code, but nothing in the window
turns them on. They cannot be used yet.

Skills are read from a file, but nothing in the window writes them. You have to
edit the file by hand.

The search model's download is checked against a checksum pinned inside the app.
That catches a damaged or swapped file, but there is no signature chain behind it.
Nothing else is downloaded: there is no chat model to fetch.

## What your computer needs

The app itself is small, because it runs no model of its own. What your machine
has to be able to do is a question about the service you pointed it at. If you
chose a llama.cpp server you run yourself, the graphics card is that server's
requirement rather than this app's, and a server on another machine on your
network is fine — the app only needs its address. If you chose one of the hosted
services, the work happens on their machines and all this app needs is a
connection and your key.

The one thing that does run here is search, and only once you turn it on. It
embeds text on the processor rather than the graphics card, so it does not care
what card you have, and the first time it downloads about 310 MB — or about
555 MB more if you want it to search pictures, sounds and video as well.

The rest it wants:

- A 64-bit version of Linux, Windows or macOS. The search engine's builds use
  Vulkan on Linux and Windows and Metal on macOS, so that driver has to be able
  to load; nothing else here wants a graphics card.
- Disk space. A few gigabytes free is plenty: a few hundred megabytes for the
  search model, and an index that grows with the folder you point it at.
- An account and a key with a hosted service, if that is what you picked.
- The Windows and macOS installers are not built yet, so Linux is the only
  platform with something you can run today.

If you run your own llama.cpp server on this machine, close games and video
editors before starting it: the weights and the game want the same video memory.
Keep some room on the disks you index, too, since the search index is written
beside the folder it describes rather than into the app's own directory.

## For developers

The design decisions, the code layout, and how to build a release are in
[TECHNICAL.md](./TECHNICAL.md). The blunt working notes, including the rules that
are easy to break, are in [AGENTS.md](./AGENTS.md).

## Licence

MIT. See [LICENCE](./LICENCE).
