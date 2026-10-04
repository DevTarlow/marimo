/**
 * The tray menu and the notification rule.
 *
 * Both are decisions that fail quietly. A tray with no Quit is an app nobody can
 * close; a notification for every finished job is one the user switches off,
 * which costs them the approval request that has been waiting since morning.
 */
import {describe, expect, it} from 'vitest';

import type {Job} from '@marimo/protocol';

import {nextRunOf, noticeFor, trayMenu} from '../src/main/tray.js';
import type {TrayState} from '../src/main/tray.js';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Digest',
    description: '',
    schedules: ['0 9 * * *'],
    enabled: true,
    profileId: 'p1',
    sessionId: null,
    createdAt: '2026-05-01T08:00:00.000Z',
    ...overrides,
  } as Job;
}

function state(overrides: Partial<TrayState> = {}): TrayState {
  return {
    windowVisible: true,
    startAtLogin: false,
    jobs: [],
    busy: false,
    connectors: {},
    companionVisible: false,
    ...overrides,
  };
}

describe('the tray menu', () => {
  /*
   * The failure this exists to prevent. A tray-resident window can be closed
   * without the app closing, which makes the menu the only way out — and an app
   * with no way out is one the user has to kill from a task manager, twice,
   * before they stop trusting it.
   */
  it('always offers a way to quit, at the end', () => {
    const items = trayMenu(state());
    const ids = items.map((item) => item.id).filter(Boolean);
    expect(ids).toContain('quit');
    expect(ids[ids.length - 1]).toBe('quit');
  });

  it('offers to hide when the window is up, and show when it is not', () => {
    expect(
      trayMenu(state({windowVisible: true})).find((i) => i.id === 'toggle-window')
        ?.label,
    ).toBe('Hide window');
    expect(
      trayMenu(state({windowVisible: false})).find((i) => i.id === 'toggle-window')
        ?.label,
    ).toBe('Show window');
  });

  /*
   * The summary lines come first and cannot be clicked, because the first
   * question somebody asks a background app is "what is it doing". A menu that
   * answers with a list of commands instead is one they have to open the window
   * to understand, which defeats the point of the tray.
   */
  it('answers what it is doing before offering commands', () => {
    const items = trayMenu(state({busy: true}));
    expect(items[0]?.label).toBe('Working…');
    expect(items[0]?.enabled).toBe(false);
  });

  it('says idle when it is', () => {
    expect(trayMenu(state())[0]?.label).toBe('Idle');
  });

  it('counts the jobs that will actually run', () => {
    const items = trayMenu(
      state({jobs: [job(), job({id: 'j2', enabled: false})]}),
    );
    // One, not two: a paused job is not going to happen, and a tray that counts
    // it is one that lies about what is scheduled.
    expect(items[1]?.label).toContain('1 job');
  });

  it('pluralises honestly', () => {
    const one = trayMenu(state({jobs: [job({dueAt: '2026-05-01T09:30:00.000Z'})]}))[1]
      ?.label;
    // "1 job", not "1 jobs" — and the time is appended only when there is one.
    expect(one).toContain('1 job');
    expect(one).not.toContain('1 jobs');

    const two = trayMenu(state({jobs: [job(), job({id: 'j2'})]}))[1]?.label;
    expect(two).toContain('2 jobs');
  });

  it('says when nothing is scheduled', () => {
    expect(trayMenu(state())[1]?.label).toBe('No scheduled jobs');
  });

  it('counts only the connectors that are up', () => {
    const items = trayMenu(
      state({
        connectors: {
          a: {state: 'online', detail: '', toolCount: 3},
          b: {state: 'error', detail: '', toolCount: 0},
          c: {state: 'connecting', detail: '', toolCount: 0},
        },
      }),
    );
    expect(items[2]?.label).toBe('1 connector online');
  });

  it('says so when none are', () => {
    expect(trayMenu(state())[2]?.label).toBe('No connectors online');
  });

  it('offers the companion as a switch, not a command', () => {
    // A command would have to say "show" or "hide" and would be wrong half the
    // time; a tick says what is true.
    expect(
      trayMenu(state({companionVisible: true})).find(
        (i) => i.id === 'toggle-companion',
      )?.checked,
    ).toBe(true);
  });

  it('shows the login setting as a tick', () => {
    expect(
      trayMenu(state({startAtLogin: true})).find((i) => i.id === 'start-at-login')
        ?.checked,
    ).toBe(true);
  });
});

