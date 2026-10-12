/**
 * The conversation, in the window.
 *
 * Three sources feed the transcript, and keeping them apart is the whole design:
 *
 * - **The stored transcript** is what was actually written down. It is read when
 *   a conversation is opened and again when a turn ends.
 * - **The live turn** is what is arriving right now, assembled from the event
 *   stream so the answer appears as it is written rather than after it is
 *   finished.
 * - **The outbox** is the user's own words between pressing send and the next
 *   transcript read. There is nothing else to draw them from: a send is an IPC
 *   round trip and then a turn that begins in the main process, and the
 *   conversation on disk is not re-read until that turn ends — so without this
 *   a sent message sat in no source at all, and the window looked as if it had
 *   swallowed it.
 *
 * At the end of every turn the live copy is thrown away and the stored one is
 * re-read. That is not belt-and-braces: a stream can be interrupted, an abort
 * keeps only what the provider finished, and a turn that failed halfway has text
 * on screen that was never persisted. Trusting the streamed copy would leave the
 * window showing an answer that does not exist in the conversation — and the
 * user's next message would be answered by a model that never saw it.
 *
 * Events are filtered by conversation. A turn running in another conversation
 * still broadcasts, and appending its deltas to the one on screen would
 * interleave two answers into one bubble.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {
  AgentProfile,
  ThemeMode,
  AgentUiEvent,
  PendingGate,
  SessionSummary,
  ToolCallRecord,
  TranscriptMessage,
  Workspace,
} from '@marimo/protocol';

import {folderForSession} from '../workspace-groups.js';
import {describe} from '../describe.js';

/*
 * A tool call in flight and a tool call read back from disk are the same shape,
 * and deliberately: `ToolCallRecord` is what the transcript stores, so a live
 * call that used a different type would need converting at exactly the moment
 * the two are swapped. `ok` being absent is what says "still running".
 */
export type LiveToolCall = ToolCallRecord;

/**
 * A model download in flight, as the two screens that draw it need it.
 *
 * The same shape the main process reports and the protocol carries, restated here
 * because the renderer cannot import a type from the runtime package and the
 * alternative — inferring it from an event union — would break the moment a field
 * moved.
 */
export interface ModelProgress {
  label: string;
  receivedBytes: number;
  totalBytes: number;
  percent?: number;
}

/** The turn in flight, assembled from the stream. */
export interface LiveTurn {
  messageId: string;
  text: string;
  reasoning: string;
  toolCalls: LiveToolCall[];
  running: boolean;
}

