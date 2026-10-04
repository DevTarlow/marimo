/**
 * Noticing what is worth remembering.
 *
 * The parsing is what most of this covers, because the model's answer is
 * untrusted input and the failure mode is specific and bad: a half-understood
 * sentence written into a file that is injected into every future system prompt
 * is not a wrong answer once, it is a wrong belief the agent carries forward.
 */
import {describe, expect, it} from 'vitest';

import {
  isNewProposal,
  MAX_PROPOSALS,
  parseProposals,
  reviewPrompt,
} from './review.js';

/** A well-formed answer, as the model is asked to give it. */
function answer(proposals: unknown): string {
  return JSON.stringify({proposals});
}

describe('the prompt', () => {
  it('carries the conversation', () => {
    expect(reviewPrompt('USER: I prefer tabs')).toContain('USER: I prefer tabs');
  });

  /*
   * The exclusions are what make the queue short enough to read. A model asked
   * for "facts worth remembering" proposes that the user said hello.
   */
  it('says what not to propose, not only what to', () => {
    const prompt = reviewPrompt('anything');
    expect(prompt).toContain('Do not propose');
    expect(prompt).toContain('pleasantries');
    expect(prompt).toContain('inferred rather than were told');
  });

  /*
   * Memory is injected into every future system prompt, so a key that reached it
   * would be sent to the provider on every turn of every later conversation.
   * Named explicitly, because "do not propose secrets" is not something a model
   * reliably infers from "facts worth keeping".
   */
  it('forbids secrets in as many words', () => {
    expect(reviewPrompt('anything')).toMatch(/secrets, keys, passwords or tokens/u);
  });

  it('asks for JSON and says how much of it', () => {
    const prompt = reviewPrompt('anything');
    expect(prompt).toContain('"proposals"');
    expect(prompt).toContain(`At most ${String(MAX_PROPOSALS)}`);
  });

  /*
   * Said plainly, because a model asked to find something will find something —
   * and a queue that arrives with two proposals after every conversation is one
   * the user stops opening.
   */
  it('says that nothing is a good answer', () => {
    expect(reviewPrompt('anything')).toContain('An empty list is the right answer');
  });
});