describe('when the next job is', () => {
  const now = new Date('2026-05-01T09:00:00.000Z');

  it('has nothing to say with no jobs', () => {
    expect(nextRunOf([], now)).toBeUndefined();
  });

  it('picks the soonest, not the first', () => {
    const soon = job({id: 'a', dueAt: '2026-05-01T09:30:00.000Z'});
    const later = job({id: 'b', dueAt: '2026-05-01T14:00:00.000Z'});
    expect(nextRunOf([later, soon], now)).toBe('in 30 min');
  });

  /*
   * Coarse on purpose. The question is "is anything about to happen", and to
   * that "in 3 minutes" and "in 4 minutes" are the same answer — while a clock
   * time is worse, because the user does not know what time it is to the minute
   * either.
   */
  it('rounds to something a person reads at a glance', () => {
    expect(nextRunOf([job({dueAt: '2026-05-01T09:45:00.000Z'})], now)).toBe('in 45 min');
    expect(nextRunOf([job({dueAt: '2026-05-01T12:00:00.000Z'})], now)).toBe('in 3 h');
    expect(nextRunOf([job({dueAt: '2026-05-03T09:00:00.000Z'})], now)).toBe('in 2 days');
  });

  it('says now for something already due', () => {
    expect(nextRunOf([job({dueAt: '2026-05-01T08:00:00.000Z'})], now)).toBe('now');
  });

  it('ignores a job with no time rather than refusing to answer', () => {
    // A paused job has no marker at all. One of those in the list must not stop
    // the tray saying when the others will run.
    expect(nextRunOf([job()], now)).toBeUndefined();
    expect(
      nextRunOf([job(), job({id: 'b', dueAt: '2026-05-01T12:00:00.000Z'})], now),
    ).toBe('in 3 h');
  });
});

describe('what is worth interrupting somebody for', () => {
  /*
   * The one this exists for. An unattended run that stops on a gate is
   * *waiting* — it will not proceed and it will not give up — so if nobody is
   * told, the job stays stopped until the user happens to open the window.
   */
  it('tells the user when something is waiting for approval', () => {
    const notice = noticeFor({type: 'approval.request', sessionId: 's1'});
    expect(notice?.title).toMatch(/approval/u);
    expect(notice?.sessionId).toBe('s1');
  });

  it('tells the user when a run failed', () => {
    const notice = noticeFor({
      type: 'turn.failed',
      sessionId: 's1',
      message: 'the provider refused',
    });
    expect(notice?.body).toBe('the provider refused');
  });

  /*
   * The rule is *needs you*, not *happened*. A notification for every completed
   * turn is one the user switches off within a day — and switching them off
   * costs them the approval request that has been waiting since morning.
   */
  it('says nothing about a turn that simply finished', () => {
    expect(noticeFor({type: 'turn.completed', sessionId: 's1'})).toBeUndefined();
    expect(noticeFor({type: 'text.delta', sessionId: 's1'})).toBeUndefined();
    expect(noticeFor({type: 'subagent.finished', sessionId: 's1'})).toBeUndefined();
  });

  /*
   * "You have not set this up yet" is not news. The window already says so, and
   * a background run repeating it every hour is a notification the user learns
   * to dismiss on sight — which is how the approval one gets dismissed too.
   */
  it('says nothing about the not-configured refusal', () => {
    expect(
      noticeFor({type: 'turn.failed', code: 'not-configured', message: 'no key'}),
    ).toBeUndefined();
  });

  it('still says something about a failure with no message', () => {
    const notice = noticeFor({type: 'turn.failed'});
    expect(notice?.body.length).toBeGreaterThan(0);
  });

  it('keeps a long failure message to something that fits on a screen', () => {
    const notice = noticeFor({type: 'turn.failed', message: 'x'.repeat(500)});
    expect((notice?.body ?? '').length).toBeLessThanOrEqual(200);
  });
});
