/**
 * The schedule grammar and the next-run maths.
 *
 * These are the rules a job's "times it runs" rests on, so the interesting cases
 * are the ones a user would not think to try: the day-of-month / day-of-week OR
 * rule, a step that is not anchored at zero, weekday and month names, and a date
 * that simply never comes.
 *
 * The test sits beside its source but is run by the workspace's test runner
 * (`pnpm --filter @marimo/protocol test`, from the same vitest install the
 * desktop app uses), because this package has no runner of its own.
 *
 * Every expectation is written in local time, because that is what the parser
 * means: `0 9 * * *` is nine in the morning where the user is.
 */
import {describe, expect, it} from 'vitest';

import {describeCron, nextCronRun, nextRunAfter, parseCron} from './cron.js';

/** A local-time date, so the assertions read the way the schedule does. */
function local(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('parseCron', () => {
  it('accepts a plain five-field expression', () => {
    const spec = parseCron('0 9 * * *');
    expect(spec).not.toBeNull();
    expect(spec?.minutes).toEqual([0]);
    expect(spec?.hours).toEqual([9]);
    expect(spec?.dayOfMonthRestricted).toBe(false);
    expect(spec?.dayOfWeekRestricted).toBe(false);
  });

  it('expands lists, ranges and steps', () => {
    expect(parseCron('1,30 9-11 * * *')?.minutes).toEqual([1, 30]);
    expect(parseCron('1,30 9-11 * * *')?.hours).toEqual([9, 10, 11]);
    expect(parseCron('*/15 * * * *')?.minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 0-12/6 * * *')?.hours).toEqual([0, 6, 12]);
    // A step without an anchor starts where the range does, not where it fits.
    expect(parseCron('5-25/10 * * * *')?.minutes).toEqual([5, 15, 25]);
  });

  it('accepts weekday and month names, case-insensitively', () => {
    expect(parseCron('0 9 * * mon-fri')?.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 9 * jan,mar *')?.months).toEqual([1, 3]);
  });

  it('treats both 7 and sun as Sunday', () => {
    expect(parseCron('0 0 * * 7')?.daysOfWeek).toEqual([0]);
    expect(parseCron('0 0 * * sun')?.daysOfWeek).toEqual([0]);
  });

  it('refuses anything it cannot mean literally', () => {
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * 0 *',
      '* * * * 8',
      '*/0 * * * *',
      '*/x * * * *',
      '5-1 * * * *',
      '1,,2 * * * *',
      '1- * * * *',
      'x * * * *',
    ]) {
      expect(parseCron(bad), bad).toBeNull();
    }
  });
});

describe('nextRunAfter', () => {
  it('returns the next matching minute, never the current one', () => {
    const spec = parseCron('* * * * *')!;
    expect(nextRunAfter(spec, local(2026, 5, 1, 10, 0))).toEqual(
      local(2026, 5, 1, 10, 1),
    );
    // A second into the minute is still "the next minute", not this one.
    const aSecondIn = new Date(local(2026, 5, 1, 10, 0).getTime() + 1000);
    expect(nextRunAfter(spec, aSecondIn)).toEqual(local(2026, 5, 1, 10, 1));
  });

  it('walks forward to the named hour', () => {
    const spec = parseCron('0 9 * * *')!;
    expect(nextRunAfter(spec, local(2026, 5, 1, 10, 0))).toEqual(
      local(2026, 5, 2, 9, 0),
    );
    expect(nextRunAfter(spec, local(2026, 5, 1, 8, 59))).toEqual(
      local(2026, 5, 1, 9, 0),
    );
  });

  it('crosses a month boundary', () => {
    const spec = parseCron('30 23 31 * *')!;
    // May has a 31st and April does not, so the last minute of May is the next
    // match after the start of April.
    expect(nextRunAfter(spec, local(2026, 4, 1))).toEqual(
      local(2026, 5, 31, 23, 30),
    );
  });

  it('skips months that are not named', () => {
    const spec = parseCron('0 0 1 mar *')!;
    expect(nextRunAfter(spec, local(2026, 4, 1))).toEqual(local(2027, 3, 1));
  });

  /*
   * The Vixie rule, which is the one place cron surprises people: with both day
   * fields restricted the day matches if either does, so this fires on the 1st
   * of the month *and* every Monday.
   */
  it('ORs a restricted day-of-month with a restricted day-of-week', () => {
    const spec = parseCron('0 0 1 * mon')!;
    // 1 May 2026 is a Friday, so the 4th (a Monday) comes first.
    expect(nextRunAfter(spec, local(2026, 5, 1, 0, 0))).toEqual(
      local(2026, 5, 4),
    );
    // From the 4th, the next is the 11th (Monday) before 1 June.
    expect(nextRunAfter(spec, local(2026, 5, 4, 0, 0))).toEqual(
      local(2026, 5, 11),
    );
  });

  it('honours a restricted day-of-week on its own', () => {
    const spec = parseCron('0 12 * * sat,sun')!;
    // 1 May 2026 is a Friday, so the first weekend day after it is the 2nd.
    expect(nextRunAfter(spec, local(2026, 5, 1, 12, 0))).toEqual(
      local(2026, 5, 2, 12, 0),
    );
  });

  it('finds the first step after an arbitrary minute', () => {
    const spec = parseCron('*/15 * * * *')!;
    expect(nextRunAfter(spec, local(2026, 5, 1, 10, 7))).toEqual(
      local(2026, 5, 1, 10, 15),
    );
    expect(nextRunAfter(spec, local(2026, 5, 1, 10, 45))).toEqual(
      local(2026, 5, 1, 11, 0),
    );
  });

  it('answers null for a date that never arrives', () => {
    expect(nextCronRun('0 0 30 2 *', local(2026, 1, 1))).toBeNull();
  });

  it('answers null for an expression it cannot parse', () => {
    expect(nextCronRun('not a cron', local(2026, 1, 1))).toBeNull();
  });
});

describe('describeCron', () => {
  it('reads a daily job out loud', () => {
    expect(describeCron('0 9 * * *')).toBe('at 09:00 every day');
  });

  it('reads an interval', () => {
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(describeCron('* * * * *')).toBe('every minute');
    expect(describeCron('*/15 * * * mon')).toBe('every 15 minutes on Mondays');
  });

  it('lists more than one time a day', () => {
    expect(describeCron('0 9,17 * * *')).toBe('at 09:00, 17:00 every day');
  });

  it('names the weekday', () => {
    expect(describeCron('0 12 * * sun')).toBe('at 12:00 on Sundays');
  });

  it('says the OR rule out loud', () => {
    expect(describeCron('0 0 1 * mon')).toBe(
      'at 00:00 on the 1st or on Mondays',
    );
  });

  it('names the month when one is pinned', () => {
    expect(describeCron('0 0 1 mar *')).toBe('at 00:00 on the 1st in March');
  });

  it('falls back to the expression when the times are too many to list', () => {
    // Seven hours at four different minutes each is 28 times a day: correct, and
    // unreadable, so the card shows the schedule itself.
    expect(describeCron('0,7,23,41 6,9,12,15,18,21,23 * * *')).toBe(
      '0,7,23,41 6,9,12,15,18,21,23 * * *',
    );
    expect(describeCron('nonsense')).toBe('nonsense');
  });
});
