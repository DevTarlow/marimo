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

import {splitMemory, walkFiles} from '@marimo/agent';

import {chunkText} from './chunk.js';
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
  /** Files embedded by *this* refresh. */
  embedded: number;
  /** Files that need embedding and were left for the next refresh. */
  pending: number;
  /** Whether a budget stopped this refresh before the folder was settled. */
  truncated: boolean;
  /** Files that could not be read, or were not text. */
  skipped: number;
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
  maxFiles?: number;
  maxChunks?: number;
  /** How many vectors this index may hold before the oldest files are dropped. */
  maxRecords?: number;
  now?: () => Date;
  /** Told after each file, for a caller that reports progress. */
  onFile?: (path: string) => void;
}

export interface RefreshResult {
  data: IndexData;
  coverage: IndexCoverage;
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
  const maxRecords = options.maxRecords ?? MAX_RECORDS;

  const usable = await readIndex(dir, model);

  const coverage: IndexCoverage = {
    files: 0,
    evicted: 0,
    chunks: 0,
    memory: 0,
    embedded: 0,
    pending: 0,
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
  if (usable !== undefined) {
    const dims = usable.file.model.dims;
    for (const [at, record] of usable.file.records.entries()) {
      if (record.kind !== 'text') {
        continue;
      }
      const vector = usable.vectors.subarray(at * dims, (at + 1) * dims);
      const entry = kept.get(record.path);
      if (entry === undefined) {
        const stamp = usable.file.files.find((file) => file.path === record.path);
        kept.set(record.path, {
          stamp: stamp ?? {path: record.path, size: -1, mtimeMs: -1},
          records: [record],
          vectors: [new Float32Array(vector)],
        });
      } else {
        entry.records.push(record);
        entry.vectors.push(new Float32Array(vector));
      }
    }
  }

  const walked = await walk(workspaceRoot);
  const present = new Set<string>();
  const changed: Array<{path: string; absolute: string; stamp: FileStamp}> = [];

  for (const absolute of walked) {
    const path = relative(workspaceRoot, absolute).split(sep).join('/');
    present.add(path);
    const stamp = await stampOf(absolute, path);
    if (stamp === undefined) {
      coverage.skipped += 1;
      continue;
    }
    const known = kept.get(path);
    if (
      known !== undefined &&
      known.stamp.size === stamp.size &&
      known.stamp.mtimeMs === stamp.mtimeMs
    ) {
      continue;
    }
    changed.push({path, absolute, stamp});
  }

  // A file that is gone takes its vectors with it, and there is nothing to embed
  // to settle that — which is why deletion is applied before the budget below.
  for (const path of [...kept.keys()]) {
    if (!present.has(path)) {
      kept.delete(path);
    }
  }

  let chunksThisPass = 0;
  for (const file of changed) {
    if (coverage.embedded >= maxFiles || chunksThisPass >= maxChunks) {
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

  const {file, vectors} = assemble(kept, memory, model, now());
  await writeIndex(dir, {file, vectors});

  coverage.files = [...kept.values()].filter((entry) => entry.records.length > 0).length;
  coverage.chunks = file.records.filter((record) => record.kind === 'text').length;
  coverage.memory = file.records.filter((record) => record.kind === 'memory').length;
  return {data: {file, vectors}, coverage};
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
 * answer to "which files are here", which is the whole reason it is shared.
 */
async function walk(workspaceRoot: string): Promise<string[]> {
  return (await walkFiles(workspaceRoot)).files;
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
 * Files in sorted order, then memory, so two builds of the same folder produce
 * the same vector order — which makes an index diffable and a bug reproducible.
 * The digest of the result is not stored; the ordering is simply a decision
 * rather than an accident.
 */
function assemble(
  kept: Map<string, {stamp: FileStamp; records: IndexRecord[]; vectors: Float32Array[]}>,
  memory: {records: IndexRecord[]; vectors: Float32Array[]; hash: string},
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

  for (const [index, record] of memory.records.entries()) {
    const vector = memory.vectors[index];
    if (vector === undefined) {
      continue;
    }
    records.push(record);
    vectors.push(vector);
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
  if (memory.hash.length > 0) {
    file.memoryHash = memory.hash;
  }
  return {file, vectors: flat};
}
