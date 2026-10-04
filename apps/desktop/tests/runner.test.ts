/**
 * The runner's due-job arithmetic.
 *
 * This is the part of the background service that decides whether anything
 * happens at all, and it is the part that fails silently: a job that is due but
 * not recognised simply never runs, and a service that looks healthy and does
 * nothing is the worst version of this feature.
 */
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {Job} from '@marimo/protocol';
import {resolveAppPaths} from '@marimo/runtime';

import {
  describeReport,
  dueJobs,
  inspectDueJobs,
  main,
  resolveRunnerPaths,
  type DueJob,
} from '../src/runner/run-due.js';
import {PRODUCT_NAME, USER_DATA_ENV} from '../src/shared/product.js';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Morning summary',
    description: 'Summarise the overnight work.',
    schedules: ['0 9 * * *'],
    enabled: true,
    profileId: 'profile-1',
    sessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const NOON = new Date('2026-01-02T12:00:00.000Z');

describe('dueJobs', () => {
  it('reports a job whose watched occurrence has passed', () => {
    const due = dueJobs([job({dueAt: '2026-01-02T09:00:00.000Z'})], NOON);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({id: 'job-1', name: 'Morning summary'});
  });

  it('does not report one whose occurrence is still ahead', () => {
    const due = dueJobs([job({dueAt: '2026-01-02T18:00:00.000Z'})], NOON);
    expect(due).toEqual([]);
  });

  it('treats an occurrence exactly now as due', () => {
    const due = dueJobs([job({dueAt: NOON.toISOString()})], NOON);
    expect(due).toHaveLength(1);
  });

  it('never reports a paused job, however overdue', () => {
    const due = dueJobs(
      [job({enabled: false, dueAt: '2020-01-01T00:00:00.000Z'})],
      NOON,
    );
    expect(due).toEqual([]);
  });

  it('ignores a job that has never been scheduled', () => {
    // `dueAt` is absent until the schedule has been evaluated once. Absent is
    // not "due since the beginning of time".
    expect(dueJobs([job()], NOON)).toEqual([]);
  });

  it('ignores an unparseable occurrence rather than firing on it', () => {
    // A hand-edited or half-written file must not become a job that runs on
    // every single tick, which is what treating "unreadable" as "due" would do.
    expect(dueJobs([job({dueAt: 'not a date'})], NOON)).toEqual([]);
  });

  it('keeps the fields a log line needs', () => {
    const due = dueJobs(
      [job({id: 'abc', name: 'Nightly', profileId: 'p2', dueAt: '2026-01-01T00:00:00.000Z'})],
      NOON,
    );
    expect(due[0]).toEqual({
      id: 'abc',
      name: 'Nightly',
      profileId: 'p2',
      dueAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports every agent\'s jobs, not only the one a window would show', () => {
    // The app's own scheduler only runs the active profile's jobs. A background
    // service that inherited that rule would leave every other agent dormant
    // whenever the user happened to be looking at a different one.
    const due = dueJobs(
      [
        job({id: 'a', profileId: 'p1', dueAt: '2026-01-01T00:00:00.000Z'}),
        job({id: 'b', profileId: 'p2', dueAt: '2026-01-01T00:00:00.000Z'}),
      ],
      NOON,
    );
    expect(due.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('resolveRunnerPaths', () => {
  it('honours the override the app also honours', () => {
    const paths = resolveRunnerPaths({[USER_DATA_ENV]: '/tmp/anything'});
    expect(paths.userData).toBe('/tmp/anything');
    expect(paths.jobs).toBe('/tmp/anything/jobs.json');
  });

  it('derives the platform directory when there is no override', () => {
    const paths = resolveRunnerPaths({HOME: `/home/${PRODUCT_NAME}`});
    // Derived rather than read from the test's own home, so the assertion holds
    // on any machine: what matters is that the product name is appended.
    expect(paths.userData).toContain(PRODUCT_NAME);
  });
});

describe('describeReport', () => {
  const base = {
    userData: '/data/marimo',
    total: 0,
    enabled: 0,
    due: [] as DueJob[],
  };

  it('says plainly when there is nothing to do', () => {
    const lines = describeReport(base).join('\n');
    expect(lines).toContain('nothing due');
  });

  it('does not claim to have run anything', () => {
    // The report is the only evidence a user has about what the background
    // service did. Saying "ran" when the host is not wired up yet would be the
    // one lie that makes the whole feature untrustworthy.
    const lines = describeReport({
      ...base,
      total: 1,
      enabled: 1,
      due: [
        {
          id: 'j',
          name: 'Nightly',
          profileId: 'p',
          dueAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }).join('\n');

    expect(lines).toContain('Nightly');
    expect(lines).toContain('Nothing was run');
  });
});

/**
 * The runner must not confuse "nothing due" with "could not read the file".
 *
 * Both produce an empty job list, and for a timer that fires every minute both
 * look identical from the outside: exit 0, nothing ran. The difference only
 * matters to the person whose jobs silently stopped, so it is asserted here
 * rather than left to the log to reveal.
 */
describe('an unreadable jobs file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-runner-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('is reported as a problem, not as an empty schedule', async () => {
    await writeFile(join(dir, 'jobs.json'), 'not json at all', 'utf8');

    const report = await inspectDueJobs({paths: resolveAppPaths(dir)});

    expect(report.problem).toBeDefined();
    expect(report.due).toEqual([]);
  });

  it('says FAILED rather than "nothing due" in the log', async () => {
    await writeFile(join(dir, 'jobs.json'), '{', 'utf8');
    const report = await inspectDueJobs({paths: resolveAppPaths(dir)});

    const lines = describeReport(report).join('\n');
    expect(lines).toContain('FAILED');
    expect(lines).not.toContain('nothing due');
  });

  it('exits non-zero, which is the only signal the OS timer gets', async () => {
    await writeFile(join(dir, 'jobs.json'), 'not json at all', 'utf8');

    const written: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const previous = process.env[USER_DATA_ENV];
    process.env[USER_DATA_ENV] = dir;

    try {
      expect(await main(['--run-due'])).toBe(1);
    } finally {
      stdout.mockRestore();
      if (previous === undefined) {
        delete process.env[USER_DATA_ENV];
      } else {
        process.env[USER_DATA_ENV] = previous;
      }
    }
  });

  it('exits zero on a fresh install, because nothing to do is not a failure', async () => {
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const previous = process.env[USER_DATA_ENV];
    process.env[USER_DATA_ENV] = dir;

    try {
      expect(await main(['--run-due'])).toBe(0);
    } finally {
      stdout.mockRestore();
      if (previous === undefined) {
        delete process.env[USER_DATA_ENV];
      } else {
        process.env[USER_DATA_ENV] = previous;
      }
    }
  });
});
