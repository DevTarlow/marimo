/**
 * Which models a picker offers, and for whom.
 *
 * This is the bug the file exists for: the window was handed the *active*
 * provider's list and nothing else, so a control standing for an agent or a
 * conversation pinned to another endpoint offered an empty list — or, in the
 * one place that guessed, a single id with no catalogue behind it. A model is a
 * pair, so the provider is an argument here and never a fact read from
 * somewhere else.
 *
 * The second half is what stops a placeholder from reading as an answer. A
 * provider nobody has asked has no list, and the catalogue's names stand in for
 * it; `fetched` is how the control drawing them can say which of the two it is
 * showing, and offer the button that settles it.
 */
import {describe, expect, it} from 'vitest';

import {fallbackModelsFor} from '@marimo/protocol';
import type {AvailableModels} from '@marimo/protocol';

import {filterModels, modelChoicesFor} from '../src/renderer/model-search.js';

/** Two providers that have been asked, which is the state the window draws. */
function fetched(): AvailableModels {
  return {
    deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
    gemini: ['gemini-3.6-flash'],
  };
}

describe('modelChoicesFor', () => {
  /*
   * Named, not looked up. Gemini is asked for by a control standing for an agent
   * pinned there while the app itself answers through DeepSeek — and the answer
   * has to be Gemini's list, because the pair the control writes back is
   * Gemini's too.
   */
  it('answers for the provider it was given rather than the app’s own', () => {
    expect(modelChoicesFor(fetched(), 'gemini', 'gemini-3.6-flash')).toEqual({
      models: ['gemini-3.6-flash'],
      fetched: true,
    });
    expect(
      modelChoicesFor(fetched(), 'deepseek', 'deepseek-flash').models,
    ).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  /*
   * A provider nobody has asked still has to fill a picker, and the names it
   * fills it with are this build's. `fetched: false` is the whole reason they
   * can be shown at all: the control says so and offers the way to Fetch Models,
   * where a list that looked like an answer would leave the user with no reason
   * to refresh and a retired model still on offer.
   */
  it('falls back to the catalogue for a provider nobody has asked, and says so', () => {
    expect(modelChoicesFor({}, 'openrouter', 'openrouter/auto')).toEqual({
      models: fallbackModelsFor('openrouter'),
      fetched: false,
    });
    // The provider it was given, not the one with a list: Gemini's absence is
    // Gemini's, and DeepSeek's fetched names must not leak into it.
    const choices = modelChoicesFor(fetched(), 'gemini', '');
    expect(choices).toEqual({models: ['gemini-3.6-flash'], fetched: true});
  });

  /*
   * A model the endpoint has stopped advertising may still answer, so the stored
   * value is always offerable — first, because that is the one the trigger is
   * showing — and never twice.
   */
  it('keeps the stored model even when the list has stopped carrying it', () => {
    expect(modelChoicesFor(fetched(), 'gemini', 'gemini-9').models).toEqual([
      'gemini-9',
      'gemini-3.6-flash',
    ]);
    expect(
      modelChoicesFor(fetched(), 'gemini', 'gemini-3.6-flash').models,
    ).toEqual(['gemini-3.6-flash']);
    // Nothing stored yet: an empty string is the caller saying so, not a name.
    expect(modelChoicesFor(fetched(), 'gemini', '').models).toEqual([
      'gemini-3.6-flash',
    ]);
  });

  /*
   * The payload's record is the window's copy of a fact the store owns, and a
   * picker that sorted or appended to it in place would edit what the next
   * redraw reads.
   */
  it('answers with a copy rather than the stored array', () => {
    const available = fetched();
    modelChoicesFor(available, 'deepseek', 'deepseek-flash').models.push('x');
    expect(available['deepseek']).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });
});

describe('filterModels', () => {
  it('narrows whatever list it was handed, whichever provider that was', () => {
    expect(
      filterModels(['gemini-3.6-flash', 'gemini-3.1-pro'], 'PRO'),
    ).toEqual(['gemini-3.1-pro']);
    // An empty query is the list itself — "search" is a narrowing of it — and
    // the provider's order is preserved rather than re-ranked by the match.
    expect(filterModels(['b-flash', 'a-flash'], 'flash')).toEqual([
      'b-flash',
      'a-flash',
    ]);
    expect(filterModels(['gemini-3.6-flash'], '   ')).toEqual([
      'gemini-3.6-flash',
    ]);
    expect(filterModels(['gemini-3.6-flash'], 'llama')).toEqual([]);
  });
});
