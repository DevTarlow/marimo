/**
 * The search behind the model picker.
 *
 * The picker itself is DOM, and this package has no DOM test environment — the
 * same trade `pet-layout.test.ts` describes. What cannot be checked by eye is
 * which models a query keeps and in what order, so the filter is a plain
 * function and this is where it is pinned.
 */
import {describe, expect, it} from 'vitest';

import {filterModels} from '../src/renderer/model-search.js';

const MODELS = [
  'anthropic/claude-sonnet-4',
  'google/gemini-2.5-flash',
  'openai/gpt-5',
  'meta-llama/llama-4-70b',
  'openrouter/auto',
];

describe('filterModels', () => {
  it('returns the whole list for an empty query, in the endpoint order', () => {
    expect(filterModels(MODELS, '')).toEqual(MODELS);
    expect(filterModels(MODELS, '   ')).toEqual(MODELS);
  });

  it('matches a case-insensitive substring anywhere in the id', () => {
    expect(filterModels(MODELS, 'FLASH')).toEqual(['google/gemini-2.5-flash']);
    expect(filterModels(MODELS, 'llama')).toEqual(['meta-llama/llama-4-70b']);
  });

  it('matches a vendor prefix, which is how a long list is navigated', () => {
    expect(filterModels(MODELS, 'openai/')).toEqual(['openai/gpt-5']);
  });

  it('keeps the endpoint order rather than re-ranking by match position', () => {
    // `a` is in every id; the answer must be the order OpenRouter sent, which is
    // the order the user was just reading.
    expect(filterModels(MODELS, 'a')).toEqual(MODELS);
  });

  it('answers an unmatched query with nothing, not everything', () => {
    expect(filterModels(MODELS, 'no-such-model')).toEqual([]);
  });

  it('does not hand back the caller’s own array', () => {
    const filtered = filterModels(MODELS, '');
    expect(filtered).not.toBe(MODELS);
  });
});
