/**
 * Compaction: the older part of a conversation, replaced by a summary.
 *
 * The mechanism is ADK's, and it is worth stating plainly because it is what
 * makes this safe: a *compacted event* is an ordinary event that carries a
 * summary and the span of time it stands in for. ADK's `ContentRequestProcessor`
 * calls `getActiveEvents` before it builds the request, and that returns the
 * newest compacted event plus everything written after it — so appending one
 * event changes what the model sees, and nothing else has to agree.
 *
 * Which means nothing is rewritten. The conversation file keeps every message it
 * ever had, stays append-only, and stays a plain JSONL file. Three things that
 * would each have broken quietly are dodged by that: the sidebar's `messageCount`
 * and the memory review's event-count watermark, both of which a truncating
 * rewrite would leave describing a file that no longer exists; and the approval
 * gates, which are *derived* from the stored events — an unanswered gate inside
 * the compacted span would have been deleted along with its card.
 *
 * Two of the helpers below mirror ADK's own, and only because ADK does not export
 * them: `getActiveEvents` and `calculateRetainStartIndex` live in
 * `context/compaction_utils.js` and are not re-exported from the package root.
 * `isCompactedEvent`, `createEvent`, `getFunctionCalls` and `getFunctionResponses`
 * are, so the rest of the shape is ADK's rather than a copy of it.
 */
import {
  createEvent,
  getFunctionCalls,
  getFunctionResponses,
  isCompactedEvent,
} from '@google/adk';
import type {CompactedEvent} from '@google/adk';

import type {AdkEvent} from '../sessions/file-session-service.js';

/**
 * How many of the newest events stay verbatim.
 *
 * Roughly the last turn or two. `retainStartIndex` widens it rather than
 * splitting a tool call from its result, so a tool-heavy turn costs more than
 * this number of events and still stays whole.
 */
export const COMPACT_KEEP_EVENTS = 12;

/**
 * The cap on what one summary call is given.
 *
 * Characters rather than tokens, because that is what the app can count without
 * a tokenizer; ADK estimates the same way (four characters to a token) when it
 * has no usage metadata to read. Well under any context window: the point of the
 * call is to make the conversation smaller.
 */
export const MAX_COMPACT_INPUT_CHARS = 120_000;

/**
 * When a conversation is long enough to summarize without being asked.
 *
 * A character budget rather than a token count, because this app has no
 * tokenizer and the provider catalogue carries no context-window metadata.
 * ADK estimates four characters to a token, so this is roughly fifteen thousand
 * tokens — well under a 32k-token context once the instruction, tool schemas and
 * the reply have their room, and far enough above a normal conversation that a
 * chat is not rewritten on every turn. It is deliberately conservative: the
 * failure on the other side is a provider refusing a request because the history
 * did not fit, which the user reads as the app being broken.
 */
export const AUTO_COMPACT_AT_CHARS = 60_000;

/** How much of one tool result goes into the summary prompt. */
export const MAX_SUMMARY_RESULT_CHARS = 500;

const OMITTED =
  '[the earliest part of this conversation was left out of this summary because of its length]';

/**
 * What the model would be sent — the newest summary, plus everything after it.
 *
 * A mirror of ADK's `getActiveEvents`, with the isolation-scope filter left out
 * because nothing in this app sets a scope. The comparison is strict (`>`), which
 * is why the compacted event's `endTime` is the timestamp of the last event it
 * stands in for.
 */
export function activeEvents(events: readonly AdkEvent[]): AdkEvent[] {
  let latest: CompactedEvent | undefined;
  for (const event of events) {
    if (isCompactedEvent(event)) {
      latest = event;
    }
  }
  if (latest === undefined) {
    return [...events];
  }
  const cutoff = latest.endTime;
  return [
    latest,
    ...events.filter(
      (event) => !isCompactedEvent(event) && event.timestamp > cutoff,
    ),
  ];
}

/**
 * Where to cut, so that no tool call is separated from its answer.
 *
 * A mirror of ADK's `calculateRetainStartIndex`: start `keep` events from the
 * end, then walk the boundary backwards while the first retained event holds
 * function *responses* whose calls are in the event before it. Cutting between
 * the two is the classic compaction bug — the provider refuses a result whose
 * call is missing, on that turn and on every later turn of the conversation.
 */
