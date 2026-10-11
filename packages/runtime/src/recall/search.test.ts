/**
 * Ranking, and the two judgements that make a result list worth reading.
 *
 * The maths is a dot product and hardly needs testing. What does is what gets
 * left out: the floor below which a vector is not an answer at all, and the cap
 * that stops the eight nearest chunks of one long file from filling the list.
 * So the interesting assertions are about what is *withheld*.
 */
import {describe, expect, it} from 'vitest';

import {MIN_SCORE, searchVectors} from './search.js';
import type {IndexRecord} from './store.js';

/** A record whose text is its own name, for readable assertions. */
function record(name: string, kind: 'text' | 'memory' = 'text'): IndexRecord {
  return kind === 'memory'
    ? {kind: 'memory', path: '(memory)', section: name, sha256: name}
    : {kind: 'text', path: name, startLine: 1, endLine: 2, sha256: name};
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
        [0.7, 0.714, 0],
        [1, 0, 0],
        [0.8, 0.6, 0],
      ]),
      dims: 3,
      records: [record('far'), record('exact'), record('near')],
      query,
    });

    expect(hits.map((hit) => hit.path)).toEqual(['exact', 'near', 'far']);
    expect(hits[0]?.score).toBeCloseTo(1);
    expect(hits[2]?.score).toBeCloseTo(0.7);
  });

  /*
   * The floor, which is what makes "nothing found" an answer this can give at
   * all. Without it the result list is the nearest `limit` vectors whatever they
   * score, so a question the index cannot answer still comes back full — and on a
   * small index that is every record in it, which is how a folder of nine notes
   * answered "love" with nine rows that never said love.
   */
  it('leaves out what is nowhere near the question', () => {
    const hits = searchVectors({
      vectors: vectors([
        [1, 0, 0],
        [0.5, 0.5, 0],
        [0, 1, 0],
      ]),
      dims: 3,
      records: [record('exact'), record('half'), record('nothing')],
      query,
    });

    expect(hits.map((hit) => hit.path)).toEqual(['exact']);
  });

  it('keeps a hit that sits exactly on the floor', () => {
    const hits = searchVectors({
      vectors: vectors([[MIN_SCORE, Math.sqrt(1 - MIN_SCORE * MIN_SCORE), 0]]),
      dims: 3,
      records: [record('borderline')],
      query,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.score).toBeCloseTo(MIN_SCORE);
  });

  /*
   * The window's second question, after the floor has withheld everything: what
   * is nearest, whatever it scores. It is the same ranking with the floor taken
   * off rather than a second implementation of one.
   */
  it('ranks everything when the caller takes the floor off', () => {
    const hits = searchVectors({
      vectors: vectors([
        [1, 0, 0],
        [0.5, 0.5, 0],
        [0, 1, 0],
      ]),
      dims: 3,
      records: [record('exact'), record('half'), record('nothing')],
      query,
      minScore: 0,
    });

    expect(hits.map((hit) => hit.path)).toEqual(['exact', 'half', 'nothing']);
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
