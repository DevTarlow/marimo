/**
 * Building the index, and keeping it up to date without rebuilding it.
 *
 * The job is the same one every search index does, and the two things that make
 * it interesting here are the ones this app is shaped around.
 *
 * **It is bounded, and it says so.** Embedding a folder means one pass of a 270M
 * model over every chunk of every file in it — on a processor, tens of
 * milliseconds each, thousands of chunks. So a refresh does a *slice*: the file
 * budget below stops it, `truncated` says it stopped, and the next call continues
 * where this one left off, because what was done is on disk. Anything else would
 * be a tool call that runs for ten minutes, or a background job with no way to
 * tell whether it finished.
 *
 * **A file is settled by its stamp, not its contents.** Size and modification time
 * are what decide whether a file has to be re-embedded, because hashing every file
 * on every refresh is the cost this is avoiding. That is a judgement with a known
 * hole — an edit that leaves both size and mtime alone is invisible — and the hole
 * is closed where it matters instead: the chunk's own digest is stored with it, so
 * a hit from a file that did change is reported as *changed* rather than quoted
 * from a stale copy. Being briefly out of date is fine; showing text that is no
 * longer in the file is not.
 */
import {readFile, stat} from 'node:fs/promises';
import {relative, sep} from 'node:path';

import {MAX_FILE_BYTES, splitMemory, walkFiles} from '@marimo/agent';

import {chunkText} from './chunk.js';
import type {EmbeddingPart} from './client.js';
import {
  CONVERSATION_SOURCE,
  conversationSlice,
  MAX_CONVERSATION_CHARS,
} from './conversations.js';
import type {ConversationEvent} from './conversations.js';
import {MAX_MEDIA_BYTES, mediaKindOf} from './media.js';
import type {MediaKind} from './media.js';
import {documentText} from './prefixes.js';
import {
  digestOf,
  emptyIndex,
  MEMORY_SOURCE,
  MAX_RECORDS,
  normalize,
  readIndex,
  writeIndex,
} from './store.js';
import type {FileStamp, IndexData, IndexModel, IndexRecord} from './store.js';

/**
 * How many files one refresh will embed.
 *
 * A judgement, and the reasoning is the engine rather than the disk: a file is one
 * embedding request, and a request is measured in tens of milliseconds for a
 * chunk. Four hundred files is around a minute on a processor — long enough to be
 * worth doing in one go, short enough that a caller can be told it will finish.
 */
export const REFRESH_FILES = 400;

/** How many chunks one refresh will embed, across all files. */
export const REFRESH_CHUNKS = 2_000;

/**
 * How many media files one refresh will decode and embed.
 *
 * Small, and it is not the same judgement as `REFRESH_FILES`. Text is tens of
 * milliseconds a chunk; a video is a decode, a seek per frame and one request
 * measured in *seconds* — a two-dozen-frame clip was timed at about nineteen on
 * a processor. A budget borrowed from the file count would be a first search
 * that takes minutes, which reads as a hang. Two is enough to make progress on a
 * folder of photos and short enough that a search still answers.
 */
export const REFRESH_MEDIA = 2;

/** How many conversations one refresh will embed a new stretch of. */
export const REFRESH_CONVERSATIONS = 60;

export interface IndexCoverage {
  /** Files whose text is in the index now. */
  files: number;
  /**
   * Files dropped by this refresh to stay under the record cap.
   *
   * Reported rather than silent: a search that quietly stopped covering part of
   * somebody's folder would answer as though the rest did not exist.
   */
  evicted: number;
  /** Text vectors the index holds. */
  chunks: number;
  /** Memory bullets the index holds. */
  memory: number;
  /** Conversation stretches the index holds. */
  conversations: number;
  /** Media files the index holds. */
  media: number;
  /** Files embedded by *this* refresh. */
  embedded: number;
  /** Files that need embedding and were left for the next refresh. */
  pending: number;
  /** Conversations with new events left for the next refresh. */
  pendingConversations: number;
  /** Whether a budget stopped this refresh before the folder was settled. */
  truncated: boolean;
  /** Files that could not be read, or were not text. */
  skipped: number;
}

/** One conversation, as the indexer reads it back. */
export interface ConversationSummary {
  sessionId: string;
  title: string;
  /** Stored events, including the ones with nothing visible to embed. */
  eventCount: number;
}

