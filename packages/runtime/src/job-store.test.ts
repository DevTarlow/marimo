/**
 * The jobs file.
 *
 * The store is what stands between the scheduler and a document a user might
 * hand-edit, so the interesting cases are the unreadable ones — and `nextRunAt`,
 * which is derived and has to be recomputed rather than trusted.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {emptyJobs} from '@marimo/protocol';

import {
  DEFAULT_SCHEDULE,
  JobStore,
  PLACEHOLDER_JOB_NAME,
} from './jobs.js';

describe('JobStore', () => {
  let dir: string;
  let file: string;
  let store: JobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-jobs-store-'));
    file = join(dir, 'jobs.json');
    store = new JobStore({file});
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('starts empty, with the rail closed', async () => {
    expect(await store.load()).toEqual(emptyJobs());
    expect(emptyJobs().open).toBe(false);
  });

  it('creates an enabled job with a real next run', async () => {
    const {jobs, job} = await store.create({
      name: 'Morning digest',
      description: 'Summarise new issues.',
      sessionId: 'session-1',
      profileId: 'profile-1',
      schedules: ['0 9 * * *'],
    });

    expect(jobs.jobs).toHaveLength(1);
    expect(job).toMatchObject({
      name: 'Morning digest',
      description: 'Summarise new issues.',
      schedules: ['0 9 * * *'],
      enabled: true,
      profileId: 'profile-1',
      sessionId: 'session-1',
    });
    expect(job.nextRunAt).toBeDefined();
    expect(Date.parse(job.nextRunAt ?? '')).toBeGreaterThan(Date.now());
    // Read back from disk, so the file is what the panel will see.
    expect(await store.load()).toEqual(jobs);
  });

  it('gives a job that was never given a schedule the default one', async () => {
    const {job} = await store.create({
      name: 'Loose end',
      description: '',
      sessionId: 'session-1',
      profileId: 'profile-1',
    });
    expect(job.schedules).toEqual([DEFAULT_SCHEDULE]);
  });

  /*
   * An expression can be valid and still never come — 30 February is the one the
   * cron tests use. A job edited into one has nothing left to watch, and keeping
   * the marker it had would leave an occurrence that is due and can never be
   * moved on: the scheduler would try to retire it on every look, rewriting the
   * document each time.
   */
  it('leaves a job whose schedule has no next occurrence with no marker', async () => {
    const {job} = await store.create({
      name: 'Impossible',
      description: '',
      sessionId: 'session-1',
      profileId: 'profile-1',
      schedules: ['0 9 * * *'],
    });
    await store.update(job.id, {schedules: ['0 0 30 2 *']});
    const before = (await store.load()).jobs[0];
    expect(before?.dueAt).toBeDefined();

    await store.advanceDue(job.id, before?.dueAt ?? '');

    const after = (await store.load()).jobs[0];
    expect(after?.dueAt).toBeUndefined();
    expect(after?.nextRunAt).toBeUndefined();
  });

  /*
   * The draft the panel leaves behind while the user describes the job. It has
   * to exist — that is the conversation a job links back to — and it must not be
   * able to run the default schedule before anybody has said what it does.
   */
  describe('an unnamed job', () => {
    it('starts paused, so it cannot run before it is described', async () => {
      const {job} = await store.create({
        name: PLACEHOLDER_JOB_NAME,
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      expect(job.enabled).toBe(false);
      expect(job.nextRunAt).toBeUndefined();
    });

    it('is reused rather than stacked up', async () => {
      await store.create({
        name: PLACEHOLDER_JOB_NAME,
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      const second = await store.create({
        name: PLACEHOLDER_JOB_NAME,
        description: '',
        sessionId: 'session-2',
        profileId: 'profile-1',
      });
      const loaded = await store.load();
      expect(loaded.jobs).toHaveLength(1);
      expect(second.job.id).toBe(loaded.jobs[0]?.id);
    });

    it('starts running once it is named, taking the default schedule', async () => {
      const {job} = await store.create({
        name: PLACEHOLDER_JOB_NAME,
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      const named = await store.update(job.id, {
        name: 'Morning digest',
        description: 'Summarise new issues.',
      });
      expect(named).toMatchObject({
        name: 'Morning digest',
        enabled: true,
        schedules: [DEFAULT_SCHEDULE],
      });
      expect(Date.parse(named?.nextRunAt ?? '')).toBeGreaterThan(Date.now());
    });

    it('keeps the schedule it was named with', async () => {
      const {job} = await store.create({
        name: PLACEHOLDER_JOB_NAME,
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      const named = await store.update(job.id, {
        name: 'Nightly',
        schedules: ['30 2 * * *'],
      });
      expect(named).toMatchObject({enabled: true, schedules: ['30 2 * * *']});
    });

    it('stays paused when it is named but deliberately disabled', async () => {
      const {job} = await store.create({
        name: PLACEHOLDER_JOB_NAME,
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      const named = await store.update(job.id, {
        name: 'Later',
        enabled: false,
      });
      expect(named).toMatchObject({name: 'Later', enabled: false});
    });
  });

  it('lists newest first', async () => {
    await store.create({
      name: 'first',
      description: '',
      sessionId: 's1',
      profileId: 'p1',
    });
    const {jobs} = await store.create({
      name: 'second',
      description: '',
      sessionId: 's2',
      profileId: 'p1',
    });
    expect(jobs.jobs.map((job) => job.name)).toEqual(['second', 'first']);
  });

  describe('update', () => {
    it('changes only what the patch names', async () => {
      const {job} = await store.create({
        name: 'Nightly',
        description: 'Roll the logs.',
        sessionId: 'session-1',
        profileId: 'profile-1',
        schedules: ['30 2 * * *'],
      });

      const updated = await store.update(job.id, {schedules: ['0 6 * * *']});
      expect(updated).toMatchObject({
        name: 'Nightly',
        description: 'Roll the logs.',
        schedules: ['0 6 * * *'],
        enabled: true,
      });
    });

    it('drops the next run when a job is paused and works it out again on resume', async () => {
      const {job} = await store.create({
        name: 'Nightly',
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });

      const paused = await store.update(job.id, {enabled: false});
      expect(paused?.enabled).toBe(false);
      expect(paused?.nextRunAt).toBeUndefined();

      const resumed = await store.update(job.id, {enabled: true});
      expect(resumed?.enabled).toBe(true);
      expect(Date.parse(resumed?.nextRunAt ?? '')).toBeGreaterThan(Date.now());
    });

    it('clears the last complaint when the schedule changes', async () => {
      const {job} = await store.create({
        name: 'Nightly',
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      await store.recordRun(job.id, {
        at: '2026-05-01T00:00:00.000Z',
        status: 'error',
        error: 'the model was unavailable',
      });
      const updated = await store.update(job.id, {schedules: ['0 5 * * *']});
      expect(updated?.lastError).toBeUndefined();
      // The run itself is history and stays: only the complaint is stale.
      expect(updated?.lastRunAt).toBe('2026-05-01T00:00:00.000Z');
    });

    it('answers null for a job that is not there', async () => {
      expect(await store.update('ghost', {name: 'x'})).toBeNull();
    });

    it('remembers which card is expanded', async () => {
      const {job} = await store.create({
        name: 'Nightly',
        description: '',
        sessionId: 'session-1',
        profileId: 'profile-1',
      });
      await store.setView({openJobId: job.id});
      expect((await store.load()).openJobId).toBe(job.id);

      // A job that is gone means the list: a stale id must not leave the panel
      // pointing at nothing.
      await store.remove(job.id);
      await store.setView({openJobId: job.id});
      expect((await store.load()).openJobId).toBeNull();
    });
  });

  it('removes a job and reports whether there was one', async () => {
    const {job} = await store.create({
      name: 'Nightly',
      description: '',
      sessionId: 'session-1',
      profileId: 'profile-1',
    });
    expect(await store.remove(job.id)).toBe(true);
    expect((await store.load()).jobs).toEqual([]);
    expect(await store.remove(job.id)).toBe(false);
  });

  it('records how a run went, without disturbing the rest of the job', async () => {
    const {job} = await store.create({
      name: 'Nightly',
      description: 'Roll the logs.',
      sessionId: 'session-1',
      profileId: 'profile-1',
    });
    const recorded = await store.recordRun(job.id, {
      at: '2026-05-01T09:00:00.000Z',
      status: 'ok',
    });
    expect(recorded).toMatchObject({
      lastRunAt: '2026-05-01T09:00:00.000Z',
      lastStatus: 'ok',
      name: 'Nightly',
    });
    expect(
      await store.recordRun('ghost', {
        at: '2026-05-01T09:00:00.000Z',
        status: 'ok',
      }),
    ).toBeNull();
  });

  it('repoints a job at a new conversation', async () => {
    const {job} = await store.create({
      name: 'Nightly',
      description: '',
      sessionId: 'session-1',
      profileId: 'profile-1',
    });
    await store.setSession(job.id, 'session-2');
    expect((await store.load()).jobs[0]?.sessionId).toBe('session-2');
    expect(await store.setSession('ghost', 'session-3')).toBeNull();
  });

  it('remembers whether the rail was open', async () => {
    await store.setView({open: true});
    expect((await store.load()).open).toBe(true);
    await store.setView({open: false});
    expect((await store.load()).open).toBe(false);
  });

  /*
   * The view and an edit arrive together because they are one gesture; the write
   * has to apply both in one pass, or the second would start from a document
   * that predates the first.
   */
  it('applies a patch and the view in a single write', async () => {
    const {job} = await store.create({
      name: 'Nightly',
      description: '',
      sessionId: 'session-1',
      profileId: 'profile-1',
    });
    const result = await store.updateWithView(
      job.id,
      {enabled: false},
      {open: true, openJobId: job.id},
    );
    expect(result.found).toBe(true);
    expect(result.jobs.open).toBe(true);
    expect(result.jobs.openJobId).toBe(job.id);
    expect(result.jobs.jobs[0]?.enabled).toBe(false);

    // A job that is not there is not an error: the view still applies.
    const missing = await store.updateWithView(
      'ghost',
      {enabled: true},
      {openJobId: 'ghost'},
    );
    expect(missing.found).toBe(false);
    expect(missing.jobs.openJobId).toBeNull();
  });

  it('writes a versioned document, so the format can change later', async () => {
    await store.create({
      name: 'Nightly',
      description: '',
      sessionId: 'session-1',
      profileId: 'profile-1',
    });
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.jobs.jobs).toHaveLength(1);
    expect(raw.jobs.open).toBe(false);
  });

  /*
   * The derived field is the one thing here that could go stale on disk: a
   * document written last week would otherwise claim a next run in the past.
   */
  it('recomputes a stale next run on the way out', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        jobs: {
          open: true,
          openJobId: null,
          jobs: [
            {
              id: 'job-1',
              name: 'Nightly',
              description: '',
              schedules: ['0 9 * * *'],
              enabled: true,
              profileId: 'profile-1',
              sessionId: 'session-1',
              createdAt: '2026-05-01T09:00:00.000Z',
              nextRunAt: '2020-01-01T09:00:00.000Z',
            },
          ],
        },
      }),
      'utf8',
    );

    const loaded = await store.load();
    expect(Date.parse(loaded.jobs[0]?.nextRunAt ?? '')).toBeGreaterThan(
      Date.now(),
    );
  });

  it('reads an unreadable file as empty instead of throwing', async () => {
    await writeFile(file, 'not json at all', 'utf8');
    expect(await store.load()).toEqual(emptyJobs());
  });

  it('refuses a stored document from a future version', async () => {
    await writeFile(
      file,
      JSON.stringify({version: 2, jobs: emptyJobs()}),
      'utf8',
    );
    expect(await store.load()).toEqual(emptyJobs());
  });

  it('refuses a stored job with a schedule that cannot be evaluated', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        jobs: {
          open: false,
          openJobId: null,
          jobs: [
            {
              id: 'job-1',
              name: 'Broken',
              description: '',
              schedules: ['not a cron'],
              enabled: true,
              profileId: 'profile-1',
              sessionId: null,
              createdAt: '2026-05-01T09:00:00.000Z',
            },
          ],
        },
      }),
      'utf8',
    );
    expect(await store.load()).toEqual(emptyJobs());
  });

  it('serialises overlapping writes instead of interleaving them', async () => {
    await Promise.all([
      store.create({
        name: 'one',
        description: '',
        sessionId: 's1',
        profileId: 'p1',
      }),
      store.create({
        name: 'two',
        description: '',
        sessionId: 's2',
        profileId: 'p1',
      }),
      store.create({
        name: 'three',
        description: '',
        sessionId: 's3',
        profileId: 'p1',
      }),
    ]);
    const loaded = await store.load();
    expect(loaded.jobs).toHaveLength(3);
    expect(loaded.jobs.map((job) => job.name).sort()).toEqual([
      'one',
      'three',
      'two',
    ]);
  });
});

/**
 * Telling "nothing scheduled" apart from "could not read".
 *
 * The window can afford to treat those as the same thing — it has to open either
 * way, and an empty list is recoverable by hand. The headless runner cannot: for
 * it both outcomes are a process that exits 0 having done nothing, which is the
 * one failure nobody notices. `loadChecked` is the door that keeps them apart,
 * and `mutate` is where reading leniently would otherwise destroy the file.
 */
describe('JobStore readability', () => {
  let dir: string;
  let file: string;
  let store: JobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-jobs-readable-'));
    file = join(dir, 'jobs.json');
    store = new JobStore({file});
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('reports no problem for a file that is simply not there', async () => {
    const {jobs, problem} = await store.loadChecked();
    expect(jobs).toEqual(emptyJobs());
    expect(problem).toBeUndefined();
  });

  it('reports a problem for a file that is not JSON', async () => {
    await writeFile(file, 'not json at all', 'utf8');
    const {jobs, problem} = await store.loadChecked();
    expect(jobs.jobs).toEqual([]);
    expect(problem).toMatch(/not valid JSON/u);
  });

  it('reports a problem for JSON that is not a jobs document', async () => {
    await writeFile(file, JSON.stringify({version: 1, jobs: 'nope'}), 'utf8');
    const {problem} = await store.loadChecked();
    expect(problem).toMatch(/not a jobs document/u);
  });

  it('reports a file from a newer build rather than calling it empty', async () => {
    await writeFile(
      file,
      JSON.stringify({version: 9, jobs: {jobs: [], open: false, openJobId: null}}),
      'utf8',
    );
    const {problem} = await store.loadChecked();
    expect(problem).toMatch(/newer version/u);
    // And the advice has to be actionable, because the user's file is still here.
    expect(problem).toMatch(/update the app/iu);
  });

  it('still loads leniently through `load`, so the window can open', async () => {
    await writeFile(file, 'not json at all', 'utf8');
    expect(await store.load()).toEqual(emptyJobs());
  });

  /*
   * The data-loss case. A lenient read followed by a write is how a file from a
   * newer build — or a corrupt one — becomes an empty document: the read yields
   * nothing, the edit applies to nothing, and the result is stored over the
   * original. Refusing is the only recoverable outcome.
   */
  it('refuses to write over a document it cannot read, and leaves it alone', async () => {
    const newer = JSON.stringify({
      version: 9,
      jobs: {jobs: [{id: 'kept'}], open: false, openJobId: null},
    });
    await writeFile(file, newer, 'utf8');

    await expect(
      store.create({
        name: 'New job',
        description: '',
        sessionId: 's1',
        profileId: 'p1',
      }),
    ).rejects.toThrow(/newer version/u);

    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  /*
   * The third answer, between "use it" and "refuse to write".
   *
   * A corrupt file is not worth refusing over — nothing can read it, so the user
   * could never save again without hand-deleting a file they cannot identify —
   * and it is not worth deleting either. It is moved aside, so the app keeps
   * working and whatever was in there is still there to be looked at.
   */
  it('keeps a corrupt file beside the new one rather than overwriting it', async () => {
    await writeFile(file, 'half a doc', 'utf8');

    const {job} = await store.create({
      name: 'New job',
      description: '',
      sessionId: 's1',
      profileId: 'p1',
    });

    // The write went through, so a bad file does not brick the app.
    expect(job.name).toBe('New job');
    // And the unreadable original is still on disk to be looked at.
    expect(await readFile(`${file}.unreadable`, 'utf8')).toBe('half a doc');
  });
});