describe('reading the answer', () => {
  it('reads a plain answer', () => {
    const proposals = parseProposals(
      answer([{section: 'Notes', text: 'Prefers tabs.', reason: 'they said so'}]),
    );
    expect(proposals).toEqual([
      {section: 'Notes', text: 'Prefers tabs.', reason: 'they said so'},
    ]);
  });

  it('reads an empty list', () => {
    expect(parseProposals(answer([]))).toEqual([]);
  });

  /*
   * Models wrap JSON in a fenced block or a sentence often enough that refusing
   * those would make the feature look broken rather than cautious.
   */
  it('finds the JSON inside a fenced block', () => {
    const wrapped = `Here is what I found:\n\n\`\`\`json\n${answer([
      {section: 'Notes', text: 'Uses pnpm.', reason: 'stated'},
    ])}\n\`\`\`\n`;
    expect(parseProposals(wrapped)).toHaveLength(1);
  });

  it('finds the JSON after a sentence', () => {
    const wrapped = `Sure! ${answer([
      {section: 'Notes', text: 'Uses pnpm.', reason: 'stated'},
    ])}`;
    expect(parseProposals(wrapped)).toHaveLength(1);
  });

  /*
   * A brace inside a proposed fact would end the object early if the scan did
   * not skip strings, and the parser would be handed a truncated document —
   * which fails, silently, as "nothing to propose".
   */
  it('is not confused by braces inside a fact', () => {
    const tricky = answer([
      {
        section: 'Notes',
        text: 'Their config is {"strict": true}.',
        reason: 'they showed it',
      },
    ]);
    expect(parseProposals(tricky)).toHaveLength(1);
    expect(parseProposals(tricky)[0]?.text).toContain('"strict": true');
  });

  it('is not confused by an escaped quote inside a fact', () => {
    const tricky = answer([
      {
        section: 'Notes',
        text: 'They write "quotes" like this.',
        reason: 'observed',
      },
    ]);
    expect(parseProposals(tricky)[0]?.text).toBe('They write "quotes" like this.');
  });

  describe('refuses what it cannot trust', () => {
    /*
     * Every one of these proposes *nothing*. Salvaging half a sentence would put
     * something nobody said into the agent's permanent memory.
     */
    it('proposes nothing for prose with no JSON', () => {
      expect(parseProposals('I could not find anything worth remembering.')).toEqual([]);
    });

    it('proposes nothing for malformed JSON', () => {
      expect(parseProposals('{"proposals":[{"section":')).toEqual([]);
    });

    it('proposes nothing for an empty answer', () => {
      expect(parseProposals('')).toEqual([]);
    });

    it('proposes nothing when the shape is wrong', () => {
      expect(parseProposals('{"facts":["a"]}')).toEqual([]);
      expect(parseProposals('{"proposals":"not an array"}')).toEqual([]);
      expect(parseProposals('["a","b"]')).toEqual([]);
    });

    it('drops the whole answer when one proposal is invalid', () => {
      // Not "keeps the good ones": a model that wrote one malformed entry may
      // have meant something different by the others, and a partial read is how
      // a half-sentence gets through.
      const mixed = answer([
        {section: 'Notes', text: 'A real fact.', reason: 'stated'},
        {section: 'Notes', reason: 'no text at all'},
      ]);
      expect(parseProposals(mixed)).toEqual([]);
    });

    /*
     * `text` becomes a line in a file injected into every future prompt. A model
     * that answers with an essay would otherwise put the essay in the system
     * prompt forever.
     */
    it('refuses an essay where a fact belongs', () => {
      expect(
        parseProposals(
          answer([{section: 'Notes', text: 'x'.repeat(500), reason: 'stated'}]),
        ),
      ).toEqual([]);
    });

    it('refuses more than it was allowed to propose', () => {
      const many = Array.from({length: MAX_PROPOSALS + 1}, (_, index) => ({
        section: 'Notes',
        text: `Fact number ${String(index)}.`,
        reason: 'stated',
      }));
      expect(parseProposals(answer(many))).toEqual([]);
    });
  });
});

describe('whether a fact is already known', () => {
  const proposal = {
    section: 'Notes',
    text: 'Prefers tabs over spaces.',
    reason: 'stated',
  };

  it('is new against empty memory', () => {
    expect(isNewProposal(proposal, '')).toBe(true);
  });

  it('is not new when the memory already says it', () => {
    expect(isNewProposal(proposal, '- Prefers tabs over spaces.')).toBe(false);
  });

  /*
   * The same fact with different spacing is the same fact — and proposing it
   * again is how a queue stops being read.
   */
  it('is not new when only the spacing differs', () => {
    expect(isNewProposal(proposal, '-   prefers   TABS over spaces.')).toBe(false);
  });

  it('is new when the memory says something unrelated', () => {
    expect(isNewProposal(proposal, '- Works in Rust.')).toBe(true);
  });

  /*
   * And when it says the *opposite*, which is the case the queue most needs to
   * show. "Prefers spaces over tabs" is not the same fact as "prefers tabs over
   * spaces" — it is a contradiction, and it means either the memory is stale or
   * the new reading is wrong. Deciding that is the user's job, so it is
   * proposed rather than suppressed for looking similar.
   */
  it('is new when the memory says the opposite', () => {
    expect(isNewProposal(proposal, '- Prefers spaces over tabs.')).toBe(true);
  });

  /*
   * The other direction, coarsely: a proposal containing an existing line is
   * usually the same fact with more context. Compared by line and only for lines
   * of a reasonable length, so a long memory file does not swallow every short
   * proposal that happens to include a common word.
   */
  it('treats a longer version of a known fact as known', () => {
    expect(
      isNewProposal(proposal, '- Prefers tabs over spaces, and says so often.'),
    ).toBe(true);
  });

  it('is not fooled by a short memory line', () => {
    // "notes" appearing in the memory must not make every proposal a duplicate.
    expect(isNewProposal(proposal, 'notes')).toBe(true);
  });

  it('refuses an empty proposal', () => {
    expect(isNewProposal({section: 'Notes', text: '  ', reason: ''}, '')).toBe(
      false,
    );
  });
});
