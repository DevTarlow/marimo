/**
 * The note a memory write leaves about the search index.
 *
 * Pure, so the cases that matter can be named without a store, an engine or a
 * turn: the three states the index can be in, a memory with nothing in it, and
 * the rule that a current index says nothing at all. The wording is asserted
 * loosely — what has to hold is that "not searchable yet" is said when it is
 * true, and not said when it is not.
 */
import {describe, expect, it} from 'vitest';

import {memoryIndexNote} from './index-note.js';

describe('memoryIndexNote', () => {
  it('says a write is not searchable yet when no index has been built', () => {
    const note = memoryIndexNote({
      state: {vectors: 0, index: false, behind: true},
      bullets: 3,
    });
    expect(note).toContain('not in the search index yet');
    expect(note).toContain('recall');
    // The other half of the sentence, and the reason it is worth saying at all:
    // the fact is stored, so the model must not think its write was lost.
    expect(note).toContain('memory file itself is current');
  });

  it('names how far behind the index is when one exists', () => {
    const note = memoryIndexNote({
      state: {vectors: 12, index: true, behind: true},
      bullets: 13,
    });
    expect(note).toContain('12 memory bullets');
    expect(note).toContain('before this write');
  });

  it('says bullet rather than bullets for one vector', () => {
    const note = memoryIndexNote({
      state: {vectors: 1, index: true, behind: true},
      bullets: 2,
    });
    expect(note).toContain('1 memory bullet from before');
    expect(note).not.toContain('1 memory bullets');
  });

  /*
   * The common case, and the one that decides whether this is a warning or a
   * line the model learns to ignore: a search has already re-embedded memory, so
   * there is nothing to say.
   */
  it('says nothing when the index is current', () => {
    expect(
      memoryIndexNote({
        state: {vectors: 13, index: true, behind: false},
        bullets: 13,
      }),
    ).toBe('');
  });

  it('says nothing about a memory with no bullets to be behind', () => {
    expect(
      memoryIndexNote({
        state: {vectors: 0, index: false, behind: true},
        bullets: 0,
      }),
    ).toBe('');
  });

  /*
   * A memory whose preamble is the only thing in it has no bullets, and the
   * caller counts bullets rather than lines for exactly this reason: an `#`
   * title is not a fact and telling the model it is unsearchable would be noise
   * about nothing.
   */
  it('says nothing when only a title is present', () => {
    expect(
      memoryIndexNote({
        state: {vectors: 0, index: true, behind: false},
        bullets: 0,
      }),
    ).toBe('');
  });
});
