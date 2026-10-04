/**
 * Projects a stored ADK event log back into the message list the chat UI
 * renders.
 *
 * The event log is the source of truth (it is what ADK replays into the model),
 * but it is far too granular for a transcript: one assistant turn can be a
 * dozen events, tool results arrive as their own events, and the
 * human-in-the-loop gate is an event that must never be shown as dialogue.
 */
import {REQUEST_CONFIRMATION_FUNCTION_CALL_NAME} from '@google/adk';

import type {TranscriptMessage, ToolCallRecord} from '@marimo/protocol';

import type {AdkEvent} from '../sessions/file-session-service.js';

const MAX_RECORDED_RESULT = 4_000;

export function projectTranscript(events: AdkEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let assistant: TranscriptMessage | undefined;

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
      }
      continue;
    }

    if (parts.length === 0 && !event.errorMessage) {
      continue;
    }

    assistant ??= {
      id: event.id || `event-${messages.length}`,
      role: 'assistant',
      text: '',
      createdAt: timestampOf(event),
    };

    if (messages[messages.length - 1] !== assistant) {
      messages.push(assistant);
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

  markInterruptedGate(events, messages);
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
