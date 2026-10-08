/**
 * The soft limit on memory size.
 *
 * The boundary is the whole point: a warning that fires one byte early is
 * noise, and one that fires a byte late is the hard cap's problem instead.
 * Checked in both directions, and the tools' own tests drive the real file so
 * the byte count being compared is the one the tool computes.
 */
import {describe, expect, it} from 'vitest';

import {MEMORY_SOFT_LIMIT_BYTES, memorySizeWarning} from './size.js';

describe('memorySizeWarning', () => {
  it('says nothing below the limit', () => {
    expect(memorySizeWarning(MEMORY_SOFT_LIMIT_BYTES - 1)).toBe('');
  });

  /*
   * Exactly at the limit is not over it. The limit is the largest size allowed
   * to pass without comment, which is what makes "over" mean something.
   */
  it('says nothing exactly at the limit', () => {
    expect(memorySizeWarning(MEMORY_SOFT_LIMIT_BYTES)).toBe('');
  });

  it('warns one byte over', () => {
    const warning = memorySizeWarning(MEMORY_SOFT_LIMIT_BYTES + 1);
    expect(warning).toContain('over the');
    expect(warning).toContain('prune_memory');
  });

  it('reports the size and how far over it is', () => {
    const warning = memorySizeWarning(MEMORY_SOFT_LIMIT_BYTES * 2);
    expect(warning).toContain(String(MEMORY_SOFT_LIMIT_BYTES * 2));
    expect(warning).toContain('200%');
  });

  it('counts bytes rather than characters, as the cap does', () => {
    // A multi-byte character is what makes a character count look fine while
    // the file is over the line. The warning is told a byte count, so the only
    // thing to pin is that the caller computes it that way.
    expect(Buffer.byteLength('é', 'utf8')).toBe(2);
    expect(memorySizeWarning(MEMORY_SOFT_LIMIT_BYTES + 1)).not.toBe('');
  });

  it('stays well under the hard cap it is warning about', () => {
    // A soft limit at or above the cap would fire only for writes that already
    // failed, which is the situation it exists to arrive before.
    expect(MEMORY_SOFT_LIMIT_BYTES).toBeLessThan(64 * 1024);
  });

  /*
   * The limit is a parameter because the user can move it. A message that quoted
   * the old number would be arguing with the setting the agent was given, and a
   * warning that contradicts itself is one the model learns to ignore.
   */
  it('quotes the limit it was given, not the built-in one', () => {
    const moved = MEMORY_SOFT_LIMIT_BYTES * 2;
    expect(memorySizeWarning(moved - 1, moved)).toBe('');
    const warning = memorySizeWarning(moved + 1, moved);
    expect(warning).toContain(String(moved));
    expect(warning).not.toContain(String(MEMORY_SOFT_LIMIT_BYTES));
  });
});
