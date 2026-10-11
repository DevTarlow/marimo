/**
 * The two strings that must never be assembled by hand.
 *
 * There is no failure to reproduce here and no error to assert: a missing prefix
 * produces a vector of the right width from the right model, and the only
 * symptom is that search finds slightly less than it should. That is exactly why
 * this file exists — the assertions below are the only place the recipe is
 * written down in executable form, and deleting a prefix breaks a test rather
 * than a user's results six months later.
 */
import {describe, expect, it} from 'vitest';

import {
  CODE_QUERY_PREFIX,
  documentText,
  QUERY_PREFIX,
  queryText,
} from './prefixes.js';

describe('queryText', () => {
  it('prefixes the question the way the model was trained', () => {
    expect(queryText('where is the retry logic')).toBe(
      'task: search result | query: where is the retry logic',
    );
    expect(QUERY_PREFIX).toBe('task: search result | query:');
  });

  /*
   * A query often arrives as a block of lines — a stack trace, or a chunk a
   * caller read back — and the model is trained on a one-line question. Leaving
   * the newlines in would put the prefix in front of a shape it was not trained
   * on, which is a silent difference in a value nobody can inspect.
   */
  it('collapses whitespace so a block of lines reads as one question', () => {
    expect(queryText('  what\n  uses\tretries?  ')).toBe(
      'task: search result | query: what uses retries?',
    );
  });

  /*
   * The other query prompt, for a folder that is mostly code. Same question, same
   * document side, one word of instruction different — which is exactly the kind
   * of difference that has to be asserted, because a search under the wrong one
   * returns a plausible list rather than an error.
   */
  it('asks a code question the code way when the folder is code', () => {
    expect(queryText('where is the retry logic', 'code')).toBe(
      'task: code retrieval | query: where is the retry logic',
    );
    expect(CODE_QUERY_PREFIX).toBe('task: code retrieval | query:');
  });

  it('leaves an empty question as the bare prefix', () => {
    // The space after the colon belongs to the recipe and is kept, so an empty
    // query is the prefix and nothing else rather than a shape with the space
    // missing from a different position.
    expect(queryText('   ')).toBe(`${QUERY_PREFIX} `);
  });
});

describe('documentText', () => {
  it('writes the document side as a title and a body', () => {
    expect(documentText('src/net/retry.ts', 'export function withRetry() {}')).toBe(
      'title: src/net/retry.ts | text: export function withRetry() {}',
    );
  });

  /*
   * `title: none` is the recipe's own answer for a document with no name, and
   * the alternative — leaving the title out — produces `title: | text:`, which
   * is a shape the model has never been shown.
   */
  it('says none rather than leaving the title empty', () => {
    expect(documentText('', 'a memory bullet')).toBe(
      'title: none | text: a memory bullet',
    );
    expect(documentText('   ', 'a memory bullet')).toBe(
      'title: none | text: a memory bullet',
    );
  });

  it('keeps the body exactly as given, because it is quoted back to the user', () => {
    const body = 'if (x) {\n  return;\n}';
    expect(documentText('a.ts', body)).toBe(`title: a.ts | text: ${body}`);
  });
});
