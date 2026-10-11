/**
 * Stored conversations, the third corpus the recall index answers from.
 *
 * The three sources are not the same kind of thing, and that is what shapes this
 * file. The folder is files somebody edits; memory is a document the agent
 * maintains; a conversation is an append-only log that grows a turn at a time. The
 * first half here turns that log into text a vector can stand for, and the second
 * half remembers how much of each log has already been embedded.
 *
 * **Two jobs in one file because they are one story.** What "already embedded"
 * means is decided by what `renderConversationText` counts as content, so a
 * watermark that counted events differently from the renderer would skip text or
 * embed it twice — and neither failure says anything out loud.
 *
 * Rendering drops more than it keeps, and each omission is deliberate:
 *
 * - **`thought` parts are the model's reasoning.** It is replayed to the provider
 *   because DeepSeek rejects a tool-carrying turn without it (invariant 4), but it
 *   is not what anyone said. Embedded, it makes a search hit quote the model
 *   talking to itself, and it is often the longest text in the event.
 * - **`functionCall`/`functionResponse` parts are tool payloads**: schemas, file
 *   contents, JSON. They are the largest and least conversational parts of a
 *   session, and a vector averaged over them matches every tool-call log about
 *   equally.
 * - **An event left with no visible text contributes nothing at all**, not even its
 *   `AGENT:` label. A tool-call event rendered as an empty line is noise a search
 *   returns and a person has to read past.
 *
 * The watermark store is a *cache*, not user data, and that is why it is the one
 * store here that is not version-guarded. The vectors it describes live in an index
 * that can always be rebuilt from what is still on disk, so an unreadable or newer
 * file is rewritten rather than refused. `store.ts` says the same thing about the
 * index itself, and for the same reason: nothing of the user's is in here to lose.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {withFileLock} from '../lock.js';

/**
 * One stored session event, structurally.
 *
 * Loose and optional on purpose: this is the shape ADK writes to the session file,
 * and the reader is given exactly the fields it looks at rather than a full event
 * type that would have to be kept in step with another package. Anything absent or
 * of the wrong type is simply nothing to render.
 */
export interface ConversationEvent {
  /** `'user'`, or the agent's (or a helper's) name. */
  author?: string;
  content?: {
    parts?: Array<{
      text?: string;
      thought?: boolean;
      functionCall?: unknown;
      functionResponse?: unknown;
    }>;
  };
}

/**
 * The `path` a conversation record carries.
 *
 * Not a path at all, and named the way `MEMORY_SOURCE` is so nobody mistakes it for
 * one: a conversation is a session file outside the indexed folder, and a record set
 * that mixed the two would send `resolveInsideWorkspace` after a file called
 * `(conversation)`. It differs from `MEMORY_SOURCE` because a search result has to
 * say which corpus it came from, and a memory bullet and a conversation are not the
 * same answer.
 */
export const CONVERSATION_SOURCE = '(conversation)';

/**
 * How much conversation text one embedding request carries.
 *
 * `chunk.ts` cuts a file at 800 characters because a chunk has to be *showable* as
 * a range of lines. A conversation is embedded as a run of whole events with no
 * range to report, so the bound here is the request rather than a display: 6,000
 * characters is roughly 1,500 tokens, comfortably inside the engine's 4,096-token
 * physical batch once the task prefix is added. Larger would mean a request the
 * engine can refuse or silently truncate — and a truncated message is a message the
 * index believes it holds.
 */
export const MAX_CONVERSATION_CHARS = 6000;

/**
 * The visible text of a conversation, or `''` when nothing visible was said.
 *
 * Each surviving event is labelled and the events are joined by a blank line, so a
 * reader (which is usually a search result, not a person) can tell who said what
 * without a second field to carry it.
 */
export function renderConversationText(
  events: readonly ConversationEvent[],
): string {
  const lines: string[] = [];
  for (const event of events) {
    const rendered = renderedEvent(event);
    if (rendered.length > 0) {
      lines.push(rendered);
    }
  }
  return lines.join('\n\n');
}

/** One event's line, or `''` when it has no visible text. */
function renderedEvent(event: ConversationEvent): string {
  const text = visibleText(event);
  if (text.length === 0) {
    return '';
  }
  return `${event.author === 'user' ? 'USER: ' : 'AGENT: '}${text}`;
}

