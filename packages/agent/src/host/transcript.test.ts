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
