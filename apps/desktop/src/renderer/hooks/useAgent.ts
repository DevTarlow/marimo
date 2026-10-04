/**
 * The conversation, in the window.
 *
 * Two sources feed the transcript, and keeping them apart is the whole design:
 *
 * - **The stored transcript** is what was actually written down. It is read when
 *   a conversation is opened and again when a turn ends.
 * - **The live turn** is what is arriving right now, assembled from the event
 *   stream so the answer appears as it is written rather than after it is
 *   finished.
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
  AgentUiEvent,
  PendingGate,
  SessionSummary,
  ToolCallRecord,
  TranscriptMessage,
} from '@marimo/protocol';

/*
 * A tool call in flight and a tool call read back from disk are the same shape,
 * and deliberately: `ToolCallRecord` is what the transcript stores, so a live
 * call that used a different type would need converting at exactly the moment
 * the two are swapped. `ok` being absent is what says "still running".
 */
export type LiveToolCall = ToolCallRecord;

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
  send: (text: string) => Promise<void>;
  decide: (callId: string, confirmed: boolean) => Promise<void>;
  stop: () => Promise<void>;
  open: (sessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
  dismissError: () => void;
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
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
    },
    [],
  );

  const open = useCallback(
    async (id: string): Promise<void> => {
      setSessionId(id);
      setLive(null);
      setStoredPending([]);
      setMessages([]);
      if (profile) {
        await loadTranscript(profile.id, id);
      }
    },
    [profile, loadTranscript],
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
  }, [loadTranscript]);

  /* The stream. Registered once; everything it needs is read from refs. */
  useEffect(() => {
    const off = window.marimo.onEvent((event: AgentUiEvent) => {
      /*
       * Not every event belongs to a conversation. An MCP server connecting, the
       * agent profile changing, the skills list changing: those carry no session
       * id at all and are drawn by whatever owns them. This listener is only the
       * conversation, so it stops here rather than guessing at a session.
       */
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

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (profile === undefined || sessionId === null) {
        return;
      }
      setError(null);
      try {
        await window.marimo.call('chat.send', {
          profileId: profile.id,
          sessionId,
          text,
        });
      } catch (failure) {
        setError(describe(failure));
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

  const newSession = useCallback(async (): Promise<void> => {
    if (profile === undefined) {
      return;
    }
    try {
      const {session} = await window.marimo.call('sessions.create', {
        profileId: profile.id,
      });
      setSessions((current) => [session, ...current]);
      setSessionId(session.id);
      setMessages([]);
      setStoredPending([]);
      setLive(null);
    } catch (failure) {
      setError(describe(failure));
    }
  }, [profile]);

  const pending = useMemo(() => storedPending, [storedPending]);

  return {
    ready,
    error,
    profile,
    sessions,
    sessionId,
    messages,
    pending,
    live,
    send,
    decide,
    stop,
    open,
    newSession,
    dismissError: () => {
      setError(null);
    },
  };
}
