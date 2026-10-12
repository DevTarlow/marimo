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
  MAX_REVIEW_CHARS,
  parseProposals,
  renderConversation,
  reviewPrompt,
  runReview,
} from './review.js';

/** A well-formed answer, as the model is asked to give it. */
function answer(proposals: unknown): string {
  return JSON.stringify({proposals});
}

describe('the prompt', () => {
  it('carries the conversation', () => {
    expect(reviewPrompt('USER: I prefer tabs')).toContain(
      'USER: I prefer tabs',
    );
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
    expect(reviewPrompt('anything')).toMatch(
      /secrets, keys, passwords or tokens/u,
    );
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
    expect(reviewPrompt('anything')).toContain(
      'An empty list is the right answer',
    );
  });
});

describe('reading the answer', () => {
  it('reads a plain answer', () => {
    const proposals = parseProposals(
      answer([
        {section: 'Notes', text: 'Prefers tabs.', reason: 'they said so'},
      ]),
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
    expect(parseProposals(tricky)[0]?.text).toBe(
      'They write "quotes" like this.',
    );
  });

  describe('refuses what it cannot trust', () => {
    /*
     * Every one of these proposes *nothing*. Salvaging half a sentence would put
     * something nobody said into the agent's permanent memory.
     */
    it('proposes nothing for prose with no JSON', () => {
      expect(
        parseProposals('I could not find anything worth remembering.'),
      ).toEqual([]);
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
    expect(isNewProposal(proposal, '-   prefers   TABS over spaces.')).toBe(
      false,
    );
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

/** A stored event, in the shape the session service writes. */
function said(
  author: string,
  text: string,
): {
  author: string;
  content: {parts: Array<{text: string; thought?: boolean}>};
} {
  return {author, content: {parts: [{text}]}};
}

describe('rendering a conversation for the reviewer', () => {
  it('marks who said what', () => {
    const stretch = renderConversation([
      said('user', 'hello'),
      said('marimo', 'hi'),
    ]);
    expect(stretch.text).toBe('USER: hello\n\nAGENT: hi');
    expect(stretch.used).toBe(2);
  });

  /*
   * Reasoning is the model's working, not what was said. A review that read it
   * would propose things nobody stated — and a thought the model had and
   * discarded is exactly the kind of thing that should not become a belief.
   */
  it('leaves out reasoning', () => {
    const withThought = {
      author: 'marimo',
      content: {
        parts: [
          {text: 'maybe they like tabs', thought: true},
          {text: 'Noted.'},
        ],
      },
    };
    expect(renderConversation([withThought]).text).toBe('AGENT: Noted.');
  });

  it('leaves out events with no words, and still counts them read', () => {
    const stretch = renderConversation([
      {author: 'marimo', content: {parts: []}},
      said('user', 'hi'),
    ]);
    expect(stretch.text).toBe('USER: hi');
    expect(stretch.used).toBe(2);
  });

  it('is empty for a conversation with nothing in it', () => {
    expect(renderConversation([])).toEqual({text: '', used: 0});
  });

  /*
   * The cap exists because a review must not cost as much as the conversation
   * did. Which end it takes is the part that has to be right: a stretch from the
   * *earliest* unreviewed event can be followed by the next one, so a long
   * conversation is read in full over several looks. Taking the tail and then
   * advancing the watermark past the whole slice is how the beginning of a
   * conversation is marked read without ever reaching a prompt.
   */
  it('takes a stretch from the earliest event, and reports how far it reached', () => {
    const long = Array.from({length: 400}, (_, index) =>
      said('user', `message number ${String(index)} ${'x'.repeat(200)}`),
    );
    const stretch = renderConversation(long);

    expect(stretch.text.length).toBeLessThan(MAX_REVIEW_CHARS + 300);
    expect(stretch.text).toContain('message number 0 ');
    expect(stretch.used).toBeGreaterThan(0);
    expect(stretch.used).toBeLessThan(long.length);
    // Everything the count covers is in the text, and the next event is not.
    expect(stretch.text).toContain(
      `message number ${String(stretch.used - 1)} `,
    );
    expect(stretch.text).not.toContain(`message number ${String(stretch.used)} `);
  });

  it('always makes progress, even when one message is over the cap', () => {
    const huge = said('user', 'x'.repeat(MAX_REVIEW_CHARS + 5_000));
    const stretch = renderConversation([huge, said('user', 'after')]);

    expect(stretch.used).toBe(1);
    expect(stretch.text).toContain('x');
    expect(stretch.text).not.toContain('after');
  });
});

describe('running a review', () => {
  const events = [said('user', 'I always use pnpm, never npm.')];

  it('asks the model and returns what it proposed', async () => {
    const {proposals} = await runReview({
      events,
      memory: '',
      ask: async (prompt) => {
        // The conversation reached the prompt, which is the whole point.
        expect(prompt).toContain('never npm');
        return answer([
          {
            section: 'Notes',
            text: 'Uses pnpm, not npm.',
            reason: 'they said so',
          },
        ]);
      },
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.text).toBe('Uses pnpm, not npm.');
  });

  it('drops what the memory already holds', async () => {
    const {proposals} = await runReview({
      events,
      memory: '- Uses pnpm, not npm.',
      ask: async () =>
        answer([
          {
            section: 'Notes',
            text: 'Uses pnpm, not npm.',
            reason: 'they said so',
          },
        ]),
    });

    expect(proposals).toEqual([]);
  });

  /*
   * A review happens on its own while nobody is watching. An exception would
   * surface as an unhandled rejection at an idle moment, and there is nothing to
   * tell the user, because nothing happened.
   */
  it('answers nothing when the model fails', async () => {
    const {proposals} = await runReview({
      events,
      memory: '',
      ask: async () => {
        throw new Error('the provider refused');
      },
    });

    expect(proposals).toEqual([]);
  });

  it('does not ask at all about an empty conversation', async () => {
    let asked = false;
    const {proposals} = await runReview({
      events: [],
      memory: '',
      ask: async () => {
        asked = true;
        return answer([]);
      },
    });

    expect(proposals).toEqual([]);
    // Spending a request to be told nothing about nothing.
    expect(asked).toBe(false);
  });
});

/*
 * What the user refused.
 *
 * The queue alone cannot carry this: a proposal that is merely removed leaves no
 * trace, so a refused fact and one nobody has proposed yet look identical to the
 * next review. Both halves are here — the prompt that asks the model not to, and
 * the filter that holds when it does anyway — because a model that ignores an
 * instruction wastes a request, while a model that ignores the filter puts a
 * rejected fact back in front of the user.
 */
describe('facts the user refused', () => {
  const refused = [{text: 'Scans their receipts every Sunday.'}];
  const said = (text: string) => [{author: 'user', content: {parts: [{text}]}}];

  it('names them in the prompt and says why', () => {
    const prompt = reviewPrompt('USER: hello', refused);
    expect(prompt).toContain('Scans their receipts every Sunday.');
    expect(prompt).toContain('said no');
  });

  it('says nothing about refusals when there are none', () => {
    expect(reviewPrompt('USER: hello')).not.toContain('said no');
  });

  it('drops a proposal the user already refused', async () => {
    const {proposals} = await runReview({
      events: said('I scan receipts.'),
      memory: '',
      refused,
      ask: async () =>
        answer([
          {
            section: 'About the user',
            text: 'Scans their receipts every Sunday.',
            reason: 'they said so',
          },
        ]),
    });

    expect(proposals).toEqual([]);
  });

  /*
   * The model will re-word a refusal, and a filter that only caught exact repeats
   * would let it ask again in a way nobody could see. Collapsed and
   * case-insensitive — the same comparison the store dedupes with.
   */
  it('recognises a refusal that was re-worded in spacing or case', async () => {
    const {proposals} = await runReview({
      events: said('I scan receipts.'),
      memory: '',
      refused,
      ask: async () =>
        answer([
          {
            section: 'About the user',
            text: '  scans their RECEIPTS every   sunday. ',
            reason: 'they said so',
          },
        ]),
    });

    expect(proposals).toEqual([]);
  });

  /*
   * And the boundary: a refusal is of one sentence, not of its subject. A
   * substring match here would silence a whole topic because one sentence about
   * it was turned down.
   */
  it('still proposes a different fact that happens to share a word', async () => {
    const {proposals} = await runReview({
      events: said('Receipts are a chore.'),
      memory: '',
      refused,
      ask: async () =>
        answer([
          {
            section: 'About the user',
            text: 'Finds filing receipts a chore.',
            reason: 'they said so',
          },
        ]),
    });

    expect(proposals).toHaveLength(1);
  });

  it('applies the memory filter and the refusal filter together', async () => {
    const {proposals} = await runReview({
      events: said('lots of things'),
      memory: '- Works in Rust.',
      refused,
      ask: async () =>
        answer([
          {
            section: 'About the user',
            text: 'Works in Rust.',
            reason: 'already known',
          },
          {
            section: 'About the user',
            text: 'Scans their receipts every Sunday.',
            reason: 'refused',
          },
          {
            section: 'About the user',
            text: 'Has a dog named Bramble.',
            reason: 'new',
          },
        ]),
    });

    expect(proposals.map((entry) => entry.text)).toEqual([
      'Has a dog named Bramble.',
    ]);
  });
});
