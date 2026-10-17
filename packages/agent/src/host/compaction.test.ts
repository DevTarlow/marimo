/**
 * Compaction: what gets summarised, and what the summariser is given.
 *
 * Every rule here is one that breaks a conversation rather than a test. A cut
 * between a tool call and its result is refused by the provider on that turn and
 * every turn after it; a summary prompt that dropped the tool calls would lose
 * what the agent *did*, which for a coding agent is most of the history worth
 * keeping; and a compacted event with the wrong `endTime` either hides the
 * retained tail from the model or leaves the whole log in the request, which is
 * the thing compaction exists to stop.
 */
import {getFunctionCalls, getFunctionResponses} from '@google/adk';
import {describe, expect, it} from 'vitest';

import type {AdkEvent} from '../sessions/file-session-service.js';
import {
  AUTO_COMPACT_AT_CHARS,
  activeContextChars,
  activeEvents,
  buildCompactedEvent,
  compactionPrompt,
  MAX_COMPACT_INPUT_CHARS,
  MAX_SUMMARY_RESULT_CHARS,
  planAutoCompaction,
  planCompaction,
  renderForSummary,
  retainStartIndex,
} from './compaction.js';

/** An event at a chosen moment: `activeEvents` compares timestamps strictly. */
function at(millis: number, build: (params: {timestamp: number}) => AdkEvent): AdkEvent {
  return build({timestamp: millis});
}

function user(text: string, millis: number): AdkEvent {
  return at(millis, (params) =>
    makeEvent({author: 'user', role: 'user', parts: [{text}], ...params}),
  );
}

function agent(parts: Array<Record<string, unknown>>, millis: number): AdkEvent {
  return at(millis, (params) =>
    makeEvent({author: 'marimo', role: 'model', parts, ...params}),
  );
}

function toolResult(id: string, result: string, millis: number): AdkEvent {
  return at(millis, (params) =>
    makeEvent({
      author: 'user',
      role: 'user',
      parts: [{functionResponse: {id, name: 'read_file', response: {result}}}],
      ...params,
    }),
  );
}

function makeEvent(params: {
  author: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  timestamp: number;
}): AdkEvent {
  return {
    id: `event-${String(params.timestamp)}`,
    invocationId: `inv-${String(params.timestamp)}`,
    author: params.author,
    timestamp: params.timestamp,
    content: {role: params.role, parts: params.parts},
    actions: {stateDelta: {}},
  } as unknown as AdkEvent;
}

/** `keep` user turns, each with an answer, at one-second intervals. */
function conversation(turns: number, start = 1_000): AdkEvent[] {
  const events: AdkEvent[] = [];
  for (let index = 0; index < turns; index += 1) {
    const base = start + index * 1_000;
    events.push(user(`question ${String(index)}`, base));
    events.push(agent([{text: `answer ${String(index)}`}], base + 10));
  }
  return events;
}

describe('activeEvents', () => {
  it('returns everything when nothing was ever compacted', () => {
    const events = conversation(3);
    expect(activeEvents(events)).toEqual(events);
  });

  it('returns the newest summary and everything written after it', () => {
    const events = conversation(3);
    const summary = buildCompactedEvent({
      summary: 'the first two turns',
      startTime: events[0]?.timestamp ?? 0,
      endTime: events[1]?.timestamp ?? 0,
    });
    // Its own timestamp is "now", which is what puts it last in the file.
    const withSummary = [...events, {...summary, timestamp: 9_000}];

    const active = activeEvents(withSummary);
    expect(active[0]).toBe(withSummary[withSummary.length - 1]);
    expect(active).toHaveLength(1 + (events.length - 2));
    // The events it stands in for are gone from the request, and still on disk.
    expect(withSummary).toHaveLength(events.length + 1);
  });

  it('prefers the newest summary when there is more than one', () => {
    const events = conversation(3);
    const first = {
      ...buildCompactedEvent({summary: 'first', startTime: 0, endTime: 1}),
      timestamp: 4_000,
    };
    const second = {
      ...buildCompactedEvent({summary: 'second', startTime: 0, endTime: 3_100}),
      timestamp: 9_000,
    };

    const active = activeEvents([...events, first, second]);
    expect(active[0]).toBe(second);
    expect(active).toHaveLength(1);
  });
});

describe('retainStartIndex', () => {
  it('keeps the newest events', () => {
    const events = conversation(6);
    expect(retainStartIndex(events, 4)).toBe(events.length - 4);
  });

  it('widens rather than cutting between a call and its result', () => {
    const events = [
      user('read it', 1_000),
      agent([{functionCall: {id: 'call-1', name: 'read_file', args: {}}}], 1_010),
      toolResult('call-1', 'the file', 1_020),
      agent([{text: 'done'}], 1_030),
    ];

    /*
     * `keep: 2` would land the boundary on the tool result, whose call is in the
     * event before it. Splitting the two is the classic compaction bug: the
     * provider refuses a result whose call is missing, on this turn and on every
     * later turn of the conversation.
     */
    const index = retainStartIndex(events, 2);
    expect(index).toBe(1);
    const retained = events.slice(index);
    const responseIds = retained.flatMap((event) =>
      getFunctionResponses(event).map((response) => response.id),
    );
    const callIds = retained.flatMap((event) =>
      getFunctionCalls(event).map((call) => call.id),
    );
    for (const id of responseIds) {
      expect(callIds).toContain(id);
    }
  });
});