/** Everything the indexer needs to read a conversation, injected. */
export interface ConversationSource {
  /** The conversations that exist right now. */
  list: () => Promise<readonly ConversationSummary[]>;
  /** One conversation's stored events, or `undefined` when it is gone. */
  read: (
    sessionId: string,
  ) => Promise<{title: string; events: readonly ConversationEvent[]} | undefined>;
}

/** Everything the indexer needs to put a picture, a sound or a clip in. */
export interface MediaSource {
  /**
   * The content parts for one file.
   *
   * One content array rather than several, because a video is one point in the
   * space: its frames go in together, the way a text chunk's words do. The
   * caller owns the decoding — this package has no Electron — and it is where
   * the guide's own rules live: no task prefix on media, 16 kHz mono audio, and
   * one frame per second.
   */
  decode: (path: string, kind: MediaKind) => Promise<EmbeddingPart[]>;
  /** Media in, one vector out per input. */
  embedParts: (
    inputs: readonly EmbeddingPart[][],
  ) => Promise<{vectors: Float32Array[]}>;
}

export interface RefreshOptions {
  /** The folder being indexed; every stored path is relative to it. */
  workspaceRoot: string;
  /** Where `index.json` and `vectors.bin` live. */
  dir: string;
  /** The model that is pinned now. */
  model: IndexModel;
  /**
   * Turns text into vectors.
   *
   * Injected rather than imported, because the thing that can do it is a process:
   * the caller owns the engine's life, and this file owns only what to ask it for.
   */
  embed: (texts: readonly string[]) => Promise<{vectors: Float32Array[]}>;
  /**
   * The agent's memory file, as it is now.
   *
   * Read by the caller, which already has one definition of where memory lives —
   * this file would otherwise be a second opinion about it, and the two would
   * disagree the first time a profile moved.
   */
  memory?: string;
  /**
   * The conversations to index, and how far each has been embedded already.
   *
   * The watermark is a value in and a value out rather than a store this file
   * writes: the index is the commit point and the watermark is derived from it,
   * so whoever writes both owns the order. Absent means conversations are not
   * part of this index at all.
   */
  conversations?: ConversationSource;
  watermark?: Readonly<Record<string, number>>;
  /** The media decoder, when this install has the projector. */
  media?: MediaSource;
  maxFiles?: number;
  maxChunks?: number;
  maxMedia?: number;
  maxConversations?: number;
  /** The largest media file worth opening, in bytes. */
  maxMediaBytes?: number;
  /** How many vectors this index may hold before the oldest files are dropped. */
  maxRecords?: number;
  now?: () => Date;
  /** Told after each file, for a caller that reports progress. */
  onFile?: (path: string) => void;
}

export interface RefreshResult {
  data: IndexData;
  coverage: IndexCoverage;
  /**
   * Where each conversation has been embedded up to, after this refresh.
   *
   * Pruned to the conversations that still exist, which is what makes deletion
   * free: a chat that is gone is not in `list()`, so it is not in here, and the
   * store that persists this is what forgets it.
   */
  watermark: Record<string, number>;
}

/**
 * One slice of work: settle what changed, keep what did not.
 *
 * Returns the whole index rather than a diff, because the caller has to write it
 * and the write is atomic — a partial update would be the one shape that could
 * leave the file describing vectors that are not there.
 */