export interface AgentController {
  ready: boolean;
  /** Why the window has nothing to show, when it has nothing to show. */
  error: string | null;
  profile: AgentProfile | undefined;
  sessions: SessionSummary[];
  sessionId: string | null;
  messages: TranscriptMessage[];
  /** Gates the open conversation is waiting on, stored or live. */
  pending: PendingGate[];
  live: LiveTurn | null;
  /**
   * The user's own words, sent but not yet read back from the conversation.
   *
   * Drawn after the stored transcript and before the live turn, which is where
   * the message will be once the turn ends and the store is read again.
   */
  outbox: string | null;
  /**
   * A turn is in flight — including the moment between sending and the turn's
   * first event, when there is nothing to show yet but a message on its way.
   */
  busy: boolean;
  /**
   * Sends a message, and answers whether the turn was accepted.
   *
   * The answer is what lets the composer keep what was typed: a refusal — a
   * turn already running, an unknown conversation — is not a failure the user
   * should have to retype a prompt to recover from.
   */
  send: (text: string, origin?: 'window' | 'pet') => Promise<boolean>;
  decide: (callId: string, confirmed: boolean) => Promise<void>;
  stop: () => Promise<void>;
  /**
   * Records that an answer was wrong, and what was right instead.
   *
   * Answers whether it was stored, because the button that calls it says "Noted"
   * and a button that says that about something which was not recorded is worse
   * than one that did nothing.
   */
  noteCorrection: (
    messageId: string,
    excerpt: string,
    correction?: string,
  ) => Promise<boolean>;
  open: (sessionId: string) => Promise<void>;
  /**
   * Re-reads the open conversation.
   *
   * For the things that change it without a turn: a compaction appends an event
   * to the conversation on screen, and `session.changed` only re-lists the
   * sidebar. Trusting that to redraw the transcript would leave a window showing
   * the messages a summary has just replaced.
   */
  refresh: () => Promise<void>;
  /** Re-reads the agent and the conversation, after settings may have changed. */
  reload: () => Promise<void>;
  /**
   * Set when the tray has asked for Settings to open.
   *
   * A counter rather than a boolean: two presses in a row have to be two
   * different values, or the second one opens nothing.
   */
  openSettings: number;
  /** A download in flight, or null. Drawn by the welcome screen and the card. */
  modelProgress: ModelProgress | null;
  /** Suggestions that have arrived since the panel was last opened. */
  memoryWaiting: number;
  /** What the last background look at the conversation read, and found. */
  lastReview: {events: number; found: number} | null;
  /** Clears that, when the panel opens and the user is looking at them. */
  clearMemoryWaiting: () => void;
  /** Changes whenever the model files do, so a reader knows to re-read. */
  modelRevision: number;
  /** The stored theme preference, kept in step with the settings file. */
  themeMode: ThemeMode;
  newSession: (workspaceId?: string) => Promise<void>;
  dismissError: () => void;
  /** The folders every agent works in, and which one is current. */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /**
   * The folder the open conversation works in, for the header.
   *
   * Not the same thing as the active workspace: a conversation remembers the
   * folder it was started in, and the two differ the moment the user selects
   * another one.
   */
  activeFolder: string | null;
  /** Loads a folder, or answers `false` when the picker was closed. */
  loadWorkspace: () => Promise<boolean>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  openWorkspace: (workspaceId: string) => Promise<void>;
  moveSession: (
    sessionId: string,
    workspaceId: string | null,
  ) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  /** Deletes a conversation, and lands somewhere sensible if it was open. */
  removeSession: (sessionId: string) => Promise<void>;
}