describe('planCompaction', () => {
  it('has nothing to plan for a conversation that fits', () => {
    expect(planCompaction(conversation(3), 12)).toBeUndefined();
  });

  it('summarises the older events and keeps the newest', () => {
    const events = conversation(8);
    const plan = planCompaction(events, 4);
    expect(plan).toBeDefined();
    expect(plan?.summarise).toEqual(events.slice(0, events.length - 4));
    expect(plan?.startTime).toBe(events[0]?.timestamp);
    expect(plan?.endTime).toBe(events[events.length - 5]?.timestamp);
  });

  it('folds the previous summary in, so a second compaction loses nothing', () => {
    const events = conversation(6);
    const summary = {
      ...buildCompactedEvent({summary: 'what happened first', startTime: 1, endTime: 2}),
      timestamp: 3_000,
    };
    const later = conversation(8, 100_000);

    const plan = planCompaction([...events, summary, ...later], 4);
    expect(plan?.previous).toBe('what happened first');
    // The span still starts where the conversation did, not where this pass did.
    expect(plan?.startTime).toBe(1);
  });
});

describe('renderForSummary', () => {
  it('includes what the agent did, not only what was said', () => {
    const rendered = renderForSummary([
      user('read the config', 1_000),
      agent([{functionCall: {id: 'c1', name: 'read_file', args: {path: 'a.ts'}}}], 1_010),
      toolResult('c1', 'export const one = 1;', 1_020),
      agent([{text: 'It exports one.'}], 1_030),
    ]);

    expect(rendered).toContain('user: read the config');
    expect(rendered).toContain('→ read_file {"path":"a.ts"}');
    expect(rendered).toContain('← export const one = 1;');
    expect(rendered).toContain('agent: It exports one.');
  });

  it('leaves the model\'s thinking out', () => {
    const rendered = renderForSummary([
      agent([{text: 'hidden working', thought: true}, {text: 'the answer'}], 1_000),
    ]);

    expect(rendered).toBe('agent: the answer');
  });

  it('caps a tool result rather than pasting a whole file in', () => {
    const rendered = renderForSummary([
      toolResult('c1', 'x'.repeat(MAX_SUMMARY_RESULT_CHARS * 3), 1_000),
    ]);

    expect(rendered.length).toBeLessThan(MAX_SUMMARY_RESULT_CHARS + 100);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('drops the head and says so when the input is over the cap', () => {
    const events: AdkEvent[] = [];
    for (let index = 0; index < 60; index += 1) {
      events.push(user(`m${String(index)} ${'y'.repeat(4_000)}`, 1_000 + index));
    }

    const rendered = renderForSummary(events);
    // The tail is what is kept: that is where the conversation arrived.
    expect(rendered).toContain('m59');
    expect(rendered).toContain('left out of this summary');
    expect(rendered).not.toContain('m0 ');
    expect(rendered.length).toBeLessThan(MAX_COMPACT_INPUT_CHARS + 200);
  });
});

describe('compactionPrompt', () => {
  it('carries the earlier summary ahead of the messages it stands for', () => {
    const prompt = compactionPrompt('user: hello', 'they set up a project');

    expect(prompt).toContain('from an earlier compaction');
    expect(prompt.indexOf('they set up a project')).toBeLessThan(
      prompt.indexOf('user: hello'),
    );
    // The frame matters as much as the content: the answer replaces the
    // messages, so a summary that opens by announcing itself wastes the top of
    // the prompt it is about to become.
    expect(prompt).toContain('the first sentence is the summary');
  });
});

describe('buildCompactedEvent', () => {
  it('carries the summary, the span it replaces and no invocation', () => {
    const event = buildCompactedEvent({
      summary: 'they fixed the parser',
      startTime: 1_000,
      endTime: 2_000,
    });

    expect(event.isCompacted).toBe(true);
    expect(event.compactedContent).toBe('they fixed the parser');
    expect(event.startTime).toBe(1_000);
    expect(event.endTime).toBe(2_000);
    // Now, so that it sorts last in an append-only file.
    expect(event.timestamp).toBeGreaterThanOrEqual(2_000);
    /*
     * It belongs to no turn. `pendingGatesIn` skips compacted events for exactly
     * this reason: a different id would read as a new invocation and clear the
     * cards of the turn that is waiting.
     */
    expect(event.invocationId).toBe('');
  });
});

describe('automatic compaction', () => {
  it('measures what the model is sent, including reasoning and tool output', () => {
    const events = [
      user('look at the file', 1_000),
      agent(
        [
          {text: 'thinking about it', thought: true},
          {functionCall: {id: 'c1', name: 'read_file', args: {path: 'a.ts'}}},
        ],
        1_010,
      ),
      toolResult('c1', 'x'.repeat(10_000), 1_020),
    ];

    // The summary renderer would cap that result at 500 characters; the context
    // measurement must not, because this is the number the trigger is based on.
    expect(activeContextChars(events)).toBeGreaterThan(10_000);
  });

  it('does not summarize below the cap, however many short turns there are', () => {
    expect(
      planAutoCompaction(conversation(30), {atChars: AUTO_COMPACT_AT_CHARS}),
    ).toBeUndefined();
  });

  it('summarizes once the cap is crossed, and keeps the tool-call cut', () => {
    const events = [
      ...conversation(8),
      user('y'.repeat(1_000), 20_000),
    ];
    const plan = planAutoCompaction(events, {keep: 4, atChars: 1_000});
    expect(plan).toBeDefined();
    expect(plan?.summarise).toEqual(events.slice(0, events.length - 4));
  });

  it('does nothing for a long message that has no older half to replace', () => {
    // One event is under `keep`, so the size test passes but `planCompaction`
    // has no cut to make. The result is "nothing to do", not an empty summary.
    expect(
      planAutoCompaction([user('y'.repeat(100_000), 1_000)], {
        atChars: 1_000,
      }),
    ).toBeUndefined();
  });
});