export async function refreshIndex(
  options: RefreshOptions,
): Promise<RefreshResult> {
  const {workspaceRoot, dir, model} = options;
  const now = options.now ?? (() => new Date());
  const maxFiles = options.maxFiles ?? REFRESH_FILES;
  const maxChunks = options.maxChunks ?? REFRESH_CHUNKS;
  const maxMedia = options.maxMedia ?? REFRESH_MEDIA;
  const maxMediaBytes = options.maxMediaBytes ?? MAX_MEDIA_BYTES;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;

  const usable = await readIndex(dir, model);

  const coverage: IndexCoverage = {
    files: 0,
    evicted: 0,
    chunks: 0,
    memory: 0,
    conversations: 0,
    media: 0,
    embedded: 0,
    pending: 0,
    pendingConversations: 0,
    truncated: false,
    skipped: 0,
  };

  /*
   * The index, as a map of source to records and the vectors that go with them.
   *
   * Rebuilt from the file rather than patched in place, because the vectors are
   * one flat array whose order *is* the record order: inserting a chunk in the
   * middle of a file means moving every vector after it, and a merge that got
   * that wrong would attach scores to the wrong text with nothing to show for it.
   */
  const kept = new Map<string, {stamp: FileStamp; records: IndexRecord[]; vectors: Float32Array[]}>();
  /*
   * Conversations are kept apart from `kept`, because they are not files: a chat
   * has no mtime to stamp and no byte cap to satisfy, and the thing that decides
   * whether it changed is how many events it has grown by.
   */
  const oldConversations = new Map<
    string,
    {records: IndexRecord[]; vectors: Float32Array[]}
  >();
  if (usable !== undefined) {
    const dims = usable.file.model.dims;
    for (const [at, record] of usable.file.records.entries()) {
      const vector = new Float32Array(usable.vectors.subarray(at * dims, (at + 1) * dims));
      if (record.kind === 'conversation') {
        const sessionId = record.sessionId;
        if (sessionId === undefined) {
          continue;
        }
        const entry = oldConversations.get(sessionId) ?? {records: [], vectors: []};
        entry.records.push(record);
        entry.vectors.push(vector);
        oldConversations.set(sessionId, entry);
        continue;
      }
      if (record.kind !== 'text' && record.kind !== 'media') {
        continue;
      }
      const entry = kept.get(record.path);
      if (entry === undefined) {
        const stamp = usable.file.files.find((file) => file.path === record.path);
        kept.set(record.path, {
          stamp: stamp ?? {path: record.path, size: -1, mtimeMs: -1},
          records: [record],
          vectors: [vector],
        });
      } else {
        entry.records.push(record);
        entry.vectors.push(vector);
      }
    }
  }

  /*
   * One walk, with a byte cap that depends on whether media is in play. The
   * default cap is what a *text* file may be — 256 KB, because that is all a
   * file's chunks ever need — and a photograph or a clip is routinely larger, so
   * a media install raises the ceiling for the walk and the loop below decides
   * per file which cap applies. Raising it unconditionally would be a text file
   * of a hundred megabytes read into memory to be chunked.
   */
  const walked = await walk(
    workspaceRoot,
    options.media === undefined ? undefined : Math.max(MAX_FILE_BYTES, maxMediaBytes),
  );
  const present = new Set<string>();
  const changed: Array<{
    path: string;
    absolute: string;
    stamp: FileStamp;
    media: MediaKind | undefined;
  }> = [];

  for (const absolute of walked) {
    const path = relative(workspaceRoot, absolute).split(sep).join('/');
    const stamp = await stampOf(absolute, path);
    if (stamp === undefined) {
      coverage.skipped += 1;
      continue;
    }
    const kind = mediaKindOf(path);
    if (kind !== undefined) {
      // Media is only present when there is a decoder for it, and only up to the
      // size the decoder is willing to open: a file that is too big is one this
      // refresh will never embed, so leaving it "present" would keep a stale
      // entry alive forever.
      if (options.media === undefined || stamp.size > maxMediaBytes) {
        continue;
      }
    } else if (stamp.size > MAX_FILE_BYTES) {
      // A text file past the cap is one the walk below would never have offered,
      // and calling it present would keep whatever it held before.
      continue;
    }
    present.add(path);
    const known = kept.get(path);
    if (
      known !== undefined &&
      known.stamp.size === stamp.size &&
      known.stamp.mtimeMs === stamp.mtimeMs
    ) {
      continue;
    }
    changed.push({path, absolute, stamp, media: kind});
  }

  // A file that is gone takes its vectors with it, and there is nothing to embed
  // to settle that — which is why deletion is applied before the budget below.
  for (const path of [...kept.keys()]) {
    if (!present.has(path)) {
      kept.delete(path);
    }
  }

  let chunksThisPass = 0;
  let mediaThisPass = 0;
  /*
   * The file budget counts *files*, and it is its own counter rather than
   * `coverage.embedded` because that field is the report and this is the budget:
   * media and conversations contribute to one and not the other, and a refresh
   * that spent its file allowance on chats would leave the folder unindexed for
   * no stated reason.
   */
  let filesThisPass = 0;
  for (const file of changed) {
    if (file.media !== undefined) {
      /*
       * Media is budgeted apart from files, and it is why a folder of
       * photographs can leave `pending` non-zero for several searches: one video
       * is a decode, a seek per frame and a request measured in seconds, and a
       * text-sized budget would make the first search take minutes. Both caps
       * still apply, so a refresh that has already spent its time on text does
       * not then start a clip.
       */
      if (
        mediaThisPass >= maxMedia ||
        filesThisPass >= maxFiles ||
        chunksThisPass >= maxChunks
      ) {
        coverage.pending += 1;
        coverage.truncated = true;
        continue;
      }
      const media = options.media;
      if (media === undefined) {
        continue;
      }
      try {
        const parts = await media.decode(file.absolute, file.media);
        const answer = await media.embedParts([parts]);
        const vector = answer.vectors[0];
        if (vector === undefined) {
          coverage.skipped += 1;
          continue;
        }
        kept.set(file.path, {
          stamp: file.stamp,
          records: [
            {
              kind: 'media',
              path: file.path,
              mediaKind: file.media,
              /*
               * Media has no text to digest, so the stamp *is* the digest: the
               * same size and mtime the incremental refresh already trusts, so a
               * media hit is reported changed on exactly the evidence a text
               * file is re-read on, and nothing new has to be hashed.
               */
              sha256: stampDigest(file.stamp),
            },
          ],
          vectors: [normalize(vector)],
        });
        coverage.embedded += 1;
        mediaThisPass += 1;
        filesThisPass += 1;
        options.onFile?.(file.path);
      } catch {
        // A file the decoder cannot open is skipped, and whatever it held before
        // is left alone rather than silently dropped.
        coverage.skipped += 1;
      }
      continue;
    }

    if (filesThisPass >= maxFiles || chunksThisPass >= maxChunks) {
      /*
       * Left for the next refresh, and counted. A loop that quietly stopped here
       * would report a complete index over a folder it had read a tenth of — the
       * failure `search_knowledge_base` writes `[stopped at the result cap]` to
       * avoid, in the place it would be hardest to notice.
       */
      coverage.pending += 1;
      coverage.truncated = true;
      continue;
    }

    const text = await readText(file.absolute);
    if (text === undefined) {
      coverage.skipped += 1;
      // A file that read as binary still has a stamp, and is recorded as such:
      // otherwise every refresh would try it again.
      kept.set(file.path, {stamp: file.stamp, records: [], vectors: []});
      continue;
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      kept.set(file.path, {stamp: file.stamp, records: [], vectors: []});
      coverage.embedded += 1;
      filesThisPass += 1;
      continue;
    }

    const asked = chunks.map((chunk) => documentText(file.path, chunk.text));
    const answer = await options.embed(asked);
    if (answer.vectors.length !== chunks.length) {
      /*
       * Refused rather than half-stored: the vectors are matched to chunks by
       * position, so a short answer would silently attach every later chunk's
       * text to another chunk's numbers. The file keeps its old entry, which is
       * stale but honest, and the next refresh tries again.
       */
      coverage.skipped += 1;
      continue;
    }

    const records: IndexRecord[] = [];
    const vectors: Float32Array[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const vector = answer.vectors[index];
      if (vector === undefined) {
        continue;
      }
      records.push({
        kind: 'text',
        path: file.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        sha256: digestOf(chunk.text),
      });
      vectors.push(normalize(vector));
    }

    kept.set(file.path, {stamp: file.stamp, records, vectors});
    coverage.embedded += 1;
    filesThisPass += 1;
    chunksThisPass += records.length;
    options.onFile?.(file.path);
  }

  /*
   * The cap, applied before anything is written.
   *
   * The oldest-modified files go first, because the index is a cache of the folder
   * as it is now: a file nobody has touched in a year is the least likely thing to
   * be asked about, and the most likely to be the thing that pushed a working index
   * over a memory limit.
   */
  coverage.evicted = evict(kept, maxRecords);

  const memory = await memoryRecords(options, usable, coverage);
  const conversation = await conversationRecords(options, oldConversations, coverage);

  const {file, vectors} = assemble(
    kept,
    [memory, ...conversation.groups],
    model,
    now(),
  );
  await writeIndex(dir, {file, vectors});

  coverage.files = [...kept.values()].filter((entry) =>
    entry.records.some((record) => record.kind === 'text'),
  ).length;
  coverage.chunks = file.records.filter((record) => record.kind === 'text').length;
  coverage.memory = file.records.filter((record) => record.kind === 'memory').length;
  coverage.conversations = file.records.filter(
    (record) => record.kind === 'conversation',
  ).length;
  coverage.media = file.records.filter((record) => record.kind === 'media').length;
  return {data: {file, vectors}, coverage, watermark: conversation.watermark};
}

