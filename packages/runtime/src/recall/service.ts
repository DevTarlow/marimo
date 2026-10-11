/**
 * Recall, as a caller uses it: ask a question, get lines back.
 *
 * This is the seam between the *process* that produces vectors and the things
 * that want them — the agent's tool, the window's search box, the memory block
 * that goes into a prompt. All three want the same three answers, so all three go
 * through here: which corpora exist, what a query found, and whether what was
 * found is still true.
 *
 * Three decisions in this file are worth reading before changing anything.
 *
 * **A search refreshes first.** Not on a timer and not behind a button: the
 * moment a caller asks a question, whatever changed since the last time is
 * brought up to date, within a budget, and the answer says what that cost
 * (`coverage`). A query against an index nobody has built is useless, and a query
 * against one built last week answers confidently about a folder that has moved
 * on.
 *
 * **A hit is verified, not trusted.** Each of the handful of results is read back
 * from its source and checked against the digest stored with its vector. That is
 * why a hit can carry its own text, and why a file that changed *between* the
 * refresh and the read is reported as `stale` rather than quoted from a copy that
 * no longer exists.
 *
 * **Memory is a corpus, not a special case.** It is indexed the same way, scored
 * in the same space, and returned through the same shape — which is the point of
 * the whole feature: a question about the user and a question about their code
 * are the same kind of question.
 */
import {readFile, stat} from 'node:fs/promises';
import {join, sep} from 'node:path';

import {splitMemory} from '@marimo/agent';

import {chunkText} from './chunk.js';
import type {TextChunk} from './chunk.js';
import {refreshIndex} from './indexer.js';
import type {IndexCoverage} from './indexer.js';
import {documentText, queryText} from './prefixes.js';
import {DEFAULT_LIMIT, MAX_LIMIT, searchVectors} from './search.js';
import type {SearchHit} from './search.js';
import {INDEX_FILE, digestOf, readIndex, removeIndex} from './store.js';
import type {FileStamp, IndexModel, IndexRecord} from './store.js';

/** The corpora this app can search. */
export type RecallScope = 'folder' | 'memory';

/** One hit, with its text read back and checked. */
export interface RecallHit {
  kind: 'text' | 'memory';
  /** Path relative to the folder, or `''` for a memory bullet. */
  path: string;
  /** Text only: the first and last line, 1-based and inclusive. */
  startLine?: number;
  endLine?: number;
  /** Memory only: the `##` heading the bullet lives under. */
  section?: string;
  preview: string;
  /** Cosine similarity against the query. */
  score: number;
  /** The text itself, current as of the read that verified it. */
  text: string;
  /**
   * True when the source no longer matches what was indexed.
   *
   * The hit is still returned, with its preview and no text: the file it came
   * from still has something worth looking at, and dropping it entirely would be
   * a search that finds nothing because somebody edited the wrong line.
   */
  stale: boolean;
}

export interface RecallQuery {
  query: string;
  /** Which corpora to search; absent means all of them. */
  scopes?: readonly RecallScope[];
  limit?: number;
}

export interface RecallIndexStatus {
  /** When the index was last written. */
  builtAt?: string;
  /** Vectors in it, and how they split. */
  records: number;
  chunks: number;
  memory: number;
  /** Files whose stamp no longer matches what was indexed. */
  changed: number;
}

export interface RecallAnswer {
  hits: RecallHit[];
  /** The corpora that were actually searched. */
  searched: RecallScope[];
  /** What the refresh on the way here did. */
  coverage: IndexCoverage;
  index: RecallIndexStatus;
  /** Anything the caller should be told, in sentences. */
  notes: string[];
}

export interface RecallServiceOptions {
  /** The folder being indexed. Absent means there is no folder corpus. */
  workspaceRoot?: string;
  /** Where the index lives — `<workspace>/.marimo/<profile>/recall`. */
  dir: string;
  /** The model that is pinned now; an index from another one is rebuilt. */
  model: IndexModel;
  /** Turns text into vectors. */
  embed: (texts: readonly string[]) => Promise<{vectors: Float32Array[]}>;
  /**
   * The agent's memory file, read by whoever knows where it lives.
   *
   * Injected rather than derived, because memory's location is the
   * `MemoryStore`'s business and a second derivation here would be a second
   * opinion about which file the agent's memory is in.
   */
  readMemory?: () => Promise<string>;
  /** Caps for one refresh, for a caller that has to answer quickly. */
  maxFiles?: number;
  maxChunks?: number;
  now?: () => Date;
}

