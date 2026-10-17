<p align="center">
  <img src="./apps/desktop/public/marimo-logo.png" alt="Marimo Bot" width="180" />
</p>

# Marimo Bot

A desktop AI assistant that lives on your own computer.

> [!WARNING]
> Marimo Bot is under construction. It is developed in the open and changes often, and some of those changes are breaking: what one build saved, the next may rewrite or refuse. Download and run it at your own risk, and keep your own copies of anything you care about.

I built Marimo Bot to sit on your machine and work inside a folder you choose.

Point it at a folder and that folder becomes a Space. It can read and write the files there, and its file tools cannot see anything outside it. The chats you start in that Space, the documents in it, and the bots you keep for that work stay together.

It shows up twice: a chat window, and a small moss ball that floats above your other windows. They share one conversation, so a question asked at the moss is in the window when you come back.

The app carries no chat model. The first time you open it, it asks: which service should write the answers? It cannot answer until you choose one.

## What it can do

The short version: it works in a folder, remembers what matters, and keeps bots for the work you repeat.

### A folder that becomes a Space

Load a folder and it becomes a Space. The chats you start there are filed under it, and every new chat remembers the Space it started in.

The Documents drawer lists the markdown already in that folder and edits it in place. There is no import and no second copy. Ask about a file by name, or let a bot write one and watch the same file appear in the drawer. A conversation can be saved as a document too, with each message under its author's name, so the transcript you were reading becomes a file in the folder you can edit.

What happens when a file has changed since you opened it? The save is refused, the draft stays on screen, and you choose which version wins. A missing parent folder is not created for you, because a mistyped path should not leave a tree behind in somebody's project.

### Bots for the work you repeat

What kind of work do you repeat? That is what a bot is for.

A bot is a small agent with its own name, Role, Persona, tools, memory, conversations and, if you want, its own model and Space. All of that follows the bot when you pick it in the rail.

Every bot has two texts. The Role is the app's brief: what the bot is for, what it may claim, and the rules every bot follows. The Persona is yours: the character, the job in your words, and how you want to be spoken to. The Persona is read after the Role, so it wins on tone. The operating rules come after both, so a Persona cannot talk a bot into a tool it was not given.

Start from a role and you get a name, a Role, a first Persona, a set of abilities and an icon in one click. You can change the name before you make it. The six starter roles are Writer, Marketer, Researcher, Coder, Analyst and Personal assistant. You can also build one step by step, or choose Talk it through with Marimo.

The guided path opens a conversation with the first question already on screen: what do you want the bot to do? Marimo asks a few more, then drafts the bot. You see the name, Persona and abilities in a card, change the name, the starter role or the Persona if you want, and press Create. Nothing is made before that.

Bots sit at the top of the sidebar. Pick one to see its conversations. Settings shows its Role, Persona, tools and Space. The icon can be one of five shipped pictures, or one you upload. Several bots can share a chat. Type `@` to put a question to one of them. Ask Marimo Bot for a blog post and, if you let it, it can hand the writing to Writer. Writer's answer comes back into the same conversation under its own name, and any approval it needs is asked under the turn you are reading.

Removing a bot asks first and says what goes: the bot, its conversations, the jobs it had scheduled and what it remembered about you. Files it wrote inside your Spaces stay where they are. The last bot stays too, because something has to answer.

### Memory that follows you

It remembers what you tell it. Facts about you follow you between Spaces, and the conventions of a project stay with that project.

Settings shows every line it remembers and when it was written, so you can see what it has picked up and correct a wrong line. When an answer is wrong, **Not quite** under the reply records what was right instead. The next time the bot reads a conversation back, it proposes that correction for you to accept or drop.

Memory has a soft limit. The bot is told when it gets close, and it can prune what no longer matters. The file is plain markdown, so you can read it without the app.

### Recall: search by meaning

Press `Ctrl+K` and ask for a file by what it was about, even when you do not remember the words in it. A result shows how close the match is and whether the file has changed since it was indexed.

Recall runs on EmbeddingGemma 2, a 270M-parameter embedding model. The first time you turn it on, the app fetches a llama.cpp build and the model, which is why the download is large and why the index stays empty until it finishes. The text model is 310 MB. The image and audio projector is another 555 MB, and you only need it if you want to search pictures, sounds and video. It embeds on the processor, so the graphics card is not involved.

You choose what it searches: the folder, what the bot remembers, past conversations, and media once the projector is there, so you can keep the index small or search everything you have. When a Space is loaded, the index is written inside it, under the agent's own folder, and it grows with the work.

It is off until you turn it on.

