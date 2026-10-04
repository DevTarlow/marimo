/**
 * Five-field cron, parsed and evaluated here rather than pulled in as a
 * dependency.
 *
 * Two things need the same answer: the main process, which decides when a
 * scheduled job next runs, and the validation a job's schedule gets before it is
 * stored — including inside the agent's own tools. Both live behind this one
 * module, so a schedule that the panel can describe is exactly a schedule the
 * runner can fire. Nothing here touches the clock: `nextRunAfter` takes the
 * `from` date, which is what makes the scheduling rules testable without
 * sleeping.
 *
 * The grammar is the standard Vixie one, with the usual liberties:
 *
 *   ┌ minute        0-59
 *   │ ┌ hour        0-23
 *   │ │ ┌ day of month 1-31
 *   │ │ │ ┌ month     1-12, or JAN…DEC
 *   │ │ │ │ ┌ day of week 0-6, 0 and 7 are Sunday, or SUN…SAT
 *   * * * * *
 *
 * Each field accepts `*`, a number, a range (`1-5`), a step (a slash, as in
 * `0-30/5`), and comma-separated lists of those. Times are local, because a job
 * like "every morning at nine" means the user's nine.
 */

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface CronSpec {
  /** The expression as written, trimmed. */
  expression: string;
  /** Sorted, de-duplicated minute values. */
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  /** 0 is Sunday. */
  daysOfWeek: number[];
  /** True when the field was written as `*`/star, which is the OR-rule's trigger. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/**
 * Parses one expression, or returns `null`.
 *
 * Returning `null` rather than throwing is deliberate: the callers are a zod
 * refinement (which wants a yes/no) and the scheduler (which wants to skip a job
 * someone hand-edited into nonsense), and neither has a useful place to catch
 * from.
 */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = parseField(minuteField, 0, 59, undefined);
  const hours = parseField(hourField, 0, 23, undefined);
  const daysOfMonth = parseField(domField, 1, 31, undefined);
  const months = parseField(monthField, 1, 12, MONTH_NAMES);
  const daysOfWeek = parseField(dowField, 0, 6, WEEKDAY_NAMES, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
    return null;
  }

  return {
    expression: expression.trim(),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: domField.trim() !== '*',
    dayOfWeekRestricted: dowField.trim() !== '*',
  };
}

/** A month, a date and a weekday, as `nextRunAfter` needs them. */
function matchesDay(spec: CronSpec, date: Date): boolean {
  if (!spec.months.includes(date.getMonth() + 1)) {
    return false;
  }

  const dayOfMonth = spec.daysOfMonth.includes(date.getDate());
  const dayOfWeek = spec.daysOfWeek.includes(date.getDay());

  /*
   * The Vixie rule: when both day fields are restricted the day matches if
   * *either* does — `0 0 1 * 1` is "the 1st, and every Monday", not "Mondays
   * that fall on the 1st". A `*` in either field leaves that field unrestricted,
   * which is the case where the rule looks like an AND.
   */
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) {
    return dayOfMonth || dayOfWeek;
  }
  if (spec.dayOfMonthRestricted) {
    return dayOfMonth;
  }
  if (spec.dayOfWeekRestricted) {
    return dayOfWeek;
  }
  return true;
}

/**
 * The first time at or after `from` that the schedule describes, or `null` if
 * there is none within a year — `0 0 30 2 *` is a real cron expression that can
 * never run, and saying so is better than a loop that never ends.
 *
 * The walk is minute by minute from the next whole minute. It is not the
 * cleverest possible algorithm, but a year of minutes is a bound the caller can
 * reason about, and the one call that could be hot — the scheduler's — runs at
 * most once a minute per app.
 */