/**
 * The memory bullets, re-embedded whole when the file changes.
 *
 * Whole rather than per bullet, because memory.md is capped at 64 KB and holds on
 * the order of a hundred bullets: one batched request re-embeds all of it in a
 * few hundred milliseconds, and the alternative is per-bullet bookkeeping for a
 * file whose usual change is one line. The digest is of the whole file, so an
 * edit anywhere re-embeds everything — cheap, and impossible to get subtly wrong.
 */
async function memoryRecords(
  options: RefreshOptions,
  usable: IndexData | undefined,
  coverage: IndexCoverage,
): Promise<{records: IndexRecord[]; vectors: Float32Array[]; hash: string}> {
  const text = options.memory ?? '';
  const hash = digestOf(text);

  if (usable !== undefined && usable.file.memoryHash === hash) {
    const dims = usable.file.model.dims;
    const records: IndexRecord[] = [];
    const vectors: Float32Array[] = [];
    for (const [at, record] of usable.file.records.entries()) {
      if (record.kind !== 'memory') {
        continue;
      }
      records.push(record);
      vectors.push(new Float32Array(usable.vectors.subarray(at * dims, (at + 1) * dims)));
    }
    return {records, vectors, hash};
  }

  const bullets = memoryBullets(text);
  if (bullets.length === 0) {
    return {records: [], vectors: [], hash};
  }

  const answer = await options.embed(
    bullets.map((bullet) => documentText(bullet.section, bullet.text)),
  );
  if (answer.vectors.length !== bullets.length) {
    coverage.skipped += 1;
    /*
     * No hash is claimed, so the next refresh tries again rather than believing
     * memory is indexed when it is not — the one failure that would be invisible,
     * because the file itself is fine and only the index is empty.
     */
    return {records: [], vectors: [], hash: ''};
  }

  const records: IndexRecord[] = [];
  const vectors: Float32Array[] = [];
  for (const [index, bullet] of bullets.entries()) {
    const vector = answer.vectors[index];
    if (vector === undefined) {
      continue;
    }
    records.push({
      kind: 'memory',
      path: MEMORY_SOURCE,
      section: bullet.section,
      sha256: digestOf(bullet.text),
    });
    vectors.push(normalize(vector));
  }
  return {records, vectors, hash};
}

