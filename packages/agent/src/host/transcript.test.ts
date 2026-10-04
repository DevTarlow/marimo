import {createEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';

import type {AdkEvent} from '../sessions/file-session-service.js';
import {projectTranscript} from './transcript.js';

const GATE = 'adk_request_confirmation';

function user(text: string): AdkEvent {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  }) as AdkEvent;
}

function agent(parts: Array<Record<string, unknown>>): AdkEvent {
  return createEvent({
    author: 'marimo',
    content: {role: 'model', parts: parts as never},
  }) as AdkEvent;
}

/** A helper agent's event, under the name it was spawned with. */
function helper(name: string, parts: Array<Record<string, unknown>>): AdkEvent {
  return createEvent({
    author: name,
    content: {role: 'model', parts: parts as never},
  }) as AdkEvent;
}

describe('projectTranscript', () => {
  it('groups consecutive agent events into one assistant message', () => {
    const messages = projectTranscript([
      user('question'),
      agent([{text: 'part one '}]),
      agent([{text: 'part two'}]),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({role: 'user', text: 'question'});
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      text: 'part one part two',
    });
  });

  it('starts a new assistant message after each user turn', () => {
    const messages = projectTranscript([
      user('one'),
      agent([{text: 'first answer'}]),
      user('two'),
      agent([{text: 'second answer'}]),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages[3]?.text).toBe('second answer');
  });

  it('pairs a tool call with its result and records failure', () => {
    const messages = projectTranscript([
      user('read it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'read_file',
            args: {path: 'a.txt'},
          },
        },
      ]),
      agent([
        {
          functionResponse: {
            id: 'call_1',
            name: 'read_file',
            response: {result: 'contents'},
          },
        },
      ]),
      agent([
        {functionCall: {id: 'call_2', name: 'run_shell', args: {command: 'x'}}},
      ]),
      agent([
        {
          functionResponse: {
            id: 'call_2',
            name: 'run_shell',
            response: {error: 'boom'},
          },
        },
      ]),
    ]);

    const assistant = messages[1];
    expect(assistant?.toolCalls).toHaveLength(2);
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      callId: 'call_1',
      tool: 'read_file',
      result: 'contents',
      ok: true,
    });
    expect(assistant?.toolCalls?.[1]).toMatchObject({
      callId: 'call_2',
      tool: 'run_shell',
      ok: false,
    });
  });

  it('never renders the approval gate as a tool call', () => {
    const messages = projectTranscript([
      user('run it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'run_shell',
            args: {command: 'ls'},
          },
        },
      ]),
      agent([
        {
          functionCall: {
            id: 'gate_1',
            name: GATE,
            args: {
              originalFunctionCall: {id: 'call_1', name: 'run_shell', args: {}},
              toolConfirmation: {hint: 'approve?'},
            },
          },
        },
      ]),
    ]);

    expect(messages[1]?.toolCalls).toHaveLength(1);
    expect(messages[1]?.toolCalls?.[0]?.tool).toBe('run_shell');
  });

  it('flags a gate that was never answered as an interrupted turn', () => {
    const messages = projectTranscript([
      user('run it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'run_shell',
            args: {command: 'ls'},
          },
        },
      ]),
      agent([
        {
          functionCall: {
            id: 'gate_1',
            name: GATE,
            args: {
              originalFunctionCall: {id: 'call_1', name: 'run_shell', args: {}},
            },
          },
        },
      ]),
    ]);

    expect(messages[1]?.error).toMatch(/waiting for your approval/);
  });

  it('does not flag a gate that has an answer', () => {
    const messages = projectTranscript([
      user('run it'),
      agent([
        {
          functionCall: {
            id: 'call_1',
            name: 'run_shell',
            args: {command: 'ls'},
          },
        },
      ]),
      agent([
        {
          functionCall: {
            id: 'gate_1',
            name: GATE,
            args: {
              originalFunctionCall: {id: 'call_1', name: 'run_shell', args: {}},
            },
          },
        },
      ]),
      user('yes'),
      agent([
        {
          functionResponse: {
            id: 'gate_1',
            name: GATE,
            response: {confirmed: true},
          },
        },
      ]),
    ]);

    const last = messages[messages.length - 1];
    expect(last?.error).toBeUndefined();
  });

  it('records a model error on the assistant message', () => {
    const errorEvent = createEvent({
      author: 'marimo',
      errorMessage: 'rate limited',
    }) as AdkEvent;

    const messages = projectTranscript([user('hi'), errorEvent]);
    expect(messages[1]?.error).toBe('rate limited');
  });

  it('keeps reasoning separate from the answer text', () => {
    const messages = projectTranscript([
      user('why is the sky blue?'),
      agent([
        {text: 'Rayleigh scattering, most likely.', thought: true},
        {text: 'Because air scatters short wavelengths more.'},
      ]),
    ]);

    expect(messages[1]?.text).toBe(
      'Because air scatters short wavelengths more.',
    );
    expect(messages[1]?.reasoning).toBe('Rayleigh scattering, most likely.');
  });

  it('accumulates reasoning across a multi-step turn', () => {
    const messages = projectTranscript([
      user('do it'),
      agent([
        {text: 'First I need the time.', thought: true},
        {functionCall: {id: 'call_1', name: 'current_time', args: {}}},
      ]),
      agent([
        {text: 'Now I can answer.', thought: true},
        {text: 'It is noon.'},
      ]),
    ]);

    expect(messages[1]?.reasoning).toBe(
      'First I need the time.Now I can answer.',
    );
    expect(messages[1]?.text).toBe('It is noon.');
    expect(messages[1]?.toolCalls).toHaveLength(1);
  });
});