export function nextRunAfter(spec: CronSpec, from: Date): Date | null {
  const start = new Date(from.getTime());
  // A second or a millisecond into the current minute must not count as "at or
  // after": the run for that minute has already been decided.
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const horizon = new Date(start.getTime());
  horizon.setFullYear(horizon.getFullYear() + 1);
  const horizonAt = horizon.getTime();

  const candidate = new Date(start.getTime());
  while (candidate.getTime() <= horizonAt) {
    if (
      spec.months.includes(candidate.getMonth() + 1) &&
      matchesDay(spec, candidate) &&
      spec.hours.includes(candidate.getHours()) &&
      spec.minutes.includes(candidate.getMinutes())
    ) {
      return candidate;
    }

    /*
     * DST: springing forward skips an hour, so the same wall-clock minute can
     * occur twice and other minutes never occur. Reading the clock back into the
     * candidate after each step keeps the walk on real instants, which is what
     * makes a 02:30 job simply not run on the day that hour does not exist.
     */
    candidate.setTime(candidate.getTime() + 60_000);
  }
  return null;
}

/** Convenience for the two callers that only want the answer, not the spec. */
export function nextCronRun(expression: string, from: Date): Date | null {
  const spec = parseCron(expression);
  return spec ? nextRunAfter(spec, from) : null;
}

/**
 * Parses one field into the values it allows, or `null`.
 *
 * `names` maps the three-letter tokens a cron user may write instead of a
 * number; `aliasTop` folds a value onto another (weekday 7 onto Sunday). Ranges
 * are still checked against `min`/`max` after aliasing, so `sun-sat` and `0-6`
 * are the same field written two ways.
 */
function parseField(
  field: string,
  min: number,
  max: number,
  names: Record<string, number> | undefined,
  aliasTop?: number,
): number[] | null {
  const value = field.trim();
  if (value.length === 0) {
    return null;
  }

  const values = new Set<number>();
  for (const part of value.split(',')) {
    const item = part.trim();
    if (item.length === 0) {
      return null;
    }

    const [rangeText, stepText, ...rest] = item.split('/');
    if (rest.length > 0 || rangeText === undefined || rangeText.length === 0) {
      return null;
    }

    let step = 1;
    if (stepText !== undefined) {
      // `*/0` and `*/abc` are refused rather than treated as 1: silently
      // accepting a nonsense step is how a job ends up running every minute.
      const parsed = Number(stepText.trim());
      if (!Number.isInteger(parsed) || parsed < 1) {
        return null;
      }
      step = parsed;
    }

    const bounds =
      rangeText === '*'
        ? {from: min, to: max}
        : readRange(rangeText, min, max, names, aliasTop);
    if (!bounds) {
      return null;
    }

    for (let current = bounds.from; current <= bounds.to; current += step) {
      values.add(current);
    }
  }

  return values.size === 0 ? null : [...values].sort((a, b) => a - b);
}

/** A single value or an inclusive range, after names and aliases are resolved. */
function readRange(
  text: string,
  min: number,
  max: number,
  names: Record<string, number> | undefined,
  aliasTop: number | undefined,
): {from: number; to: number} | null {
  const [fromText, toText, ...rest] = text.split('-');
  if (rest.length > 0 || fromText === undefined) {
    return null;
  }

  const from = readValue(fromText, min, max, names, aliasTop);
  if (from === null) {
    return null;
  }
  if (toText === undefined) {
    return {from, to: from};
  }

  const to = readValue(toText, min, max, names, aliasTop);
  if (to === null) {
    return null;
  }
  // A backwards range is a mistake, not a wrap-around: `5-1` does not mean
  // "five through midnight". Refusing it is the honest answer.
  if (to < from) {
    return null;
  }
  return {from, to};
}

function readValue(
  text: string,
  min: number,
  max: number,
  names: Record<string, number> | undefined,
  aliasTop: number | undefined,
): number | null {
  const trimmed = text.trim().toLowerCase();
  const named = names?.[trimmed.slice(0, 3)];
  const raw = named ?? Number(trimmed);
  if (!Number.isInteger(raw)) {
    return null;
  }
  // `7` is an accepted spelling of Sunday, but only where the alias applies:
  // for every other field the value has to be inside the field's own bounds.
  if (aliasTop !== undefined && raw === aliasTop) {
    return min;
  }
  if (raw < min || raw > max) {
    return null;
  }
  return raw;
}