export function useAgent(): AgentController {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentProfile | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [storedPending, setStoredPending] = useState<PendingGate[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [outbox, setOutbox] = useState<string | null>(null);
  const [openSettings, setOpenSettings] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  /*
   * A model download, which is the one thing in this app that happens over
   * minutes and has to be watched. Kept in the hook rather than in the card that
   * draws it, because two things draw it: the welcome screen on a first run and
   * the Model card in Settings, and neither should own the stream.
   */
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null);
  /**
   * How many suggestions have arrived since the user last looked at the panel.
   *
   * A count rather than the proposals themselves: this exists to put a dot
   * somewhere, and the panel already reads the real list from the store when it
   * opens. Held here because the event arrives while Settings is closed, which is
   * the whole reason the count is worth having — a suggestion nobody is told
   * about is one that only exists if they happen to reopen a dialog.
   */
  const [memoryWaiting, setMemoryWaiting] = useState(0);
  /**
   * What the last background look did.
   *
   * Kept apart from the count above and deliberately not cleared when the panel
   * opens: the count answers "is there something new", and this answers "is the
   * thing working at all" — a question a user asks precisely when a look has run
   * and proposed nothing, which is the answer most of the time.
   */
  const [lastReview, setLastReview] = useState<{events: number; found: number} | null>(
    null,
  );
  /** Bumped when the model files change, so whoever is looking re-reads them. */
  const [modelRevision, setModelRevision] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null,
  );

  /*
   * Read by the event listener, which is registered once and would otherwise
   * close over the first render's values forever.
   */
  const openSession = useRef<string | null>(null);
  openSession.current = sessionId;

  /** Read inside the listener, for the same reason. */
  const profileRef = useRef<AgentProfile | undefined>(undefined);
  profileRef.current = profile;

  const loadTranscript = useCallback(
    async (profileId: string, id: string): Promise<void> => {
      const result = await window.marimo.call('sessions.get', {
        profileId,
        sessionId: id,
      });
      // The conversation may have been switched while this was in flight, and
      // committing it then would put one conversation's history under another's
      // title.
      if (openSession.current !== id) {
        return;
      }
      setMessages(result.messages);
      setStoredPending(result.pending);
      /*
       * The stored copy is here, so the echo has nothing left to stand in for.
       * Cleared in the same batch as the messages it replaces, because the two
       * are the same bubble: a frame apart would blink it.
       */
      setOutbox(null);
    },
    [],
  );

  const open = useCallback(
    async (id: string): Promise<void> => {
      setSessionId(id);
      setLive(null);
      setStoredPending([]);
      setMessages([]);
      setOutbox(null);
      if (profile) {
        await loadTranscript(profile.id, id);
      }
    },
    [profile, loadTranscript],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const id = openSession.current;
    if (profile === undefined || id === null) {
      return;
    }
    try {
      /*
       * No clearing of the live turn or the echo first: nothing about a refresh
       * says a turn is over, and blanking the screen to reload it would blink
       * over something the user is reading. `loadTranscript` replaces the
       * messages and drops the echo in one batch, which is the same swap the end
       * of a turn makes.
       */
      await loadTranscript(profile.id, id);
    } catch (failure) {
      setError(describe(failure));
    }
  }, [profile, loadTranscript]);

  /**
   * Adopts a whole folder list.
   *
   * Whole rather than merged: every call that changes one answers with the list
   * and the current folder together, and a window that merged a single entry
   * into its own copy could disagree with the file about the order, or about
   * which folder is current.
   */
  const applyWorkspaceState = useCallback(
    (state: {workspaces: Workspace[]; activeWorkspaceId: string | null}): void => {
      setWorkspaces(state.workspaces);
      setActiveWorkspaceId(state.activeWorkspaceId);
    },
    [],
  );

  const loadWorkspace = useCallback(async (): Promise<boolean> => {
    try {
      const state = await window.marimo.call('workspaces.add', {});
      applyWorkspaceState(state);
      // Cancelling a dialog is an answer, not a failure: nothing is red.
      return state.added;
    } catch (failure) {
      setError(describe(failure));
      return false;
    }
  }, [applyWorkspaceState]);

  const selectWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      try {
        applyWorkspaceState(
          await window.marimo.call('workspaces.select', {workspaceId}),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [applyWorkspaceState],
  );

  const renameWorkspace = useCallback(
    async (workspaceId: string, name: string): Promise<void> => {
      try {
        applyWorkspaceState(
          await window.marimo.call('workspaces.rename', {workspaceId, name}),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [applyWorkspaceState],
  );

  /**
   * Forgets a folder.
   *
   * The conversations filed under it are not touched and do not need reloading:
   * their `workspaceId` now names nothing, which is what the rail draws as
   * "Other chats" — and the header follows, because the folder it was showing is
   * gone.
   */
  const removeWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      try {
        applyWorkspaceState(
          await window.marimo.call('workspaces.remove', {workspaceId}),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [applyWorkspaceState],
  );

  const openWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      try {
        const {opened} = await window.marimo.call('workspaces.open', {
          workspaceId,
        });
        if (!opened) {
          setError('Could not open the folder in your file manager.');
        }
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [],
  );

  const boot = useCallback(async (): Promise<void> => {
    try {
      const listed = await window.marimo.call('profiles.list', {});
      const active =
        listed.profiles.find(
          (entry) => entry.id === listed.activeProfileId,
        ) ?? listed.profiles[0];
      setProfile(active);

      if (active === undefined) {
        setError('This install has no agent. Reopen the app to create one.');
        setReady(true);
        return;
      }

      /*
       * The folders, before the conversations: the rail draws every conversation
       * inside one, and a list that arrived a frame later would put them all
       * under "Other chats" and then move them.
       */
      applyWorkspaceState(await window.marimo.call('workspaces.list', {}));

      const {sessions: existing} = await window.marimo.call('sessions.list', {
        profileId: active.id,
      });
      setSessions(existing);

      /*
       * Land on the newest conversation, or make one. A window that opens on
       * nothing makes the user hunt for the button before they can type, and the
       * first thing anybody does with an empty app is start talking to it.
       */
      if (existing.length > 0 && existing[0] !== undefined) {
        setSessionId(existing[0].id);
        await loadTranscript(active.id, existing[0].id);
      } else {
        const {session} = await window.marimo.call('sessions.create', {
          profileId: active.id,
        });
        setSessions([session]);
        setSessionId(session.id);
      }
      setReady(true);
    } catch (failure) {
      const detail = describe(failure);
      console.error('[marimo] the window could not start:', detail);
      setError(detail);
      setReady(true);
    }
  }, [loadTranscript, applyWorkspaceState]);

  /* The stream. Registered once; everything it needs is read from refs. */
  useEffect(() => {
    const off = window.marimo.onEvent((event: AgentUiEvent) => {
      /*
       * Not every event belongs to a conversation. An MCP server connecting, the
       * agent profile changing, the skills list changing: those carry no session
       * id at all and are drawn by whatever owns them. This listener is only the
       * conversation, so it stops here rather than guessing at a session.
       */
      /*
       * The tray asking for Settings, which is the one message that is not about
       * a conversation. Handled before the filter below, because it has no
       * session to be filtered by.
       */
      if (event.type === 'window.openSettings') {
        setOpenSettings((count) => count + 1);
        return;
      }

      /*
       * The preference, which changes without this window asking — so it arrives
       * as an event rather than being something the window only notices when it
       * reloads.
       */
      if (event.type === 'theme.changed') {
        setThemeMode(event.mode);
        return;
      }

      /*
       * The model downloading. Handled here, before the conversation filter
       * below, because a download belongs to the install rather than to any
       * conversation — and a card that had to subscribe separately would be a
       * second listener for one stream.
       */
      if (event.type === 'model.progress') {
        setModelProgress({
          label: event.label,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes,
          ...(event.percent === undefined ? {} : {percent: event.percent}),
        });
        return;
      }
      if (event.type === 'model.installed') {
        setModelProgress(null);
        setModelRevision((count) => count + 1);
        return;
      }
      /*
       * A background look at the conversation found something worth remembering.
       *
       * Handled before the conversation filter for the same reason the model
       * download is: a proposal belongs to the *agent* rather than to whichever
       * chat is on screen, and the event carries no session id to be filtered by.
       * Counted rather than replaced, because two looks since the user last
       * opened the panel are two more suggestions waiting, not the latest one.
       */
      if (event.type === 'memory.proposed') {
        setMemoryWaiting((count) => count + event.count);
        return;
      }
      if (event.type === 'memory.reviewed') {
        setLastReview({events: event.events, found: event.found});
        return;
      }

      if (event.type === 'model.failed') {
        setModelProgress(null);
        // The banner the window already has for a failure the user must read.
        setError(event.message);
        return;
      }

      if (!('sessionId' in event)) {
        return;
      }
      const forUs = event.sessionId === openSession.current;

      switch (event.type) {
        case 'turn.started':
          if (forUs) {
            setLive({
              messageId: event.messageId,
              text: '',
              reasoning: '',
              toolCalls: [],
              running: true,
            });
          }
          return;

        case 'text.delta':
          if (forUs) {
            setLive((turn) =>
              turn === null
                ? turn
                : {...turn, text: turn.text + event.text},
            );
          }
          return;

        case 'reasoning.delta':
          if (forUs) {
            setLive((turn) =>
              turn === null
                ? turn
                : {...turn, reasoning: turn.reasoning + event.text},
            );
          }
          return;

        case 'tool.started':
          if (forUs) {
            setLive((turn) =>
              turn === null
                ? turn
                : {
                    ...turn,
                    toolCalls: [
                      ...turn.toolCalls,
                      {callId: event.callId, tool: event.tool, args: event.args},
                    ],
                  },
            );
          }
          return;

        case 'tool.finished':
          if (forUs) {
            setLive((turn) =>
              turn === null
                ? turn
                : {
                    ...turn,
                    toolCalls: turn.toolCalls.map((call) =>
                      call.callId === event.callId
                        ? {...call, ok: event.ok, result: event.result}
                        : call,
                    ),
                  },
            );
          }
          return;

        case 'approval.request':
          if (forUs) {
            setStoredPending((pending) =>
              pending.some((gate) => gate.callId === event.callId)
                ? pending
                : [
                    ...pending,
                    {
                      callId: event.callId,
                      tool: event.tool,
                      args: event.args,
                      hint: event.hint,
                      askedAt: new Date().toISOString(),
                    },
                  ],
            );
          }
          return;

        case 'turn.completed':
        case 'turn.aborted':
        case 'turn.failed': {
          if (event.type === 'turn.failed' && event.message.length > 0) {
            setError(event.message);
          }
          /*
           * The stored transcript wins from here. Dropping the live copy and
           * re-reading is what keeps what is on screen equal to what is in the
           * conversation — including after an abort, where only what the
           * provider finished was ever written.
           */
          const id = openSession.current;
          const active = profileRef.current;
          if (forUs && id !== null && active !== undefined) {
            setLive(null);
            void loadTranscript(active.id, id).catch(() => undefined);
          }
          return;
        }

        case 'session.changed': {
          const active = profileRef.current;
          if (active === undefined) {
            return;
          }
          void window.marimo
            .call('sessions.list', {profileId: active.id})
            .then(({sessions: next}) => {
              setSessions(next);
            })
            .catch(() => undefined);
          return;
        }

        default:
          return;
      }
    });

    return off;
  }, [loadTranscript]);

  useEffect(() => {
    void boot();
    // Once, on mount: this is the window's first look at the install, and
    // re-running it whenever a callback identity changed would re-open a
    // conversation under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noteCorrection = useCallback(
    async (
      messageId: string,
      excerpt: string,
      correction?: string,
    ): Promise<boolean> => {
      const sessionId = openSession.current;
      if (sessionId === null) {
        return false;
      }
      try {
        const result = await window.marimo.call('memory.feedback', {
          sessionId,
          messageId,
          // Capped here as well as in the schema: the answer can be arbitrarily
          // long and only the opening of it is needed to recognise it later.
          excerpt: excerpt.slice(0, 400),
          ...(correction === undefined || correction.trim().length === 0
            ? {}
            : {correction: correction.trim().slice(0, 400)}),
        });
        if (!result.ok) {
          setError(result.problem ?? 'That could not be recorded.');
          return false;
        }
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [],
  );

  const send = useCallback(
    async (
      text: string,
      origin: 'window' | 'pet' = 'window',
    ): Promise<boolean> => {
      if (profile === undefined || sessionId === null) {
        return false;
      }
      setError(null);
      /*
       * Drawn before the round trip rather than after it. The words are the one
       * thing the window already has, and a send that shows nothing until a turn
       * starts in another process reads as a message that did not go.
       */
      setOutbox(text);
      try {
        const {accepted} = await window.marimo.call('chat.send', {
          profileId: profile.id,
          sessionId,
          text,
          /*
           * Which surface asked. Stated rather than left to the default, so a
           * caller cannot end up looking like another by omission.
           */
          origin,
        });
        /*
         * Refused — a turn already running, an unknown conversation. The refusal
         * arrives as `turn.failed` and is drawn where every other failure is;
         * the echo goes with it, because a message that was never stored is not
         * one to leave on screen as if it had been.
         */
        if (!accepted) {
          setOutbox(null);
          return false;
        }
        return true;
      } catch (failure) {
        setOutbox(null);
        setError(describe(failure));
        return false;
      }
    },
    [profile, sessionId],
  );

  const decide = useCallback(
    async (callId: string, confirmed: boolean): Promise<void> => {
      if (profile === undefined || sessionId === null) {
        return;
      }
      // Taken down straight away rather than after the round trip: the button
      // has been pressed, and a card that stays put invites a second press.
      setStoredPending((pending) =>
        pending.filter((gate) => gate.callId !== callId),
      );
      try {
        await window.marimo.call('chat.approve', {
          profileId: profile.id,
          sessionId,
          callId,
          confirmed,
        });
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile, sessionId],
  );

  const stop = useCallback(async (): Promise<void> => {
    if (profile === undefined || sessionId === null) {
      return;
    }
    try {
      await window.marimo.call('chat.abort', {
        profileId: profile.id,
        sessionId,
      });
    } catch (failure) {
      setError(describe(failure));
    }
  }, [profile, sessionId]);

  /**
   * Starts a conversation, in the folder named or in the current one.
   *
   * A named folder is selected first rather than passed along: the *current*
   * folder is what the session is stamped with, and a chat created under a
   * highlighted folder that is not the current one would be filed somewhere the
   * user is not looking.
   */
  const newSession = useCallback(
    async (workspaceId?: string): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        if (workspaceId !== undefined && workspaceId !== activeWorkspaceId) {
          await selectWorkspace(workspaceId);
        }
        const {session} = await window.marimo.call('sessions.create', {
          profileId: profile.id,
        });
        setSessions((current) => [session, ...current]);
        setSessionId(session.id);
        setMessages([]);
        setStoredPending([]);
        setLive(null);
        setOutbox(null);
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile, activeWorkspaceId, selectWorkspace],
  );

  /*
   * Filing and naming replace the one entry rather than reloading the list.
   * Neither is activity, so the store leaves `updatedAt` alone — and a reload
   * would only re-derive the order the rail already has.
   */
  const moveSession = useCallback(
    async (sessionId: string, workspaceId: string | null): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        const {session} = await window.marimo.call('sessions.move', {
          profileId: profile.id,
          sessionId,
          workspaceId,
        });
        setSessions((current) =>
          current.map((entry) => (entry.id === session.id ? session : entry)),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        const {session} = await window.marimo.call('sessions.rename', {
          profileId: profile.id,
          sessionId,
          title,
        });
        setSessions((current) =>
          current.map((entry) => (entry.id === session.id ? session : entry)),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile],
  );

  /**
   * Deletes a conversation, and lands somewhere sensible.
   *
   * The list is re-read rather than filtered locally, because the question the
   * fallback answers is "what is left, newest first" — and the copy this window
   * holds is not the authority on that the moment anything else has written.
   * Deleting the last conversation starts a fresh one, which is what the window
   * opened with.
   */
  const removeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        await window.marimo.call('sessions.delete', {profileId: profile.id, sessionId});
        const {sessions: remaining} = await window.marimo.call('sessions.list', {
          profileId: profile.id,
        });
        setSessions(remaining);
        if (sessionId !== openSession.current) {
          return;
        }
        const next = remaining[0];
        setMessages([]);
        setStoredPending([]);
        setLive(null);
        setOutbox(null);
        if (next === undefined) {
          await newSession();
          return;
        }
        setSessionId(next.id);
        await loadTranscript(profile.id, next.id);
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile, loadTranscript, newSession],
  );

  const pending = useMemo(() => storedPending, [storedPending]);

  const activeFolder = useMemo(
    () =>
      folderForSession({
        workspaces,
        sessions,
        sessionId,
        activeWorkspaceId,
      }),
    [workspaces, sessions, sessionId, activeWorkspaceId],
  );

  /*
   * Waiting, from the moment the message is sent. `live` alone would leave the
   * gap between the send and the turn's first event unaccounted for, which is
   * the one moment the user is certain something should be happening.
   */
  const busy = live?.running === true || outbox !== null;

  return {
    ready,
    error,
    profile,
    sessions,
    sessionId,
    messages,
    pending,
    live,
    outbox,
    busy,
    send,
    decide,
    stop,
    noteCorrection,
    open,
    refresh,
    openSettings,
    themeMode,
    modelProgress,
    modelRevision,
    memoryWaiting,
    lastReview,
    clearMemoryWaiting: () => {
      setMemoryWaiting(0);
    },
    reload: boot,
    newSession,
    dismissError: () => {
      setError(null);
    },
    workspaces,
    activeWorkspaceId,
    activeFolder,
    loadWorkspace,
    selectWorkspace,
    renameWorkspace,
    removeWorkspace,
    openWorkspace,
    moveSession,
    renameSession,
    removeSession,
  };
}
