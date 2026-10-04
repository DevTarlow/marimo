import {GOOGLE_SEARCH} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {groundingTools, supportsGoogleSearch} from './grounding.js';

describe('google search grounding', () => {
  it('stays off for the DeepSeek provider this app runs', () => {
    // The built-in throws for non-Gemini models, so attaching it would break
    // every turn rather than just the search.
    expect(supportsGoogleSearch('deepseek-flash')).toBe(false);
    expect(groundingTools('deepseek-v4-pro')).toEqual([]);
  });

  it('is offered for a Gemini model', () => {
    expect(supportsGoogleSearch('gemini-2.5-pro')).toBe(true);
    expect(groundingTools('gemini-2.5-pro')).toEqual([GOOGLE_SEARCH]);
  });
});
