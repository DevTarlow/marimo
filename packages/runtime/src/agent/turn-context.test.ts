/**
 * The facts a turn is told about the moment.
 *
 * Two failure modes matter more than the wording. A block that *claims* a task
 * turns every greeting into a status report, so the "none of this is a request"
 * line is asserted. And a block that guesses — at a mood, at an elapsed time
 * from a clock that moved backwards — is a claim the app cannot back, so the
 * cases where there is nothing to say are asserted too.
 */
import {describe, expect, it} from 'vitest';

import {ATTACHED_FILES_HEADING} from '@marimo/protocol';

import {attachedPaths, turnContext} from './turn-context.js';

/** A local wall-clock moment, so the assertions do not depend on the test host. */
function at(year: number, month: number, day: number, hour: number, minute = 0) {
  return new Date(year, month - 1, day, hour, minute);
}

describe('turnContext', () => {
  it('says nothing when no person asked', () => {
    // A job and a Discord mention pass no origin. Telling a job "this is the
    // first thing they have said" would be false.
    expect(
      turnContext({
        now: at(2026, 10, 11, 9),
        firstExchange: true,
        text: 'anything',
      }),
    ).toBeUndefined();
  });

  it('greets the first exchange with the date and time, and no elapsed line', () => {
    const block = turnContext({
      now: at(2026, 10, 11, 9, 41),
      origin: 'window',
      firstExchange: true,
      text: 'good morning',
    });

    expect(block).toContain('Sunday, 11 October');
    expect(block).toContain('09:41');
    expect(block).toContain('in the morning');
    expect(block).toContain('first thing they have said');
    expect(block).toContain('main window');
    // The line that keeps a fact from reading as an instruction.
    expect(block).toContain('None of them is a request on its own');
  });

  it('reads a return after hours as an elapsed time', () => {
    const block = turnContext({
      now: at(2026, 10, 11, 9),
      origin: 'window',
      firstExchange: false,
      lastActivity: at(2026, 10, 11, 5),
      text: 'back',
    });

    expect(block).toContain('about 4 hours ago');
    expect(block).not.toContain('first thing');
  });

  it('says nothing about elapsed time inside a continuing exchange', () => {
    // Under two minutes is the same exchange, and "about 0 minutes ago" is noise.
    const block = turnContext({
      now: at(2026, 10, 11, 9, 1),
      origin: 'window',
      firstExchange: false,
      lastActivity: at(2026, 10, 11, 9),
      text: 'and another thing',
    }) ?? '';

    expect(block).not.toContain('minutes ago');
    expect(block).not.toContain('last had activity');
  });

  it('never reports a negative age', () => {
    // A suspend, a timezone change, an edited index: the clock can go backwards.
    const block = turnContext({
      now: at(2026, 10, 11, 9),
      origin: 'window',
      firstExchange: false,
      lastActivity: at(2026, 10, 11, 11),
      text: 'hello',
    }) ?? '';

    expect(block).not.toContain('ago');
  });

  it('says which surface asked', () => {
    const pet = turnContext({
      now: at(2026, 10, 11, 9),
      origin: 'pet',
      firstExchange: true,
      text: 'hi',
    }) ?? '';

    expect(pet).toContain('floating companion');
  });

  it('names what was attached, and why it matters', () => {
    const block = turnContext({
      now: at(2026, 10, 11, 9),
      origin: 'window',
      firstExchange: true,
      text: `look at this\n\n${ATTACHED_FILES_HEADING}\n- src/a.ts\n- src/b.ts`,
    }) ?? '';

    expect(block).toContain('src/a.ts, src/b.ts');
    expect(block).toContain('why they wrote');
  });

  it('is total when the last activity does not parse', () => {
    const block = turnContext({
      now: at(2026, 10, 11, 9),
      origin: 'window',
      firstExchange: false,
      lastActivity: new Date(Number.NaN),
      text: 'hello',
    });

    expect(block).toBeTypeOf('string');
  });
});

describe('attachedPaths', () => {
  it('reads the block the composer writes', () => {
    expect(
      attachedPaths(`what is this\n\n${ATTACHED_FILES_HEADING}\n- one.ts\n- two.ts`),
    ).toEqual(['one.ts', 'two.ts']);
  });

  it('is empty for a message that merely mentions the heading', () => {
    expect(attachedPaths(`why does ${ATTACHED_FILES_HEADING} not work`)).toEqual(
      [],
    );
  });

  it('takes the last block, which is where the composer puts it', () => {
    // A user can type the heading themselves. The composer's own block comes
    // after whatever they typed, so the last one is the real list.
    expect(
      attachedPaths(
        `${ATTACHED_FILES_HEADING}\n- what-i-typed.ts\n\nlook at these\n\n` +
          `${ATTACHED_FILES_HEADING}\n- real.ts`,
      ),
    ).toEqual(['real.ts']);
  });

  it('stops at the first line that is not a bullet', () => {
    expect(
      attachedPaths(`${ATTACHED_FILES_HEADING}\n- one.ts\nand that is all`),
    ).toEqual(['one.ts']);
  });
});