### Dream-RSI: record how it decides

Dream-RSI records what the bot tried on each turn. Which tools it was offered, which it called, with what arguments, and how each call turned out. The record is one tree per conversation, written inside the app's data, and it is off by default, so an install that never turns it on writes no such file at all.

Why would you want that? To compare search settings on your own work instead of guessing. The card has two numbers. The exploration weight says how much an untried tool is worth, and at 0 the bot only repeats what has worked, while at 1 the first choice stays with the model. The pruning threshold says when a tool that keeps failing stops being offered, and the default prunes nothing, because an agent that quietly loses a tool still answers, and the answer looks fine.

The card also shows the replay command. From a checkout it is:

```bash
pnpm --filter @marimo/desktop replay:dream
```

The replay reads your recorded turns and re-decides them under other settings without calling a model, which means you can compare settings on your own work without spending a token or waiting for an answer. It shows what each setting would have hidden. It cannot show what would have happened next, because the bot picks each step from the result of the last one.

### Long conversations

Once a conversation grows past a set size, the older part is replaced with a summary the model writes, so the request stays small while the file on disk keeps every message. What happens to the messages the model stops seeing? They are still in the transcript. **Compact** in the composer's `+` menu does the same on your terms.

### Tools you grant

It can search the web, fetch a page you name, read and write files in the Space, remember things, and schedule jobs. Each one is a switch you can turn off when you do not want it. Settings shows the list in plain words, and a tool that is off is not offered to the model at all.

A connector adds tools from a server you set up. Each bot has its own grant, and a connector that is not ticked is not offered to that bot.

### Jobs that keep going

What happens while the window is closed? A scheduled job keeps going. Schedule a task, such as a summary every morning, and the app keeps it running after you close the window. The app stays in the tray, and the rail has a switch called Keep jobs running when the app is closed that installs a background service so a timer can wake the runner.

The runner is the same binary started as plain Node, so it behaves like the app, reads the same files and takes the same lock. The app and the runner are serialised by that lock, so a scheduled job and an open window cannot run a turn in the same conversation at once.

Closing the window does not quit Marimo Bot.

Quit from the tray menu.

### The desktop companion

The moss ball is another way into the same conversation. It floats above your other windows with its own chat bar, so you can ask something small without opening the window. It shares the conversation, so anything you say to it is there when you open the window.

Settings lets you choose how brief its answers are, how many messages float above it, whether it stays on top, and whether the window stops taking clicks where there is nothing to click.

## Providers, models, and keys

The app carries no chat model of its own. It talks to one of five services: DeepSeek, Google Gemini, OpenCode Go, OpenRouter, or a llama.cpp server you run yourself. The hosted services need an account and an API key. A llama.cpp server needs an address and, on your network, nothing leaves it.

**Fetch Models** asks the service what it serves, so you choose from its current list. Until you ask, the app lists the names it ships with. A model name means nothing without the service that serves it, so the app keeps the pair together, which is why the picker asks for both and why moving a conversation to another service is a change of model as well. Which model should a bot use? That is yours to decide. You can point a bot at its own model, or a single conversation at another one.

Keys go into your operating system's keychain, encrypted, when the OS has one, and a key that cannot be decrypted is a key the background runner cannot use. A machine without a keychain can only store a key readable. A scheduled job runs with no window, so it has no keychain. The box "Let scheduled jobs use this key while the app is closed" stores the key readable instead, and that is what makes a hosted provider work in the background. Leave it off unless jobs have to run while the app is closed. A key stored readable is readable by anything that can open the file.

### Connectors

A connector is an MCP server you add in Settings. MCP is the Model Context Protocol, a way for a tool server to tell the app what it can do. A connector can give a bot tools that live on another machine or in another service entirely: a database, an issue tracker, a service on your network.

A connector's secret is kept the same way as a provider key. The runner can only use a connector secret that was stored readable, with your consent.

## How it stays under your control

A command, or a write over a file that already exists, waits for your answer first, and the request survives a restart so closing the window does not lose the question. A new file is written without asking. A scheduled job that hits an approval stays paused, because an unattended run never answers its own gate.

Every built-in tool is a switch in Settings. A tool that is off is not offered to the model at all. That is different from a suggestion the model may ignore.

Settings is one screen. It holds the bots, the Role and Persona, what each bot can do, the desktop companion, commands, the provider, memory, Recall, connectors, Dream-RSI, and Reset Marimo Bot.

## Privacy

Where do your words go? The answer depends on which service you chose. On a llama.cpp server of your own, nothing you type leaves the machine or your network, which is the reason the local option exists at all. On a hosted service, your conversations go there under your account and its terms. The provider card says which one you are on.