/**
 * The text parts of one event that a person would have seen.
 *
 * The tests are ordered so the cheapest reason to drop a part wins, but the order
 * only matters for a part that is more than one of these at once — a text part that
 * also carries a tool call, which a provider can emit. Dropping it is the right
 * answer: the text is usually a one-line preamble to the call, and keeping it would
 * make a tool call look like something the agent chose to say.
 */
function visibleText(event: ConversationEvent): string {
  const parts = event.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object') {
      continue;
    }
    if (part.thought === true) {
      continue;
    }
    if (part.functionCall !== undefined || part.functionResponse !== undefined) {
      continue;
    }
    if (typeof part.text !== 'string' || part.text.length === 0) {
      continue;
    }
    texts.push(part.text);
  }
  /*
   * A newline between parts rather than nothing: parts are the separate blocks the
   * model produced in one event, and joining them flush turns the end of a sentence
   * into the start of the next. The trim is what makes a whitespace-only part — and
   * an event made only of one — contribute nothing, which the caller relies on.
   */
  return texts.join('\n').trim();
}

/** A run of whole events, and where the next slice should start. */
export interface ConversationSlice {
  text: string;
  /** Exclusive: the index just past the last event included. */
  endEvent: number;
}

/**
 * The next run of events to embed, cut at a character budget.
 *
 * Whole events, never half of one, because the watermark below is per event: a slice
 * that embedded half a message and recorded an event boundary would lose the other
 * half forever. That is also why the blank line between events is counted here — it
 * is part of the text that is embedded, so leaving it out of the budget is how a
 * slice comes back a few characters over the cap every time.
 *
 * Two rules make progress possible rather than merely correct:
 *
 * - **Events with nothing visible are included and cost nothing.** They advance
 *   `endEvent` without going into the text, which is what lets a run of tool calls
 *   be stepped over in one call instead of being re-examined forever. When that run
 *   is all that is left, the answer is `{text: '', endEvent: events.length}` — the
 *   honest "there was nothing here", with the watermark moved past it.
 * - **The first visible event is included whatever it costs.** A single long message
 *   is the only thing said, and dropping it because it is longer than the cap would
 *   lose exactly the content the cap exists to carry a piece of. It is embedded
 *   over budget rather than dropped; the events after it wait for the next slice.
 */
export function conversationSlice(
  events: readonly ConversationEvent[],
  start: number,
  maxChars: number,
): ConversationSlice {
  const from = Math.min(events.length, Math.max(0, Math.trunc(start)));
  let text = '';
  let visible = 0;
  let endEvent = from;

  for (let index = from; index < events.length; index += 1) {
    const rendered = renderedEvent(events[index] as ConversationEvent);
    if (rendered.length === 0) {
      endEvent = index + 1;
      continue;
    }

    const separator = visible > 0 ? 2 : 0;
    if (visible > 0 && text.length + separator + rendered.length > maxChars) {
      break;
    }
    text = visible > 0 ? `${text}\n\n${rendered}` : rendered;
    visible += 1;
    endEvent = index + 1;
  }

  return {text, endEvent};
}

/**
 * The format's version.
 *
 * Bumped only when a reader would read an old file wrongly. Until then a parse that
 * ignores what it does not know is the whole upgrade story — and an unreadable or
 * too-new file costs a re-embed rather than anything the user can notice.
 */
const WATERMARK_VERSION = 1;

export interface ConversationWatermarkStoreOptions {
  /** Where the document lives — beside the index it belongs to. */
  file: string;
}

/**
 * How many events of each conversation have already been embedded.
 *
 * The vectors are in `index.json`; this is the bookkeeping that stops a refresh
 * re-embedding a conversation that has not changed. It is stored rather than kept in
 * memory for the same reason the index is: a refresh is a slice, the app and the
 * headless runner both take slices, and a process that restarted mid-conversation
 * must not start from the top.
 *
 * **Not version-guarded, and that is the design.** `readVersionedDocument` exists so
 * a newer file is never overwritten, which is right for a document the user would
 * lose. This one describes vectors that can be rebuilt from the sessions still on
 * disk, so a newer or unreadable file is a reason to start over, not a reason to
 * refuse. `store.ts` makes the same argument for the index itself.
 */