/**
 * Plain English for a card, so the user does not have to read cron.
 *
 * It is deliberately a small phrasebook rather than a translator: anything it
 * does not recognise comes back as the expression itself, which is still the
 * truth and is what the panel shows beside the name anyway.
 */
export function describeCron(expression: string): string {
  const spec = parseCron(expression);
  if (!spec) {
    return expression;
  }

  const time = describeTimes(spec);
  if (!time) {
    return expression;
  }

  /*
   * "every day" is noise beside an interval — "every 15 minutes every day" says
   * nothing the interval did not — but it is the missing half of a bare clock
   * time, where it is the difference between "at 09:00" and "at 09:00 on
   * weekdays". `describeTimes` answers `interval: true` for the first case.
   */
  const day = describeDay(spec, time.interval);
  return day.length > 0 ? `${time.text} ${day}` : time.text;
}

/**
 * "every minute", "every 15 minutes", "at 09:00", "at 09:00 and 17:30".
 *
 * `interval` says the phrase already covers every day, which is what lets the
 * caller leave "every day" off it.
 */
function describeTimes(
  spec: CronSpec,
): {text: string; interval: boolean} | null {
  const step = regularStep(spec.minutes);
  if (step !== null && spec.hours.length === 24) {
    return {
      text: step === 1 ? 'every minute' : `every ${step} minutes`,
      interval: true,
    };
  }
  if (spec.minutes.length > 4 || spec.hours.length * spec.minutes.length > 8) {
    return null;
  }

  const times: string[] = [];
  for (const hour of spec.hours) {
    for (const minute of spec.minutes) {
      times.push(
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      );
    }
  }
  if (times.length === 0) {
    return null;
  }
  return {text: `at ${times.join(', ')}`, interval: false};
}

/**
 * A step that covers the whole field, recovered from the flattened values: a
 * fifteen-minute step and the list `0,15,30,45` are the same schedule and read
 * the same way.
 */
function regularStep(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const step = values[1]! - values[0]!;
  if (step < 1) {
    return null;
  }
  for (let index = 2; index < values.length; index += 1) {
    if (values[index]! - values[index - 1]! !== step) {
      return null;
    }
  }
  // A single value is a time, not an interval, regardless of where it sits.
  return step;
}

/**
 * "every day", "on the 1st", "on Mondays", "in March", or a combination.
 *
 * `interval` is passed through from `describeTimes`: a phrase that already means
 * every day needs no "every day" after it, so this answers an empty string
 * unless a month is pinned — "every 15 minutes in March" is still worth saying.
 */
function describeDay(spec: CronSpec, interval: boolean): string {
  const parts: string[] = [];
  const everyDay = !spec.dayOfMonthRestricted && !spec.dayOfWeekRestricted;

  if (everyDay) {
    if (!interval) {
      parts.push('every day');
    }
  } else if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) {
    // The OR rule, said out loud.
    parts.push(
      `on the ${ordinals(spec.daysOfMonth)} or on ${weekdays(spec.daysOfWeek)}`,
    );
  } else if (spec.dayOfMonthRestricted) {
    parts.push(`on the ${ordinals(spec.daysOfMonth)}`);
  } else {
    parts.push(`on ${weekdays(spec.daysOfWeek)}`);
  }

  if (spec.months.length < 12) {
    parts.push(`in ${monthNames(spec.months)}`);
  }
  return parts.join(' ');
}

function ordinals(days: number[]): string {
  return days.map((day) => `${day}${suffix(day)}`).join(', ');
}

function suffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) {
    return 'th';
  }
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

function weekdays(days: number[]): string {
  const names = [
    'Sundays',
    'Mondays',
    'Tuesdays',
    'Wednesdays',
    'Thursdays',
    'Fridays',
    'Saturdays',
  ];
  return days.map((day) => names[day] ?? String(day)).join(', ');
}

function monthNames(months: number[]): string {
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return months.map((month) => names[month - 1] ?? String(month)).join(', ');
}