Other traffic is only what you ask for. A web search sends the query to DuckDuckGo. A connector you set up talks to the server you configured. **Fetch Models** asks the provider what it serves. When you turn Recall on, the app fetches the engine and EmbeddingGemma 2 once, then the index stays local.

Marimo Bot keeps its own data in one folder. On Linux that is `~/.config/Marimo Bot`, and on the other platforms it is the usual application-data folder, which is where your conversations, the Spaces you loaded and your settings live. Keys are in the OS keychain when there is one. A key you let the background runner read is stored in that folder instead.

A Space's documents are not in the app's folder. Those are your files, read and written where they are.

Recall and Dream-RSI are off until you turn them on, and neither sends its record anywhere. Reset Marimo Bot, at the bottom of Settings, erases the app's folder, switches off start-at-login and the background job timer, and quits so that opening it again is a first run. There is no undo.

There is no account with Marimo Bot.

## Getting started

There is no public download yet. The Linux version builds to a self-contained AppImage. The Windows and macOS installers are written but not built. If someone gave you the app, or you built it yourself, opening it starts a short setup.

The first step is the model. Which service should answer? Pick one, or point the app at a llama.cpp server you run. A hosted service needs an account and a key. **Fetch Models** asks it what it serves. The model comes first because the guided bot builder needs something to answer. The app will not continue without one. Set this up later closes the flow and leaves you with the short card that opens Settings.

Then the Space. Choose the folder Marimo Bot may read and write. It can see nothing outside it, and every chat is filed under the Space it started in. You can skip this and load a folder later.

Then the bot. Start from a role, build it step by step, or talk it through with Marimo. The step-by-step path asks for a name, a starting role if you want one, and what the bot may do, and then it creates the bot and moves on to the Persona. The abilities are plain choices: Just chat, Help around my computer, Do things for me. The last one writes files, fetches a page you name and sets up jobs. A new file is written straight away. Replacing one that is already there asks you first, and so does running a command.

The guided path is a normal conversation. Marimo asks what the bot is for, what it should sound like, and how you want to be spoken to, one question at a time. Then it drafts the bot and shows you the card. You can change the name, the starter role and the Persona, and say whether Marimo Bot may hand it work, before you press Create. Nothing is made until you do.

Then the Persona. The starter text is already there. Change it or keep it. It is the bot's character, the job in your words, and how you want to be spoken to. You can change it later, and the app will not reset it on its own.

Then more bots, or finish.

One bot is enough for most days.

Marimo Bot alone is useful too. Settings is where you make another one later.

After setup, Settings is one screen, the bots and Spaces are in the rail, `Ctrl+K` opens Recall, and the app stays in the tray until you quit it from there.

## What is not finished yet

- The Windows and macOS installers are written but not built. Only the Linux AppImage has been run.
- There is no auto update, so a new version is a file you download again.
- Discord and the notes and to-do tools exist in the code, but nothing in the window turns them on yet.
- Skills are read from a file, and nothing in the window writes them. You edit that file by hand.
- The recall model and the engine archive are checked against checksums pinned inside the app, which catches a damaged or swapped file. There is no signature chain behind them, and no other model is downloaded.

## What your computer needs

The app is small because it runs no chat model. What your machine has to do depends on the service you pointed it at. A llama.cpp server you run yourself wants the graphics card, and it can be another machine on your network. A hosted service wants a connection and your key.

The one model the app runs itself is Recall, and only once you turn it on, so a fresh install downloads nothing until you ask for it. It embeds on the processor, so the graphics card is not involved in that, which means a laptop without a discrete GPU can still search its own files by meaning. The first time you turn it on it downloads about 310 MB for the text model, or about 555 MB more if you want pictures, sounds and video searched as well.

- A 64-bit version of Linux, Windows or macOS. Linux is the only one with a built installer today.
- About 310 MB for the recall model, 555 MB more for media, plus an index that grows with the folder you point it at.
- An account and a key with a hosted service, if that is what you picked. A llama.cpp server needs no key.
- If you run llama.cpp on this machine, close games and video editors before starting it, since the weights and the game want the same video memory.

Go build your next thing with it.

## For developers

The design decisions, the code layout and how to build a release are in [TECHNICAL.md](./TECHNICAL.md). The blunt working notes, including the rules that are easy to break, are in [AGENTS.md](./AGENTS.md).

## Licence

Apache-2.0. See [LICENCE](./LICENCE) and [NOTICE](./NOTICE).
