/**
 * The words that arm the reset.
 *
 * The card renders `RESET_PHRASE` and arms on `armsReset`, so the label and the
 * check are one string and cannot drift. What this file is for is the half that
 * could still be wrong: a check that accepted a prefix would arm the button on
 * the first word somebody typed, and a check that refused a trailing space would
 * be a warning nobody can satisfy.
 */
import {describe, expect, it} from 'vitest';

import {RESET_PHRASE, armsReset} from '../src/renderer/reset-phrase.js';

describe('armsReset', () => {
  it('arms on the phrase, whatever case it was typed in', () => {
    expect(RESET_PHRASE).toBe('reset everything');
    expect(armsReset('reset everything')).toBe(true);
    expect(armsReset('Reset Everything')).toBe(true);
    expect(armsReset('  RESET EVERYTHING  ')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const typed of [
      '',
      ' ',
      'reset',
      'everything',
      'reset everything now',
      'reset  everything',
      'please reset everything',
    ]) {
      expect(armsReset(typed), typed).toBe(false);
    }
  });
});
