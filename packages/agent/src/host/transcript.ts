/**
 * Projects a stored ADK event log back into the message list the chat UI
 * renders.
 *
 * The event log is the source of truth (it is what ADK replays into the model),
 * but it is far too granular for a transcript: one assistant turn can be a
 * dozen events, tool results arrive as their own events, and the
 * human-in-the-loop gate is an event that must never be shown as dialogue.
 *
 * It is projected through `activeEvents` for the same reason. A compacted
 * conversation still *contains* every message it ever had — nothing was deleted,
 * and that is the point — but the model no longer sees them, and a window showing
 * a conversation the agent does not have is worse than one showing less than the
 * file holds. What the user sees instead is the card the compaction wrote.
 */
import {isCompactedEvent, REQUEST_CONFIRMATION_FUNCTION_CALL_NAME} from '@google/adk';

import {MAIN_AGENT_NAME} from '@marimo/protocol';
import type {TranscriptMessage, ToolCallRecord} from '@marimo/protocol';

import type {AdkEvent} from '../sessions/file-session-service.js';
import {activeEvents} from './compaction.js';

const MAX_RECORDED_RESULT = 4_000;

export function projectTranscript(events: AdkEvent[]): TranscriptMessage[] {
  const active = activeEvents(events);
  const first = active[0];
  const summary =
    first !== undefined && isCompactedEvent(first) ? first : undefined;
  if (summary === undefined) {
    return project(active);
  }

  /*
   * How many messages the card stands in for: the projection of everything the
   * file holds from before it, which is what the user would have been scrolling
   * through. Counted by projecting it, because a count of *events* would tell
   * them a number they never saw — one turn is several events.
   *
   * An earlier card is not counted as one of them. It was never a message
   * anybody wrote: the messages it stood for are counted here instead, so the
   * number is the same kind of number after a second compaction as after a
   * first.
   */
  const replaced = project(
    events.filter(
      (event) => !isCompactedEvent(event) && event.timestamp <= summary.endTime,
    ),
  ).length;

  return [
    {
      id: summary.id || 'compacted',
      role: 'user',
      /*
       * The provider is sent this as a user message — ADK's
       * `convertCompactedEvent` re-authors it that way — so the role is honest
       * even though the words are the model's. `compacted` is what makes the
       * transcript draw a card rather than a bubble in the user's own voice.
       */
      text: summary.compactedContent,
      compacted: replaced,
      createdAt: timestampOf(summary),
    },
    ...project(active.slice(1)),
  ];
}

function project(events: readonly AdkEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let assistant: TranscriptMessage | undefined;
  /*
   * Which agent the open bubble belongs to — the parent, or a helper it
   * spawned. A change of author closes the bubble, because two agents' words in
   * one bubble read as one answer from one mind, and the user has no way to tell
   * which of them said the thing they are looking at.
   */
  let author: string | undefined;

  for (const event of events) {
    const parts = event.content?.parts ?? [];
    const isUser = event.author === 'user';

    if (isUser) {
      const text = textOf(parts);
      if (text.length > 0) {
        messages.push({
          id: event.id || `event-${messages.length}`,
          role: 'user',
          text,
          createdAt: timestampOf(event),
        });
        // The next agent-authored event opens a fresh assistant bubble rather
        // than appending to the previous one.
        assistant = undefined;
        author = undefined;
      }
      continue;
    }

    if (parts.length === 0 && !event.errorMessage) {
      continue;
    }

    /*
     * Who wrote this, where the main agent is `undefined`. The agent's own name
     * is not useful here — everything that is not a helper is the agent the user
     * is talking to.
     */
    const from = helperName(event.author);

    /*
     * A bubble belongs to one speaker, so a change of speaker starts a new one.
     * That is the whole of the attribution: without it a helper's words and the
     * agent's merge, and the user reads one answer from one mind where there
     * were two.
     */
    if (assistant === undefined || from !== author) {
      assistant = {
        id: event.id || `event-${messages.length}`,
        role: 'assistant',
        ...(from === undefined ? {} : {subagent: from}),
        text: '',
        createdAt: timestampOf(event),
      };
      author = from;
      if (messages[messages.length - 1] !== assistant) {
        messages.push(assistant);
      }
    }

    const text = textOf(parts);
    if (text.length > 0) {
      assistant.text += text;
    }

    // Reasoning is stored as thought parts on the same event, so reopening a
    // conversation shows the same reasoning block the live turn showed.
    const reasoning = reasoningOf(parts);
    if (reasoning.length > 0) {
      assistant.reasoning = (assistant.reasoning ?? '') + reasoning;
    }

    for (const part of parts) {
      const call = part.functionCall;
      if (call && call.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
        const record: ToolCallRecord = {
          callId: call.id ?? '',
          tool: call.name ?? 'unknown',
          args: call.args ?? {},
        };
        assistant.toolCalls ??= [];
        assistant.toolCalls.push(record);
      }

      const response = part.functionResponse;
      if (
        response &&
        response.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME
      ) {
        const record = assistant.toolCalls?.find(
          (candidate) => candidate.callId === response.id,
        );
        if (record) {
          record.result = truncate(stringify(response.response));
          record.ok = !hasError(response.response);
        }
      }
    }

    if (event.errorMessage) {
      assistant.error = event.errorMessage;
    }
  }

  /*
   * Against the events being projected rather than all of them: a gate inside a
   * compacted span is not a turn that stopped waiting, it is a turn the
   * conversation has moved past — and a card that came back with "this stopped
   * while waiting for your approval" on a summary the user just asked for would
   * be describing something that is no longer in the request at all.
   */
  markInterruptedGate([...events], messages);
  return messages;
}

