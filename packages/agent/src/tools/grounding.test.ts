import {GOOGLE_SEARCH} from '@google/adk';
import {PROVIDER_IDS} from '@marimo/protocol';
import {describe, expect, it} from 'vitest';

import {groundingTools, supportsGoogleSearch} from './grounding.js';

describe('google search grounding', () => {
  it('stays off for every provider that does not implement it', () => {
    /*
     * The built-in throws for anything that is not a Gemini model, so attaching
     * it would break every turn rather than just the search. Every provider is
     * named by the catalogue rather than picked on one at a time, because the
     * failure mode of adding a provider without thinking about this is a turn
     * that dies with `Google search tool is not supported`.
     */
    for (const provider of PROVIDER_IDS) {
      if (provider === 'gemini') {
        continue;
      }
      expect(supportsGoogleSearch(provider)).toBe(false);
      expect(groundingTools(provider)).toEqual([]);
    }
  });

  it('is offered for Gemini, which is the endpoint that implements it', () => {
    expect(supportsGoogleSearch('gemini')).toBe(true);
    expect(groundingTools('gemini')).toEqual([GOOGLE_SEARCH]);
  });

  /*
   * The gate is the provider rather than the model id, and this is the case that
   * says why: a Gemini model reached through OpenRouter is not served by Google,
   * so the built-in would throw on a request that never had grounding behind it.
   */
  it('is not offered for a Gemini-named model on another provider', () => {
    expect(supportsGoogleSearch('openrouter')).toBe(false);
    expect(groundingTools('openrouter')).toEqual([]);
  });
});