/*
 * A helper runs in the parent's conversation — it has to, because that is where
 * its approval requests have to be visible — so without attribution its words and
 * the agent's own would merge into one bubble and read as a single answer from a
 * single mind. The user would have no way to tell which of them said the thing
 * they are looking at.
 */
describe('a helper agent in the conversation', () => {
  it('is labelled, and the agent is not', () => {
    const messages = projectTranscript([
      user('look into it'),
      helper('researcher', [{text: 'I read the logs.'}]),
    ]);

    expect(messages[1]?.subagent).toBe('researcher');
    expect(messages[1]?.text).toBe('I read the logs.');
  });

  it('does not label the main agent', () => {
    const messages = projectTranscript([user('hi'), agent([{text: 'hello'}])]);
    expect(messages[1]?.subagent).toBeUndefined();
  });

  /*
   * The bubble breaks when the speaker changes. Two agents in one bubble is the
   * failure this exists to prevent, and it is worse when the switch is invisible:
   * the agent's summary reads as the helper's finding.
   */
  it('starts a new bubble when a helper takes over', () => {
    const messages = projectTranscript([
      user('look into it'),
      agent([{text: 'Let me delegate. '}]),
      helper('researcher', [{text: 'Here is what I found.'}]),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({text: 'Let me delegate. '});
    expect(messages[1]?.subagent).toBeUndefined();
    expect(messages[2]).toMatchObject({
      subagent: 'researcher',
      text: 'Here is what I found.',
    });
  });

  it('starts a new bubble when the agent takes the conversation back', () => {
    const messages = projectTranscript([
      user('look into it'),
      helper('researcher', [{text: 'Found three problems.'}]),
      agent([{text: 'So: three problems.'}]),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1]?.subagent).toBe('researcher');
    expect(messages[2]?.subagent).toBeUndefined();
    expect(messages[2]?.text).toBe('So: three problems.');
  });

  it('keeps two different helpers apart', () => {
    const messages = projectTranscript([
      user('do both'),
      helper('researcher', [{text: 'from research'}]),
      helper('summariser', [{text: 'from summarising'}]),
    ]);

    expect(messages.map((message) => message.subagent)).toEqual([
      undefined,
      'researcher',
      'summariser',
    ]);
  });

  it('keeps consecutive events from one helper in one bubble', () => {
    const messages = projectTranscript([
      user('look into it'),
      helper('researcher', [{text: 'first '}]),
      helper('researcher', [{text: 'second'}]),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.text).toBe('first second');
  });

  /*
   * The agent's voice resumes with the *next* user message, and what a helper
   * said before it must not be glued onto the answer that follows.
   */
  it('does not carry a helper across the next question', () => {
    const messages = projectTranscript([
      user('first'),
      helper('researcher', [{text: 'a finding'}]),
      user('second'),
      agent([{text: 'a fresh answer'}]),
    ]);

    expect(messages.map((message) => message.subagent)).toEqual([
      undefined,
      'researcher',
      undefined,
      undefined,
    ]);
    expect(messages[3]?.text).toBe('a fresh answer');
    expect(messages[3]?.text).not.toContain('a finding');
  });
});
