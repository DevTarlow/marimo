/**
 * The tray: what keeps the app running when the window is closed.
 *
 * Every decision here is data — a menu template, and a rule for when a
 * notification is worth sending — because both are things that go wrong quietly.
 * A tray with no Quit in it is an application the user cannot close; a
 * notification on every job is one the user turns off, which costs them the one
 * that mattered.
 *
 * The shapes are plain, so `tray.test.ts` can assert them without an Electron
 * process. Building the actual `Tray` is the only part that needs one.
 */
import type {Job, McpStatus} from '@marimo/protocol';

import {PRODUCT_NAME} from '../shared/product.js';

/** What the tray menu needs to know about the world. */
export interface TrayState {
  /** Whether the window is on screen right now. */
  windowVisible: boolean;
  /** Whether the app will come back after a login. */
  startAtLogin: boolean;
  /** Scheduled jobs, for the summary line. */
  jobs: readonly Job[];
  /** Whether any agent is mid-turn. */
  busy: boolean;
  /** Connectors, for the summary line. */
  connectors: Readonly<Record<string, McpStatus>>;
  /** Whether the floating companion is on screen. */
  companionVisible: boolean;
}

/** One row of the menu. */
export interface TrayItem {
  /** Absent for a separator or a non-clickable line. */
  id?: string;
  label?: string;
  type?: 'separator';
  checked?: boolean;
  enabled?: boolean;
}

/**
 * The tray menu.
 *
 * The summary lines are first and not clickable, because the first question
 * somebody asks a background app is "what is it doing" — and a tray menu that
 * answers with a list of commands instead is one they have to open the window to
 * understand.
 *
 * Quit is always present and always last. A tray-resident app is one whose
 * window can be closed without the app closing, and the menu is therefore the
 * only way out; leaving it off would make the app impossible to quit, which is
 * the failure every badly-behaved tray application has.
 */
export function trayMenu(state: TrayState): TrayItem[] {
  const enabled = state.jobs.filter((job) => job.enabled);
  const next = nextRunOf(enabled);
  const online = Object.values(state.connectors).filter(
    (status) => status.state === 'online',
  ).length;

  return [
    {label: state.busy ? 'Working…' : 'Idle', enabled: false},
    {
      label:
        enabled.length === 0
          ? 'No scheduled jobs'
          : `${String(enabled.length)} job${enabled.length === 1 ? '' : 's'}` +
            (next === undefined ? '' : `, next ${next}`),
      enabled: false,
    },
    {
      label:
        online === 0
          ? 'No connectors online'
          : `${String(online)} connector${online === 1 ? '' : 's'} online`,
      enabled: false,
    },
    {type: 'separator'},
    {id: 'toggle-window', label: state.windowVisible ? 'Hide window' : 'Show window'},
    {
      id: 'toggle-companion',
      label: 'Desktop companion',
      checked: state.companionVisible,
    },
    {id: 'settings', label: 'Settings…'},
    {type: 'separator'},
    {
      id: 'start-at-login',
      label: 'Start at login',
      type: undefined,
      checked: state.startAtLogin,
    },
    {type: 'separator'},
    {id: 'quit', label: `Quit ${PRODUCT_NAME}`},
  ];
}

/**
 * When the next job is due, in the words a person reads at a glance.
 *
 * Deliberately coarse. The question a tray menu answers is "is anything about to
 * happen", and "in 3 minutes" and "in 4 minutes" are the same answer to it —
 * while a clock time is not, because the user does not know what time it is to
 * the minute either.
 */
export function nextRunOf(
  jobs: readonly Job[],
  now: Date = new Date(),
): string | undefined {
  const times = jobs
    /*
     * `undefined` for a job with nothing scheduled — a paused one, or one whose
     * cron expression names no future date — which is not a time and must not be
     * sorted as one.
     */
    .map((job) => (job.dueAt === undefined ? NaN : Date.parse(job.dueAt)))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => left - right);
  const soonest = times[0];
  if (soonest === undefined) {
    return undefined;
  }
  return describeWhen(soonest, now.getTime());
}

function describeWhen(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) {
    return 'now';
  }
  if (minutes < 60) {
    return `in ${String(minutes)} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `in ${String(hours)} h`;
  }
  const days = Math.round(hours / 24);
  return `in ${String(days)} day${days === 1 ? '' : 's'}`;
}

/** What a notification is about. */
export interface Notice {
  title: string;
  body: string;
  /** Where clicking it should take the user, when it should take them anywhere. */
  sessionId?: string;
}

/**
 * Whether an event is worth interrupting somebody for.
 *
 * The rule is *needs you*, not *happened*. A notification for every completed
 * job is a notification the user turns off within a day — and turning them off
 * costs them the one that mattered, which is the approval request that has been
 * waiting since this morning.
 *
 * Returns `undefined` for everything else, which is most things.
 */
export function noticeFor(event: {
  type: string;
  sessionId?: string;
  message?: string;
  error?: string;
  code?: string;
}): Notice | undefined {
  switch (event.type) {
    /*
     * The one that exists for this. An unattended run that stops on a gate is
     * *waiting* — it will not proceed and it will not give up — so if nobody is
     * told, the job stays stopped until the user happens to open the window.
     */
    case 'approval.request':
      return {
        title: 'Marimo Bot needs your approval',
        body: `A tool is waiting to run. Open ${PRODUCT_NAME} to allow or refuse it.`,
        ...(event.sessionId === undefined ? {} : {sessionId: event.sessionId}),
      };

    /*
     * A failure is reported only when it is not the "you have not set this up
     * yet" refusal, which is not news: the window already says so, and a
     * notification repeating it every hour is one the user learns to dismiss.
     */
    case 'turn.failed':
      if (event.code === 'not-configured') {
        return undefined;
      }
      return {
        title: `A ${PRODUCT_NAME} run failed`,
        body: (event.message ?? 'Something went wrong.').slice(0, 200),
        ...(event.sessionId === undefined ? {} : {sessionId: event.sessionId}),
      };

    default:
      return undefined;
  }
}