export class ConversationWatermarkStore {
  private cache: Record<string, number> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ConversationWatermarkStoreOptions) {}

  /**
   * The counts, and `{}` for every reason there are none.
   *
   * Lenient to the point of silence: an absent file, a parse error, a version this
   * build does not know and a document that is not shaped like one all answer empty.
   * The alternative — refusing — would stop a refresh over a file whose only content
   * is a hint about work that can be redone.
   */
  async load(): Promise<Record<string, number>> {
    if (this.cache === undefined) {
      this.cache = await this.read();
    }
    /*
     * A copy, so a caller that edits the result edits its own object. Handing out the
     * cache would let a mutation in memory diverge from the file with nothing to say
     * it had — the kind of difference that is only ever found by reading the JSON by
     * hand.
     */
    return {...this.cache};
  }

  /** How many events of one conversation are already in the index. */
  async embeddedUpTo(sessionId: string): Promise<number> {
    const embedded = await this.load();
    return embedded[sessionId] ?? 0;
  }

  /**
   * Replaces the map wholesale.
   *
   * Wholesale rather than merged because the caller built it by walking the sessions
   * that exist: a conversation that is gone is simply not in the map, which is how it
   * loses its count. A merge would keep the entry and re-embed a deleted
   * conversation's id forever.
   */
  async save(embedded: Record<string, number>): Promise<void> {
    await this.mutate(() => embedded);
  }

  /** Drops the counts for sessions that no longer exist. */
  async forget(sessionIds: readonly string[]): Promise<void> {
    await this.mutate((current) => {
      const next = {...current};
      for (const sessionId of sessionIds) {
        delete next[sessionId];
      }
      return next;
    });
  }

  private async read(): Promise<Record<string, number>> {
    let raw: string;
    try {
      raw = await readFile(this.options.file, 'utf8');
    } catch {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const document = parsed as {version?: unknown; embedded?: unknown};
    /*
     * Anything but this build's version answers empty and is then overwritten by the
     * next write. Unlike every other document in the app, a newer file here is not a
     * refusal: there is no user data in it, and the only cost of starting over is
     * re-embedding text that is still in the session store.
     */
    if (document.version !== WATERMARK_VERSION) {
      return {};
    }
    if (
      document.embedded === null ||
      typeof document.embedded !== 'object' ||
      Array.isArray(document.embedded)
    ) {
      return {};
    }
    return usableCounts(document.embedded as Record<string, unknown>);
  }

  private async mutate(
    edit: (current: Record<string, number>) => Record<string, number>,
  ): Promise<void> {
    return await this.withQueue(async () => {
      /*
       * The filesystem lock as well as the queue above, because the queue is only
       * this process's. The app and the headless runner both refresh this index, and
       * two writers read-modify-writing one file without it would lose a watermark —
       * which, because this is a cache, costs a repeated embedding rather than a lost
       * conversation, but a count that went backwards would never be noticed either.
       */
      await withFileLock(`${this.options.file}.lock`, async () => {
        const next = usableCounts(edit(await this.load()));
        await this.write(next);
        this.cache = next;
      });
    });
  }

  /**
   * The document, written to a temporary file and renamed.
   *
   * The parent directory is created here as well as in `withFileLock`, which only
   * makes the one for its own lock file: a store refreshed before the index exists
   * would otherwise fail on the first save with an ENOENT that says nothing about
   * what was being done. The rename is what makes the file all-or-nothing, so a crash
   * mid-write cannot leave a count that parses and is wrong.
   */
  private async write(embedded: Record<string, number>): Promise<void> {
    await mkdir(dirname(this.options.file), {recursive: true});
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({version: WATERMARK_VERSION, embedded}, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, this.options.file);
  }

  private async withQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

/**
 * The counts a reader will accept.
 *
 * A zero and a negative are the same thing here — "nothing embedded" — and a NaN
 * that survived a bad write is worse than either: every comparison against an event
 * index is false, so the conversation would be embedded from the start on every
 * refresh forever. Dropping them on the way in as well as on the way out means the
 * file never holds a count its own reader would ignore.
 */
function usableCounts(embedded: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [sessionId, value] of Object.entries(embedded)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    counts[sessionId] = value;
  }
  return counts;
}