export function retainStartIndex(
  events: readonly AdkEvent[],
  keep: number,
): number {
  let index = Math.max(0, events.length - keep);
  while (index > 0) {
    const retained = events[index];
    const previous = events[index - 1];
    if (
      retained !== undefined &&
      previous !== undefined &&
      getFunctionResponses(retained).length > 0 &&
      getFunctionCalls(previous).length > 0
    ) {
      index -= 1;
    } else {
      break;
    }
  }
  return index;
}

export interface CompactionPlan {
  /** The events the summary stands in for, oldest first. */
  summarise: AdkEvent[];
  /** The previous card's text, when this is the second compaction or later. */
  previous?: string;
  startTime: number;
  endTime: number;
}

/**
 * What to summarise, or `undefined` when there is nothing to do.
 *
 * `undefined` rather than an empty plan, because "nothing to compact" is a
 * perfectly ordinary answer for a short conversation and the caller has to be
 * able to say so instead of appending a card that replaced nothing.
 */
export function planCompaction(
  events: readonly AdkEvent[],
  keep: number = COMPACT_KEEP_EVENTS,
): CompactionPlan | undefined {
  const active = activeEvents(events);
  const raw = active.filter((event) => !isCompactedEvent(event));
  if (raw.length <= keep) {
    return undefined;
  }
  const index = retainStartIndex(raw, keep);
  if (index === 0) {
    return undefined;
  }

  const summarise = raw.slice(0, index);
  const first = summarise[0];
  const last = summarise[summarise.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }

  /*
   * A second compaction folds the first summary into the new one. Leaving it out
   * would throw away everything the first one captured: the events it stood in
   * for are no longer rendered, and the previous card is about to be replaced.
   */
  const previous = active.find(isCompactedEvent);
  return {
    summarise,
    ...(previous === undefined ? {} : {previous: previous.compactedContent}),
    startTime: previous?.startTime ?? first.timestamp,
    endTime: last.timestamp,
  };
}

/**
 * How much of the active context one event contributes, in characters.
 *
 * Everything the model is actually sent counts: text, reasoning, a tool call's
 * arguments and a tool result in full. The summary renderer below is the wrong
 * measurement because it caps each result at 500 characters — a turn that read a
 * large file would look small to it and never trigger a summary.
 */
function eventContextChars(event: AdkEvent): number {
  let total = 0;
  const compacted = (event as {compactedContent?: unknown}).compactedContent;
  if (typeof compacted === 'string') {
    total += compacted.length;
  }
  for (const part of event.content?.parts ?? []) {
    if (part.functionCall !== undefined) {
      total += part.functionCall.name?.length ?? 0;
      total += jsonLength(part.functionCall.args);
      continue;
    }
    if (part.functionResponse !== undefined) {
      total += resultText(part.functionResponse.response).length;
      continue;
    }
    if (typeof part.text === 'string') {
      total += part.text.length;
    }
  }
  // A small allowance for the roles, ids and separators a request carries.
  return total + 16;
}

/**
 * The size of what a request built from these events would contain.
 *
 * Active events rather than the whole log: a conversation whose older half is
 * already a summary is measured by the summary plus what came after it, which is
 * exactly what the model is sent. An already-compacted conversation therefore
 * does not trigger a second summary just because its file is long.
 */
export function activeContextChars(events: readonly AdkEvent[]): number {
  return activeEvents(events).reduce(
    (total, event) => total + eventContextChars(event),
    0,
  );
}

/**
 * What to summarize automatically, or `undefined` when the conversation fits.
 *
 * The size test comes first, and that order is the point: `planCompaction` alone
 * answers "is there an older half to replace", which is true after a dozen
 * messages even when the whole conversation is a few kilobytes. Automatic
 * summarization is for a context that has grown too large, not for a
 * conversation that has merely continued.
 */
export function planAutoCompaction(
  events: readonly AdkEvent[],
  options: {keep?: number; atChars?: number} = {},
): CompactionPlan | undefined {
  const atChars = options.atChars ?? AUTO_COMPACT_AT_CHARS;
  if (activeContextChars(events) < atChars) {
    return undefined;
  }
  return planCompaction(events, options.keep);
}

/**
 * The conversation as text for the summariser.
 *
 * Tool calls are included, with their results capped: what a coding agent *did*
 * — which files it read and wrote, what came back — is most of what the summary
 * has to preserve, and ADK's own summariser renders text parts only. Reasoning is
 * left out, being the model's working rather than anything that was said.
 *
 * Over the cap, the *head* is dropped rather than the tail, and the prompt says
 * so. The tail is where the conversation arrived; the head is the part a previous
 * summary already stands for, and that summary is passed in beside this text.
 */