/**
 * The new stretch of each conversation, appended to what is already indexed.
 *
 * The watermark is what makes this a feature rather than a re-embed of every chat
 * on every search: it records how many of a conversation's stored events have
 * been turned into vectors, and only the events past that mark are embedded. The
 * transcript is append-only, so an old range can be *rendered again exactly* —
 * which is what the service does to show a hit's text, and what makes a digest
 * over that range enough to prove the hit is still true.
 *
 * The mark is trusted only when the index still has vectors for that
 * conversation. If the index was thrown away or refused, the vectors it
 * described are gone, and honouring a mark left in a store beside it would leave
 * the user's history permanently half-indexed with nothing to say so.
 *
 * A conversation that cannot be read keeps the vectors it had rather than being
 * dropped: a momentary read failure must not silently take the user's own words
 * out of their index, and the next refresh will try again.
 */
async function conversationRecords(
  options: RefreshOptions,
  old: Map<string, {records: IndexRecord[]; vectors: Float32Array[]}>,
  coverage: IndexCoverage,
): Promise<{
  groups: Array<{records: IndexRecord[]; vectors: Float32Array[]}>;
  watermark: Record<string, number>;
}> {
  const source = options.conversations;
  if (source === undefined) {
    return {groups: [], watermark: {}};
  }

  const maxConversations = options.maxConversations ?? REFRESH_CONVERSATIONS;
  const groups: Array<{records: IndexRecord[]; vectors: Float32Array[]}> = [];
  const watermark: Record<string, number> = {};
  let embedded = 0;

  for (const summary of await source.list()) {
    const entry = old.get(summary.sessionId) ?? {records: [], vectors: []};
    /*
     * The mark is read from the store, but only applied to a conversation whose
     * vectors are present. A fresh index, or one built before this conversation
     * was ever in it, starts from the beginning regardless of what the store
     * says. The furthest range the index already holds wins when it is further
     * than the store's mark — which is how a watermark lost to a crash does not
     * become a duplicate vector on the next refresh.
     */
    const indexed = entry.records.reduce(
      (furthest, record) => Math.max(furthest, record.endEvent ?? 0),
      0,
    );
    const stored = Math.max(
      0,
      Math.floor(options.watermark?.[summary.sessionId] ?? 0),
    );
    const done = entry.records.length > 0 ? Math.max(indexed, stored) : 0;

    if (summary.eventCount <= done) {
      watermark[summary.sessionId] = done;
      groups.push(entry);
      continue;
    }
    if (embedded >= maxConversations) {
      coverage.pendingConversations += 1;
      coverage.truncated = true;
      watermark[summary.sessionId] = done;
      groups.push(entry);
      continue;
    }

    let read: {title: string; events: readonly ConversationEvent[]} | undefined;
    try {
      read = await source.read(summary.sessionId);
    } catch {
      read = undefined;
    }
    if (read === undefined) {
      coverage.skipped += 1;
      watermark[summary.sessionId] = done;
      groups.push(entry);
      continue;
    }

    const start = Math.min(done, read.events.length);
    const {text, endEvent} = conversationSlice(
      read.events,
      start,
      MAX_CONVERSATION_CHARS,
    );
    // Moved whether or not anything was said: a turn that was all tool calls is
    // still progress, and not recording it means reading it again forever.
    watermark[summary.sessionId] = Math.max(endEvent, start);
    if (text.trim().length === 0) {
      groups.push(entry);
      continue;
    }

    const title = read.title.length > 0 ? read.title : summary.title;
    const answer = await options.embed([documentText(title, text)]);
    const vector = answer.vectors[0];
    if (vector === undefined) {
      coverage.skipped += 1;
      groups.push(entry);
      continue;
    }

    entry.records.push({
      kind: 'conversation',
      path: CONVERSATION_SOURCE,
      sessionId: summary.sessionId,
      title,
      startEvent: start,
      endEvent,
      sha256: digestOf(text),
    });
    entry.vectors.push(normalize(vector));
    groups.push(entry);
    embedded += 1;
  }

  return {groups, watermark};
}

