/**
 * Ranking, and the cap that makes a result list worth reading.
 *
 * The maths is a dot product and hardly needs testing. What does is the cap: the
 * eight nearest chunks of a long file are usually eight consecutive paragraphs of
 * the *same* file, and a list built from that is one where the answer the user
 * needed, one paragraph into another file, never appears. So the interesting
 * assertions are about what is *withheld*.
 */
import {describe, expect, it} from 'vitest';

import {searchVectors} from './search.js';
import type {IndexRecord} from './store.js';

/** A record whose text is its own name, for readable assertions. */
function record(name: string, kind: 'text' | 'memory' = 'text'): IndexRecord {
  return kind === 'memory'
    ? {kind: 'memory', path: '(memory)', section: name, sha256: name, preview: name}
    : {kind: 'text', path: name, startLine: 1, endLine: 2, sha256: name, preview: name};
}

/** One unit vector per record, pointing at a named axis. */
function vectors(points: number[][]): Float32Array {
  const dims = points[0]?.length ?? 0;
  const flat = new Float32Array(points.length * dims);
  for (const [index, point] of points.entries()) {
    flat.set(Float32Array.from(point), index * dims);
  }
  return flat;
}

describe('searchVectors', () => {
  const query = Float32Array.from([1, 0, 0]);

  it('ranks by similarity and reports the score', () => {
    const hits = searchVectors({
      vectors: vectors([
        [0, 1, 0],
        [1, 0, 0],
        [0.5, 0.5, 0],
      ]),
      dims: 3,
      records: [record('far'), record('exact'), record('near')],
      query,
    });

    expect(hits.map((hit) => hit.path)).toEqual(['exact', 'near', 'far']);
    expect(hits[0]?.score).toBeCloseTo(1);
    expect(hits[2]?.score).toBeCloseTo(0);
  });

  /*
   * Stability is a feature here rather than a property of the sort: two chunks
   * with the same score must come back in the same order twice, or a list
   * reshuffles under somebody who searches the same words again.
   */
  it('breaks a tie by position, so the same query gives the same list', () => {
    const options = {
      vectors: vectors([
        [1, 0, 0],
        [1, 0, 0],
      ]),
      dims: 3,
      records: [record('first'), record('second')],
      query,
    };

    expect(searchVectors(options).map((hit) => hit.path)).toEqual(['first', 'second']);
    expect(searchVectors(options).map((hit) => hit.path)).toEqual(['first', 'second']);
  });

  it('takes at most two hits from any one file', () => {
    const hits = searchVectors({
      vectors: vectors([
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
        [0.9, 0.1, 0],
      ]),
      dims: 3,
      records: [
        record('a.ts'),
        record('a.ts'),
        record('a.ts'),
        record('b.ts'),
      ],
      query,
    });

    expect(hits.filter((hit) => hit.path === 'a.ts')).toHaveLength(2);
    expect(hits.map((hit) => hit.path)).toContain('b.ts');
  });

  /*
   * A file and a memory section are different sources even though both are
   * strings on a record: without the distinction, two memory bullets would count
   * against whatever file happened to be called "Notes".
   */
  it('counts a memory section as its own source', () => {
    const hits = searchVectors({
      vectors: vectors([
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ]),
      dims: 3,
      records: [
        record('Notes', 'memory'),
        record('Notes', 'memory'),
        record('Notes', 'memory'),
      ],
      query,
    });

    expect(hits).toHaveLength(2);
  });

  it('respects a per-source cap a caller raised', () => {
    const hits = searchVectors({
      vectors: vectors([
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ]),
      dims: 3,
      records: [record('a.ts'), record('a.ts'), record('a.ts')],
      query,
      perSource: 3,
      limit: 10,
    });

    expect(hits).toHaveLength(3);
  });

  it('clamps the limit, so one caller cannot ask for the whole index', () => {
    const many = Array.from({length: 80}, () => [1, 0, 0]);
    const hits = searchVectors({
      vectors: vectors(many),
      dims: 3,
      records: many.map((_, index) => record(`f${String(index)}.ts`)),
      query,
      limit: 5_000,
      perSource: 1,
    });

    expect(hits).toHaveLength(50);
  });

  /*
   * A record without its vector is a truncated index. It is refused by
   * `readIndex`, but a caller can assemble one by hand, and reading past the end
   * of the array would take the next record's numbers as this one's.
   */
  it('stops rather than reading past the vectors it was given', () => {
    const hits = searchVectors({
      vectors: vectors([[1, 0, 0]]),
      dims: 3,
      records: [record('a.ts'), record('b.ts'), record('c.ts')],
      query,
    });

    expect(hits.map((hit) => hit.path)).toEqual(['a.ts']);
  });

  it('answers with nothing when there is nothing to search', () => {
    expect(
      searchVectors({
        vectors: new Float32Array(0),
        dims: 3,
        records: [],
        query,
      }),
    ).toEqual([]);
  });
});