export class RecallService {
  constructor(private readonly options: RecallServiceOptions) {}

  /**
   * The corpora that can be searched right now.
   *
   * Answered rather than assumed, because a caller that offers a scope the
   * service cannot honour is a search that comes back empty for a reason nobody
   * can see. No folder means no folder corpus; no memory reader means no memory.
   */
  scopes(): RecallScope[] {
    const scopes: RecallScope[] = [];
    const root = this.options.workspaceRoot;
    if (root !== undefined && root.length > 0) {
      scopes.push('folder');
    }
    if (this.options.readMemory !== undefined) {
      scopes.push('memory');
    }
    return scopes;
  }

  /** What is indexed, without refreshing and without embedding anything. */
  async status(): Promise<RecallIndexStatus> {
    const data = await readIndex(this.options.dir, this.options.model);
    if (data === undefined) {
      return {records: 0, chunks: 0, memory: 0, changed: 0};
    }
    return {
      builtAt: data.file.builtAt,
      records: data.file.count,
      chunks: data.file.records.filter((record) => record.kind === 'text').length,
      memory: data.file.records.filter((record) => record.kind === 'memory').length,
      changed: await this.changedCount(data.file.files),
    };
  }

  /**
   * Bring the index up to date, then answer the question.
   *
   * The order is the design: ranking first would answer about a folder from
   * before the change that prompted the question.
   */
  async search(request: RecallQuery): Promise<RecallAnswer> {
    const available = this.scopes();
    const wanted = available.filter(
      (scope) => request.scopes === undefined || request.scopes.includes(scope),
    );
    const notes: string[] = [];
    const empty: IndexCoverage = {
      files: 0,
      chunks: 0,
      memory: 0,
      embedded: 0,
      pending: 0,
      truncated: false,
      skipped: 0,
    };

    const query = request.query.trim();
    if (query.length === 0 || wanted.length === 0) {
      return {
        hits: [],
        searched: [],
        coverage: empty,
        index: await this.status(),
        notes: wanted.length === 0 ? ['Nothing is available to search yet.'] : [],
      };
    }

    let coverage = empty;
    try {
      coverage = await this.refresh();
      if (coverage.truncated) {
        notes.push(
          'The folder is large enough that indexing happens in slices, and ' +
            `${String(coverage.pending)} file(s) are not indexed yet. ` +
            'Ask again to continue.',
        );
      }
      if (coverage.skipped > 0) {
        notes.push(
          `${String(coverage.skipped)} file(s) could not be read or embedded.`,
        );
      }
    } catch (failure) {
      /*
       * A folder that cannot be indexed is not a search that failed. Memory may
       * still be searchable, and the sentence says which half is missing rather
       * than reporting "no results" for both.
       */
      notes.push(`The folder could not be indexed: ${describe(failure)}.`);
    }

    const data = await readIndex(this.options.dir, this.options.model);
    const index = await this.status();
    if (data === undefined || data.file.count === 0) {
      return {hits: [], searched: wanted, coverage, index, notes};
    }

    const answer = await this.options.embed([queryText(query)]);
    const vector = answer.vectors[0];
    if (vector === undefined) {
      notes.push('The question could not be turned into a vector.');
      return {hits: [], searched: wanted, coverage, index, notes};
    }

    /*
     * Ranked over the whole index and filtered afterwards, rather than ranking a
     * filtered copy: the record order *is* the vector order, so a filter that
     * renumbered anything would attach every score to the wrong text.
     */
    const ranked = searchVectors({
      vectors: data.vectors,
      dims: data.file.model.dims,
      records: data.file.records,
      query: vector,
      limit: Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    }).filter((hit) => wanted.includes(scopeOf(hit)));

    const hits: RecallHit[] = [];
    for (const hit of ranked) {
      hits.push(await this.read(hit));
    }

    return {hits, searched: wanted, coverage, index, notes};
  }

