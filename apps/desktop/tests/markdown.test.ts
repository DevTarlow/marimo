/**
 * Markdown, parsed into data rather than into HTML.
 *
 * The security property is the reason for the shape: an answer is untrusted
 * input, and there is no `dangerouslySetInnerHTML` anywhere in this app. What
 * these tests check is that the constructs a model actually writes come out
 * right, and that everything else comes out as the characters that were typed —
 * legible, rather than mangled or dropped.
 */
import {describe, expect, it} from 'vitest';

import {isSafeHref, parseInline, parseMarkdown} from '../src/renderer/markdown.js';

describe('block parsing', () => {
  it('reads a paragraph', () => {
    expect(parseMarkdown('Just some words.')).toEqual([
      {kind: 'paragraph', text: 'Just some words.'},
    ]);
  });

  it('joins a wrapped paragraph into one block', () => {
    // A model wraps its prose, and a newline inside a paragraph is not a break.
    expect(parseMarkdown('one\ntwo')).toEqual([
      {kind: 'paragraph', text: 'one\ntwo'},
    ]);
  });

  it('separates paragraphs on a blank line', () => {
    expect(parseMarkdown('one\n\ntwo')).toHaveLength(2);
  });

  it('reads headings by level', () => {
    expect(parseMarkdown('## Results')).toEqual([
      {kind: 'heading', level: 2, text: 'Results'},
    ]);
  });

  it('reads a fenced code block with its language', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n```')).toEqual([
      {kind: 'code', language: 'ts', text: 'const a = 1;'},
    ]);
  });

  /*
   * The case that matters while a reply is still streaming: the closing fence
   * has not arrived yet. Treating the body as prose would reformat the code as
   * it arrives — every line becoming a paragraph, `#` becoming a heading — and
   * then snap back at the end.
   */
  it('takes the rest of the answer for an unterminated fence', () => {
    expect(parseMarkdown('```\nline one\n# not a heading')).toEqual([
      {kind: 'code', language: '', text: 'line one\n# not a heading'},
    ]);
  });

  it('does not parse markdown inside a code block', () => {
    const blocks = parseMarkdown('```\n- not a list\n**not bold**\n```');
    expect(blocks).toEqual([
      {
        kind: 'code',
        language: '',
        text: '- not a list\n**not bold**',
      },
    ]);
  });

  it('keeps a blank line inside a code block', () => {
    expect(parseMarkdown('```\na\n\nb\n```')).toEqual([
      {kind: 'code', language: '', text: 'a\n\nb'},
    ]);
  });

  it('reads a bullet list', () => {
    expect(parseMarkdown('- one\n- two')).toEqual([
      {kind: 'list', ordered: false, start: 1, items: ['one', 'two']},
    ]);
  });

  it('reads an ordered list, keeping where it started', () => {
    expect(parseMarkdown('3. three\n4. four')).toEqual([
      {kind: 'list', ordered: true, start: 3, items: ['three', 'four']},
    ]);
  });

  it('appends a wrapped line to the item it belongs to', () => {
    // A list item long enough to wrap is the common case in an answer, and
    // making it two items would be visibly wrong.
    expect(parseMarkdown('- a long item\n  continued here\n- second')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: ['a long item continued here', 'second'],
      },
    ]);
  });

  it('does not swallow a heading into a list', () => {
    const blocks = parseMarkdown('- one\n# Heading');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({kind: 'heading', level: 1, text: 'Heading'});
  });

  it('reads a quote', () => {
    expect(parseMarkdown('> quoted\n> more')).toEqual([
      {kind: 'quote', text: 'quoted\nmore'},
    ]);
  });

  it('reads a horizontal rule', () => {
    expect(parseMarkdown('---')).toEqual([{kind: 'rule'}]);
  });

  /*
   * The direction this parser is allowed to fail in. An unhandled construct
   * shows up as the characters the model typed — legible — rather than as
   * mangled formatting or as nothing at all.
   */
  it('leaves a construct it does not know as literal text', () => {
    expect(parseMarkdown('| a | b |\n|---|---|')).toEqual([
      {kind: 'paragraph', text: '| a | b |\n|---|---|'},
    ]);
  });

  it('leaves raw HTML as text rather than markup', () => {
    // Rendering this would be the whole failure mode the design avoids: the
    // parser would be turning model output into markup.
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([
      {kind: 'paragraph', text: '<script>alert(1)</script>'},
    ]);
  });
});

describe('inline parsing', () => {
  it('reads plain text', () => {
    expect(parseInline('hello')).toEqual([{kind: 'text', text: 'hello'}]);
  });

  it('reads inline code', () => {
    expect(parseInline('use `npm test` now')).toEqual([
      {kind: 'text', text: 'use '},
      {kind: 'code', text: 'npm test'},
      {kind: 'text', text: ' now'},
    ]);
  });

  it('reads bold and italic', () => {
    expect(parseInline('**bold** and *italic*')).toEqual([
      {kind: 'strong', text: 'bold'},
      {kind: 'text', text: ' and '},
      {kind: 'em', text: 'italic'},
    ]);
  });

  it('reads a link', () => {
    expect(parseInline('see [the docs](https://example.com/x)')).toEqual([
      {kind: 'text', text: 'see '},
      {kind: 'link', href: 'https://example.com/x', text: 'the docs'},
    ]);
  });

  /*
   * Taken first, and never examined again. This is why one pass is used rather
   * than a sequence of replacements: a second pass over the contents would find
   * the asterisks inside the code span and make them bold.
   */
  it('does not read constructs inside a code span', () => {
    expect(parseInline('`**not bold**`')).toEqual([
      {kind: 'code', text: '**not bold**'},
    ]);
  });

  it('handles several constructs in one line', () => {
    expect(parseInline('**a** `b` [c](https://d.e)')).toEqual([
      {kind: 'strong', text: 'a'},
      {kind: 'text', text: ' '},
      {kind: 'code', text: 'b'},
      {kind: 'text', text: ' '},
      {kind: 'link', href: 'https://d.e', text: 'c'},
    ]);
  });

  it('leaves an unmatched marker as text', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{kind: 'text', text: '2 * 3 = 6'}]);
  });
});

describe('which links are made clickable', () => {
  it('allows the ordinary ones', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:sam@example.com')).toBe(true);
    expect(isSafeHref('#section')).toBe(true);
  });

  /*
   * The one place a construct in an answer could be dangerous rather than merely
   * ugly. An answer can contain either of these because it may be quoting a page
   * that does.
   */
  it('refuses a scheme that would run code', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('  javascript:alert(1)  ')).toBe(false);
  });

  it('refuses something that is not a link at all', () => {
    expect(isSafeHref('not a url')).toBe(false);
  });
});
