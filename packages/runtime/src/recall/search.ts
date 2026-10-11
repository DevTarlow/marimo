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
 * What is worth reading is the two *judgements* here, and they are the same
 * question asked twice: which of the nearest vectors is an answer. Finding them
 * is the easy half. The first judgement is the floor below which nothing counts
 * as one, and the second is that the eight nearest chunks in a file are usually
 * the same paragraph, so results are capped per source — a path for a file, a
 * section for memory.
 */
import type {IndexRecord} from './store.js';

/** Default hits returned to a caller. */
export const DEFAULT_LIMIT = 8;
/** The most a single caller may ask for. */
export const MAX_LIMIT = 50;
/** The most hits one source may contribute by default. */
export const DEFAULT_PER_SOURCE = 2;

/**
 * The score below which a vector is not an answer at all.
 *
 * Without this there is no such thing as "not found": the list is the nearest
 * `limit` vectors, so a query that matches nothing still comes back with the
 * least-unrelated things in the index, which on a small index is *everything* in
 * it. A folder of nine records answered "love" with nine rows, and none of them
 * said love. That is what this number is for.
 *
 * 0.68 is measured rather than chosen. Two corpora were indexed with the pinned
 * engine, the same prefixes, the same mean pooling, and asked questions whose
 * answers were known: a 900-chunk slice of this repository's source, and the
 * practice folder of prose notes and stored chats that produced the report.
 *
 * - Questions the corpus could answer scored 0.69 to 0.87 at the top, and the
 *   weakest of them — "where is the api key stored", which lands in `config.ts`
 *   — was 0.6873. A memory bullet asked for by meaning scored 0.72 to 0.87.
 * - Questions the corpus could not answer scored 0.56 to 0.69: "love" 0.646,
 *   "music" 0.642, "chocolate cake recipe" 0.563, "hello" 0.694, "quantum
 *   chromodynamics of the early universe" 0.591.
 *
 * The bands overlap by six thousandths, so no number separates them cleanly, and
 * this one is rounded the way that costs least: it is the lowest score a *good*
 * result was ever seen to produce. Missing the best answer is worse than keeping
 * something the reader can dismiss, which is why "hello" survives it and "love"
 * does not.
 *
 * It is a property of this use rather than of the model. Cosine against
 * EmbeddingGemma sits high for any two pieces of English — the model's own card
 * says its scores are not calibrated — and where the floor belongs moves with the
 * corpus, the length of the question, and whether the code prompts are in use. So
 * a caller that wants the old behaviour passes `minScore: 0`, and the window's
 * search box does exactly that when the user asks to see the nearest anyway.
 */
export const MIN_SCORE = 0.68;

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
  /**
   * The score a hit has to reach to be returned at all.
   *
   * Defaults to `MIN_SCORE`. `0` means "rank everything", which is a question
   * about the index rather than a search: the caller gets the nearest vectors
   * whatever they score, and is expected to say so.
   */
  minScore?: number;
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
  const minScore = options.minScore ?? MIN_SCORE;

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
    /*
     * Sorted, so the first one under the floor is followed only by others under
     * it. Stopping here rather than filtering the list is the same answer for
     * less: the floor is not a cap that something else could satisfy, it is the
     * end of what this index has to say.
     */
    if (score < minScore) {
      break;
    }
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
 * A file, a section of memory, one conversation, or one media file. Without this
 * the top of every result list is whichever file happens to have several
 * near-identical chunks — which is what a long file of similar functions looks
 * like from here — and the fact the user needed, sitting one paragraph into
 * another file, never appears.
 *
 * The conversation case is the one that matters most: a chat is indexed in
 * stretches as it grows, so without a per-conversation cap a single long chat
 * that happens to match the question would fill the whole list with its own
 * earlier messages.
 */
function sourceKey(record: IndexRecord): string {
  switch (record.kind) {
    case 'memory':
      return `memory:${record.section ?? ''}`;
    case 'conversation':
      return `conversation:${record.sessionId ?? record.path}`;
    case 'media':
      return `media:${record.path}`;
    default:
      return `text:${record.path}`;
  }
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