/**
 * A gate with no answer means the app closed while the user was deciding. The
 * turn cannot be resumed (approvals live in memory), so the transcript says so
 * instead of looking like the model simply stopped.
 */
function markInterruptedGate(
  events: AdkEvent[],
  messages: TranscriptMessage[],
): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.error) {
    return;
  }

  const pending = new Map<string, string>();
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      const call = part.functionCall;
      if (
        call?.id &&
        call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
        event.author !== 'user'
      ) {
        const pinned = pinnedToolName(call.args);
        pending.set(call.id, pinned);
      }
      const response = part.functionResponse;
      if (
        response?.id &&
        response.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME
      ) {
        pending.delete(response.id);
      }
    }
  }

  if (pending.size > 0) {
    last.error =
      'This turn stopped while waiting for your approval and cannot be resumed after a restart.';
  }
}

function pinnedToolName(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return 'unknown';
  }
  const original = (args as {originalFunctionCall?: {name?: string}})
    .originalFunctionCall;
  return original?.name ?? 'unknown';
}

function textOf(parts: NonNullable<AdkEvent['content']>['parts']): string {
  if (!parts?.length) {
    return '';
  }
  return parts
    .map((part) =>
      part.thought === true || typeof part.text !== 'string' ? '' : part.text,
    )
    .join('');
}

function reasoningOf(parts: NonNullable<AdkEvent['content']>['parts']): string {
  if (!parts?.length) {
    return '';
  }
  return parts
    .map((part) =>
      part.thought === true && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
}

function timestampOf(event: AdkEvent): string {
  const timestamp = event.timestamp;
  if (typeof timestamp === 'number' && timestamp > 0) {
    return new Date(timestamp).toISOString();
  }
  return new Date().toISOString();
}

function hasError(response: unknown): boolean {
  return (
    !!response &&
    typeof response === 'object' &&
    ('error' in (response as Record<string, unknown>) ||
      'errorMessage' in (response as Record<string, unknown>))
  );
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && 'result' in (value as object)) {
    const inner = (value as {result: unknown}).result;
    if (typeof inner === 'string') {
      return inner;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(value: string): string {
  return value.length > MAX_RECORDED_RESULT
    ? `${value.slice(0, MAX_RECORDED_RESULT)}\n… [truncated]`
    : value;
}

/**
 * The helper an event came from, or `undefined` for the main agent.
 *
 * `author` is the ADK agent's name, and the main agent is built under one fixed
 * name — so anything else in this conversation is a helper. Matching on "is it
 * the main agent" rather than on a list of helper names means a helper that was
 * spawned under a name nobody recorded is still attributed correctly, which is
 * the case that matters: the alternative is a stranger's words in the agent's
 * voice.
 */
function helperName(author: string | undefined): string | undefined {
  if (author === undefined || author === MAIN_AGENT_NAME) {
    return undefined;
  }
  return author;
}
