import {GOOGLE_SEARCH} from '@google/adk';
import {LOCAL_MODEL_ID} from '@marimo/protocol';
import {describe, expect, it} from 'vitest';

import {groundingTools, supportsGoogleSearch} from './grounding.js';

describe('google search grounding', () => {
  it('stays off for the local model this app runs', () => {
    // The built-in throws for non-Gemini models, so attaching it would break
    // every turn rather than just the search — and the one model this app
    // answers with is not Gemini.
    expect(supportsGoogleSearch(LOCAL_MODEL_ID)).toBe(false);
    expect(groundingTools(LOCAL_MODEL_ID)).toEqual([]);
  });

  it('is offered for a Gemini model', () => {
    expect(supportsGoogleSearch('gemini-2.5-pro')).toBe(true);
    expect(groundingTools('gemini-2.5-pro')).toEqual([GOOGLE_SEARCH]);
  });
});