/** One bullet of memory, with the section it lives under. */
export interface MemoryBullet {
  section: string;
  text: string;
}

/**
 * memory.md's bullets, read by the agent package's own splitter.
 *
 * The store's parser rather than a second one here, because the index has to
 * agree with `update_memory` bullet for bullet: a fact written by the tool and
 * invisible to the index is a memory the agent cannot find, and nothing would
 * ever say so. The preamble — text before the first `##` — is given the file's own
 * name as its section, since it is text a person wrote in the file and dropping it
 * would be dropping a fact.
 */
export function memoryBullets(memory: string): MemoryBullet[] {
  const bullets: MemoryBullet[] = [];
  for (const block of splitMemory(memory)) {
    const section = block.heading ?? MEMORY_FALLBACK_SECTION;
    for (const line of block.lines) {
      const match = /^\s*[-*]\s+(.*)$/u.exec(line);
      const text = match?.[1]?.trim() ?? '';
      if (text.length > 0) {
        bullets.push({section, text});
      }
    }
  }
  return bullets;
}

/** What the file's preamble is called, for a bullet that has no heading. */
const MEMORY_FALLBACK_SECTION = 'memory.md';

/**
 * Drops the oldest-modified files until the index fits.
 *
 * Whole files, never half of one: a chunk of a file with its neighbours missing is
 * a result list that quotes the middle of something and cannot say what it was
 * part of. Returns how many files went, so the caller can say so.
 */
function evict(
  kept: Map<string, {stamp: FileStamp; records: IndexRecord[]; vectors: Float32Array[]}>,
  maxRecords: number,
): number {
  let total = 0;
  for (const entry of kept.values()) {
    total += entry.records.length;
  }
  if (total <= maxRecords) {
    return 0;
  }

  const oldest = [...kept.entries()]
    .filter(([, entry]) => entry.records.length > 0)
    .sort((left, right) => left[1].stamp.mtimeMs - right[1].stamp.mtimeMs);

  let evicted = 0;
  for (const [path, entry] of oldest) {
    if (total <= maxRecords) {
      break;
    }
    total -= entry.records.length;
    kept.delete(path);
    evicted += 1;
  }
  return evicted;
}

