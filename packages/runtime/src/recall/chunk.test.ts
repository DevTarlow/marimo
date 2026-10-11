/**
 * Cutting a file, and the two properties everything else depends on.
 *
 * A chunk is a *range of lines*, and the range is the thing a person is shown
 * and a model is asked to read. So the tests here are not about sizes: they are
 * that the range a chunk reports really is the text it carries, that the cuts
 * cover the file exactly once, and that a file is cut the same way twice — the
 * last of which is what makes a stale hit detectable at all, since a chunk's
 * text is hashed when it is indexed and hashed again when a result is shown.
 */
import {describe, expect, it} from 'vitest';

import {chunkText} from './chunk.js';

/** What a chunk claims to be: those lines of the file, blanks dropped. */
function linesOf(text: string, startLine: number, endLine: number): string {
  return text
    .split('\n')
    .slice(startLine - 1, endLine)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

describe('chunkText', () => {
  it('has nothing to say about an empty file', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('\n\n   \n')).toEqual([]);
  });

  it('reports the lines each chunk is actually made of', () => {
    const text = ['const a = 1;', 'const b = 2;', '', 'const c = 3;'].join('\n');
    const chunks = chunkText(text, {maxChars: 1000, overlapChars: 0});

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(4);
    // The blank line is dropped from the text but not from the range.
    expect(chunks[0]?.text).toBe('const a = 1;\nconst b = 2;\nconst c = 3;');
    expect(chunks[0]?.text).toBe(linesOf(text, 1, 4));
  });

  /*
   * The whole file has to be reachable: every line with content appears in at
   * least one chunk, and no chunk claims a line that holds nothing. Without the
   * first half a long function can fall between two cuts and simply never be
   * findable.
   */
  it('covers every line with content when it cuts a file up', () => {
    const text = Array.from({length: 200}, (_, i) => `line ${String(i + 1)} of the file`).join('\n');
    const chunks = chunkText(text, {maxChars: 200, overlapChars: 40});

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(linesOf(text, chunk.startLine, chunk.endLine));
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (let line = chunk.startLine; line <= chunk.endLine; line += 1) {
        covered.add(line);
      }
    }
    expect(covered.size).toBe(200);
    // In order, and never backwards: a result list built from these is read top
    // to bottom.
    const starts = chunks.map((chunk) => chunk.startLine);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('cuts the same file the same way twice', () => {
    const text = Array.from({length: 60}, (_, i) => `x${String(i)}() {}`).join('\n');
    expect(chunkText(text)).toEqual(chunkText(text));
  });

  /*
   * A minified bundle is one line of hundreds of kilobytes. Without pre-slicing
   * it is one chunk — a single vector standing for a whole dependency, which
   * matches nothing and is re-embedded entire on every change.
   */
  it('slices a line too long to be a chunk on its own', () => {
    const long = 'a'.repeat(500);
    const chunks = chunkText(`before\n${long}\nafter`, {
      maxChars: 100,
      overlapChars: 10,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(100);
    }
    // Every slice still names the line it came from, so a hit points somewhere
    // a person can look — including the last one, which is the tail of the line
    // rather than the line after it.
    for (const chunk of chunks) {
      if (/^a+$/u.test(chunk.text)) {
        expect(chunk.startLine).toBe(2);
        expect(chunk.endLine).toBe(2);
      }
    }
    expect(chunks[0]?.text).toBe('before');
    expect(chunks[chunks.length - 1]?.text).toBe('after');
  });

  /*
   * Overlap is the point of the overlap, and so is not repeating everything: a
   * chunk that carried the previous chunk's whole body would be the same text at
   * two scores. That is what happens when a chunk is smaller than the overlap
   * budget, so it is asserted at the boundary rather than reasoned about.
   */
  it('never carries a whole chunk into the next one', () => {
    const chunks = chunkText('aa\nbb\ncccccccccc', {
      maxChars: 10,
      overlapChars: 500,
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual(['aa\nbb', 'cccccccccc']);
    // The lines of the second chunk are only the line that triggered it: the
    // first two were emitted already and are not carried.
    expect(chunks[1]?.startLine).toBe(3);
  });

  it('leaves no overlap when none was asked for', () => {
    const text = Array.from({length: 30}, (_, i) => `line ${String(i)}`).join('\n');
    const chunks = chunkText(text, {maxChars: 60, overlapChars: 0});
    const seen = new Set<string>();

    for (const chunk of chunks) {
      for (const line of chunk.text.split('\n')) {
        expect(seen.has(line)).toBe(false);
        seen.add(line);
      }
    }
  });
});