export function renderForSummary(events: readonly AdkEvent[]): string {
  const blocks: string[] = [];
  for (const event of events) {
    const block = renderEvent(event);
    if (block.length > 0) {
      blocks.push(block);
    }
  }
  const joined = blocks.join('\n\n');
  if (joined.length <= MAX_COMPACT_INPUT_CHARS) {
    return joined;
  }
  return `${OMITTED}\n\n${joined.slice(joined.length - MAX_COMPACT_INPUT_CHARS)}`;
}

function renderEvent(event: AdkEvent): string {
  const who = event.author === 'user' ? 'user' : 'agent';
  const lines: string[] = [];
  for (const part of event.content?.parts ?? []) {
    if (part.functionCall !== undefined) {
      lines.push(
        `→ ${part.functionCall.name ?? 'unknown'} ${cap(JSON.stringify(part.functionCall.args ?? {}))}`,
      );
      continue;
    }
    if (part.functionResponse !== undefined) {
      lines.push(`← ${cap(resultText(part.functionResponse.response))}`);
      continue;
    }
    // Thoughts are what the model was doing, not what was said.
    if (part.thought === true || typeof part.text !== 'string') {
      continue;
    }
    if (part.text.trim().length > 0) {
      lines.push(part.text.trim());
    }
  }
  return lines.length === 0 ? '' : `${who}: ${lines.join('\n')}`;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function resultText(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }
  if (
    typeof response === 'object' &&
    response !== null &&
    'result' in response &&
    typeof (response as {result: unknown}).result === 'string'
  ) {
    return (response as {result: string}).result;
  }
  try {
    return JSON.stringify(response ?? '');
  } catch {
    return String(response);
  }
}

function cap(value: string): string {
  return value.length > MAX_SUMMARY_RESULT_CHARS
    ? `${value.slice(0, MAX_SUMMARY_RESULT_CHARS)}…`
    : value;
}

/**
 * What the model is asked for.
 *
 * The frame is the important part: the answer *replaces* the messages, so it has
 * to carry what the agent would need to carry on, and an assistant's instinct to
 * open with "Here is a summary of the conversation so far" is five wasted lines
 * inside a prompt that is already long.
 */
const INSTRUCTION = `Below is part of a conversation between a user and a coding agent that you are going to continue. Write the summary that will replace those messages in its history.

Keep: what the user asked for and what was decided; the files, paths and commands that matter; what was changed and how; and anything that is still open. Drop: detail that is finished and no longer relevant, and any account of the agent's own reasoning.

Write plain prose, in the third person, addressed to nobody. Do not greet, do not explain what you are doing, and do not open with a line about summarising — the first sentence is the summary.`;

export function compactionPrompt(rendered: string, previous?: string): string {
  const parts = [INSTRUCTION];
  if (previous !== undefined) {
    parts.push(
      `Summary of the conversation so far, from an earlier compaction:\n${previous}`,
    );
  }
  parts.push(rendered);
  return parts.join('\n\n');
}

/**
 * The event that stands in for the ones being replaced.
 *
 * `invocationId` is deliberately left as the empty string `createEvent` gives it:
 * a compaction is not a turn and belongs to no invocation. `pendingGatesIn` skips
 * these events for the same reason — see the comment there.
 *
 * `author` is `system` because that is what ADK's own `LlmSummarizer` writes. It
 * is not one of the app's agents, so ADK's resumption walk logs "Event from an
 * unknown agent: system" once per turn and carries on to the newest real event —
 * noise rather than a fault, and cheaper than deviating from the shape ADK
 * recognises.
 *
 * `endTime` is what `activeEvents` compares against, so it has to be the
 * timestamp of the last event being replaced, while the event's own `timestamp`
 * is now, which is what puts it last in the file.
 */
export function buildCompactedEvent(params: {
  summary: string;
  startTime: number;
  endTime: number;
}): CompactedEvent {
  return {
    ...createEvent({
      author: 'system',
      content: {role: 'model', parts: [{text: params.summary}]},
      timestamp: Date.now(),
    }),
    isCompacted: true,
    startTime: params.startTime,
    endTime: params.endTime,
    compactedContent: params.summary,
  };
}