  /** Throws the index away, so the next search builds it again. */
  async forget(): Promise<void> {
    await removeIndex(this.options.dir);
  }

  private async refresh(): Promise<IndexCoverage> {
    const memory =
      this.options.readMemory === undefined ? '' : await this.options.readMemory();
    const result = await refreshIndex({
      workspaceRoot: this.options.workspaceRoot ?? '',
      dir: this.options.dir,
      model: this.options.model,
      embed: this.options.embed,
      memory,
      ...(this.options.maxFiles === undefined
        ? {}
        : {maxFiles: this.options.maxFiles}),
      ...(this.options.maxChunks === undefined
        ? {}
        : {maxChunks: this.options.maxChunks}),
      ...(this.options.now === undefined ? {} : {now: this.options.now}),
    });
    return result.coverage;
  }

  /**
   * A hit's text, read from its source and checked against the digest.
   *
   * The chunk is found by cutting the file again with the same function that cut
   * it the first time, rather than by arithmetic on offsets: the stored lines
   * describe a range, and the digest was taken over the text of that range. A
   * file that has changed in any way that matters has no chunk at those lines,
   * which is what `stale` reports.
   */
  private async read(hit: SearchHit): Promise<RecallHit> {
    const base = {
      kind: hit.kind,
      path: hit.path,
      ...(hit.startLine === undefined ? {} : {startLine: hit.startLine}),
      ...(hit.endLine === undefined ? {} : {endLine: hit.endLine}),
      ...(hit.section === undefined ? {} : {section: hit.section}),
      preview: hit.preview,
      score: hit.score,
    };

    if (hit.kind === 'memory') {
      const memory =
        this.options.readMemory === undefined ? '' : await this.options.readMemory();
      const bullet = memoryBullets(memory).find(
        (entry) =>
          entry.section === hit.section && digestOf(entry.text) === hit.sha256,
      );
      return bullet === undefined
        ? {...base, text: '', stale: true}
        : {...base, text: bullet.text, stale: false};
    }

    const root = this.options.workspaceRoot;
    if (root === undefined || root.length === 0) {
      return {...base, text: '', stale: true};
    }
    let text: string;
    try {
      text = await readFile(join(root, hit.path.split('/').join(sep)), 'utf8');
    } catch {
      return {...base, text: '', stale: true};
    }
    const chunk = chunkText(text).find(
      (entry) =>
        entry.startLine === hit.startLine &&
        entry.endLine === hit.endLine &&
        digestOf(entry.text) === hit.sha256,
    );
    return chunk === undefined
      ? {...base, text: '', stale: true}
      : {...base, text: chunk.text, stale: false};
  }

  /** How many indexed files no longer match the stamp they were built from. */
  private async changedCount(files: readonly FileStamp[]): Promise<number> {
    const root = this.options.workspaceRoot;
    if (root === undefined || root.length === 0) {
      return 0;
    }
    let changed = 0;
    for (const file of files) {
      try {
        const info = await stat(join(root, file.path.split('/').join(sep)));
        if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
          changed += 1;
        }
      } catch {
        // Gone counts as changed.
        changed += 1;
      }
    }
    return changed;
  }
}

/** Which corpus a record belongs to. */
function scopeOf(record: IndexRecord): RecallScope {
  return record.kind === 'memory' ? 'memory' : 'folder';
}

/**
 * A memory file's bullets, with their headings.
 *
 * Read through the agent package's splitter, which is the same one
 * `update_memory` writes through, so a fact the tool stored is a fact the index
 * can find. `indexer.ts` does the same for embedding; both are one small loop
 * over `splitMemory` rather than a parser of their own.
 */
function memoryBullets(memory: string): Array<{section: string; text: string}> {
  const bullets: Array<{section: string; text: string}> = [];
  for (const block of splitMemory(memory)) {
    const section = block.heading ?? 'memory.md';
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

/** The index's file name, so a caller can report or clear the right path. */
export const RECALL_INDEX_FILE = INDEX_FILE;

/** Where one profile's folder index lives, given the agent's data directory. */
export function recallIndexDir(agentDataDir: string): string {
  return join(agentDataDir, 'recall');
}

export {documentText, queryText};
export type {IndexRecord, TextChunk};

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