/**
 * The files to consider, as absolute paths.
 *
 * Through the agent package's walker rather than a second one, so the folders the
 * search refuses to look in are the folders the index refuses to embed — one
 * answer to "which files are here", which is the whole reason it is shared. The
 * byte cap is a parameter because media and text want different ones: a clip is
 * routinely larger than the largest file whose *text* is worth reading, and the
 * caller decides which cap this walk is for.
 */
async function walk(
  workspaceRoot: string,
  maxBytesPerFile?: number,
): Promise<string[]> {
  return (
    await walkFiles(workspaceRoot, {
      ...(maxBytesPerFile === undefined ? {} : {maxBytesPerFile}),
    })
  ).files;
}

async function stampOf(
  absolute: string,
  path: string,
): Promise<FileStamp | undefined> {
  try {
    const info = await stat(absolute);
    return {path, size: info.size, mtimeMs: info.mtimeMs};
  } catch {
    return undefined;
  }
}

/**
 * A file's stamp, as the digest a media record carries.
 *
 * There is no text in a picture to hash, so the evidence a media hit is checked
 * against is the same size and modification time the incremental refresh already
 * uses to decide a file changed. That is the honest bound of what this can know
 * without reading a hundred megabytes on every search, and it is the same
 * judgement `FileStamp` already records at the top of this file.
 */
function stampDigest(stamp: FileStamp): string {
  return digestOf(`${String(stamp.size)}:${String(stamp.mtimeMs)}`);
}

/**
 * A file's text, or `undefined` when it is not text.
 *
 * The same NUL-byte test the literal search uses, and for the same reason: a
 * binary file read as UTF-8 is a megabyte of replacement characters that embeds
 * into a vector standing for nothing at all.
 */
async function readText(absolute: string): Promise<string | undefined> {
  try {
    const text = await readFile(absolute, 'utf8');
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * The map, as one file and one array.
 *
 * Files in sorted order, then memory, then the conversations in the order their
 * sessions came back, so two builds of the same folder produce the same vector
 * order — which makes an index diffable and a bug reproducible. The digest of the
 * result is not stored; the ordering is simply a decision rather than an accident.
 *
 * `extras` is everything that is not a file with a stamp on it: memory, and each
 * conversation. They are appended whole, because none of them has a modification
 * time to compare or a path to walk — the thing that decides whether they changed
 * lives in their own stores.
 */
function assemble(
  kept: Map<string, {stamp: FileStamp; records: IndexRecord[]; vectors: Float32Array[]}>,
  extras: ReadonlyArray<{
    records: IndexRecord[];
    vectors: Float32Array[];
    /** Only memory has one: the digest of the file its bullets came from. */
    hash?: string;
  }>,
  model: IndexModel,
  now: Date,
): IndexData {
  const records: IndexRecord[] = [];
  const vectors: Float32Array[] = [];
  const files: FileStamp[] = [];

  const paths = [...kept.keys()].sort();
  for (const path of paths) {
    const entry = kept.get(path) as {stamp: FileStamp; records: IndexRecord[]; vectors: Float32Array[]};
    files.push(entry.stamp);
    for (const [index, record] of entry.records.entries()) {
      const vector = entry.vectors[index];
      if (vector === undefined) {
        continue;
      }
      records.push(record);
      vectors.push(vector);
    }
  }

  for (const group of extras) {
    for (const [index, record] of group.records.entries()) {
      const vector = group.vectors[index];
      if (vector === undefined) {
        continue;
      }
      records.push(record);
      vectors.push(vector);
    }
  }

  const flat = new Float32Array(vectors.length * model.dims);
  for (const [index, vector] of vectors.entries()) {
    flat.set(vector, index * model.dims);
  }

  const file = emptyIndex(model, now);
  file.count = records.length;
  file.records = records;
  file.files = files;
  /*
   * Claimed only when memory is actually in here. An empty string means "not
   * indexed", which is a refresh that tries again rather than one that believes
   * the bullets are present because the file happened to be unchanged.
   */
  const memory = extras[0];
  if (memory !== undefined && memory.hash !== undefined && memory.hash.length > 0) {
    file.memoryHash = memory.hash;
  }
  return {file, vectors: flat};
}
