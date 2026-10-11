/**
 * Finding the nearest vectors, by looking at all of them.
 *
 * There is no vector database here and there is not going to be one. The whole
 * corpus this app indexes is one person's folder and their own conversations: a
 * few thousand chunks, which at 768 dimensions is a few megabytes and a pass over
 * it costs single-digit milliseconds in plain JavaScript. An index structure —
 * HNSW, IVF, a native extension — would buy a constant factor on a workload that
 * is already instant, at the price of a dependency in the one package that has to
 * run inside both Electron and a plain Node process.
 *
 * What is worth reading is the *caps*. Finding the nearest vectors is the easy
 * half; the hard half is that the eight nearest chunks in a file are usually the
 * same paragraph, and a result list that returns them is one nobody reads. So
 * results are capped per source, and what a "source" is differs by kind: a path
 * for a file, a section for memory. That is the whole judgement in this file.
 */
import type {IndexRecord} from './store.js';

/** Default hits returned to a caller. */
export const DEFAULT_LIMIT = 8;
/** The most a single caller may ask for. */
export const MAX_LIMIT = 50;
/** The most hits one source may contribute by default. */
export const DEFAULT_PER_SOURCE = 2;

export interface SearchHit extends IndexRecord {
  /** Cosine similarity against the query, in `[-1, 1]`. */
  score: number;
}

export interface SearchOptions {
  /** The index's vectors, one per record, in record order. */
  vectors: Float32Array;
  dims: number;
  records: readonly IndexRecord[];
  /** A unit-length query vector. */
  query: Float32Array;
  limit?: number;
  perSource?: number;
}

/**
 * The best hits, ranked, with no source over-represented.
 *
 * Full sort rather than a heap: the input is bounded by the index and the list
 * has to be *stable* — two chunks with the same score must come back in the same
 * order twice, or a result list reshuffles under the user between two identical
 * searches. Sorting by score and then by index gives that, and a heap would not
 * without extra work.
 */
export function searchVectors(options: SearchOptions): SearchHit[] {
  const {vectors, dims, records, query} = options;
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const perSource = Math.max(options.perSource ?? DEFAULT_PER_SOURCE, 1);

  const scored: Array<{index: number; score: number}> = [];
  for (const [index, record] of records.entries()) {
    if (record === undefined) {
      continue;
    }
    const at = index * dims;
    if (at + dims > vectors.length) {
      // A record without its vector is a truncated index, which `readIndex`
      // refuses — but a caller can assemble one by hand, and half a vector would
      // be read as a number from the next record entirely.
      break;
    }
    scored.push({index, score: dot(query, vectors, at, dims)});
  }

  scored.sort((left, right) =>
    right.score === left.score ? left.index - right.index : right.score - left.score,
  );

  const hits: SearchHit[] = [];
  const used = new Map<string, number>();
  for (const {index, score} of scored) {
    if (hits.length >= limit) {
      break;
    }
    const record = records[index] as IndexRecord;
    const key = sourceKey(record);
    const count = used.get(key) ?? 0;
    if (count >= perSource) {
      continue;
    }
    used.set(key, count + 1);
    hits.push({...record, score});
  }

  return hits;
}

/**
 * What "the same source" means for a record.
 *
 * A file, or a section of memory. Without this the top of every result list is
 * whichever file happens to have several near-identical chunks — which is what a
 * long file of similar functions looks like from here — and the fact the user
 * needed, sitting one paragraph into another file, never appears.
 */
function sourceKey(record: IndexRecord): string {
  return record.kind === 'memory'
    ? `memory:${record.section ?? ''}`
    : `text:${record.path}`;
}

/** The dot product of a unit vector with the vector at `at`. */
function dot(
  query: Float32Array,
  vectors: Float32Array,
  at: number,
  dims: number,
): number {
  let total = 0;
  for (let index = 0; index < dims; index += 1) {
    total += (query[index] ?? 0) * (vectors[at + index] ?? 0);
  }
  return total;
}
