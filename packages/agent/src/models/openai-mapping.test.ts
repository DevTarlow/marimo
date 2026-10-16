import type {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  normalizeSchema,
  toOpenAiMessages,
  toOpenAiTools,
} from './openai-mapping.js';

const GATE = 'adk_request_confirmation';

function userText(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelText(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function modelCall(id: string, name: string, args: unknown): Content {
  return {
    role: 'model',
    parts: [{functionCall: {id, name, args: args as Record<string, unknown>}}],
  };
}

/** One turn that asks for several calls at once, as a gated round does. */
function modelCalls(
  calls: Array<{id: string; name: string; args: unknown}>,
): Content {
  return {
    role: 'model',
    parts: calls.map((call) => ({
      functionCall: {
        id: call.id,
        name: call.name,
        args: call.args as Record<string, unknown>,
      },
    })),
  };
}

function toolResult(id: string, name: string, value: unknown): Content {
  return {
    role: 'user',
    parts: [{functionResponse: {id, name, response: {result: value}}}],
  };
}

describe('toOpenAiMessages', () => {
  it('maps user and assistant text to their roles', () => {
    const messages = toOpenAiMessages([userText('hi'), modelText('hello')]);
    expect(messages).toEqual([
      {role: 'user', content: 'hi'},
      {role: 'assistant', content: 'hello'},
    ]);
  });

  it('sends tool calls on the assistant message and results as tool messages', () => {
    const messages = toOpenAiMessages([
      userText('list the folder'),
      modelCall('call_1', 'list_dir', {path: '.'}),
      toolResult('call_1', 'list_dir', 'a.txt\nb.txt'),
    ]);

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {name: 'list_dir', arguments: '{"path":"."}'},
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'a.txt\nb.txt',
    });
  });

  it('keeps assistant text alongside tool calls in one message', () => {
    const content: Content = {
      role: 'model',
      parts: [
        {text: 'Checking.'},
        {functionCall: {id: 'c', name: 'current_time', args: {}}},
      ],
    };
    const messages = toOpenAiMessages([
      content,
      toolResult('c', 'current_time', '12:00'),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Checking.');
    expect(messages[0]?.tool_calls).toHaveLength(1);
  });

  it('omits the approval gate call and its response entirely', () => {
    const gateCall: Content = {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'gate_1',
            name: GATE,
            args: {
              originalFunctionCall: {id: 'call_1', name: 'run_shell', args: {}},
            },
          },
        },
      ],
    };
    const gateResponse: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'gate_1',
            name: GATE,
            response: {confirmed: true},
          },
        },
      ],
    };

    const messages = toOpenAiMessages([gateCall, gateResponse]);
    expect(messages).toEqual([]);
  });

  it('drops a tool result whose call id was never issued to the provider', () => {
    // This is the shape of an approval: it answers a gate id, not a tool call
    // the provider ever saw, and OpenAI-compatible APIs reject it.
    const messages = toOpenAiMessages([
      userText('do it'),
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'gate_1',
              name: GATE,
              response: {confirmed: false},
            },
          },
        ],
      },
    ]);
    expect(messages).toEqual([{role: 'user', content: 'do it'}]);
  });

  it('answers the calls a turn left unanswered, where the provider needs them', () => {
    // Two gated calls in one turn, one approval, and the turn resumed with the
    // other call still unanswered: DeepSeek refuses the request, and because the
    // gap is in the session it refuses every later turn of the conversation too.
    const messages = toOpenAiMessages([
      userText('publish it'),
      modelCalls([
        {id: 'call_shell', name: 'run_shell', args: {command: 'ls'}},
        {id: 'call_write', name: 'write_file', args: {path: 'a.md'}},
      ]),
      toolResult('call_shell', 'run_shell', 'done'),
      userText('why did it stop?'),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_shell',
      content: 'done',
    });
    expect(messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_write',
    });
    // Not an empty result: the call did not run, which is a different thing to
    // tell the model.
    expect(messages[3]?.content).toContain('did not run');
    expect(messages[4]).toEqual({role: 'user', content: 'why did it stop?'});
  });

  it('answers a call left over by a turn that stopped before any result', () => {
    const messages = toOpenAiMessages([
      modelCall('call_1', 'run_shell', {command: 'rm -rf build'}),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({role: 'tool', tool_call_id: 'call_1'});
  });

  it('does not answer the same call twice', () => {
    const messages = toOpenAiMessages([
      modelCall('call_1', 'current_time', {}),
      toolResult('call_1', 'current_time', 'noon'),
      toolResult('call_1', 'current_time', 'noon again'),
    ]);

    expect(messages.filter((message) => message.role === 'tool')).toHaveLength(
      1,
    );
  });

  it('tolerates missing ids and malformed arguments', () => {
    const messages = toOpenAiMessages([
      {
        role: 'model',
        parts: [{functionCall: {name: 'current_time', args: {}}}],
      },
      userText('ok'),
    ]);
    expect(messages[0]?.tool_calls?.[0]?.id).toBe('call_0_0');
    expect(messages[0]?.tool_calls?.[0]?.function.arguments).toBe('{}');
  });

  it("sends a turn's reasoning as reasoning_content, not as content", () => {
    const turn: Content = {
      role: 'model',
      parts: [
        {text: 'Let me think about that.', thought: true},
        {text: 'The answer is 4.'},
      ],
    };

    const messages = toOpenAiMessages([userText('2 + 2?'), turn]);

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'The answer is 4.',
      reasoning_content: 'Let me think about that.',
    });
  });

  it('carries reasoning alongside tool calls, which DeepSeek requires', () => {
    const turn: Content = {
      role: 'model',
      parts: [
        {text: 'I need the time first.', thought: true},
        {functionCall: {id: 'call_1', name: 'current_time', args: {}}},
      ],
    };

    const messages = toOpenAiMessages([turn]);
    expect(messages[0]?.content).toBe('');
    expect(messages[0]?.reasoning_content).toBe('I need the time first.');
    expect(messages[0]?.tool_calls).toHaveLength(1);
  });

  it('omits reasoning_content entirely when a turn did not think', () => {
    const messages = toOpenAiMessages([modelText('Just an answer.')]);
    expect(messages[0]).not.toHaveProperty('reasoning_content');
  });

  it('keeps thought parts out of a system instruction', () => {
    const instruction: Content = {
      role: 'user',
      parts: [{text: 'You are Marimo Bot.', thought: true}, {text: 'Be brief.'}],
    };
    const messages = toOpenAiMessages([instruction]);
    expect(messages[0]?.content).toBe('Be brief.');
  });
});

describe('normalizeSchema', () => {
  it('lowercases type names and drops keys OpenAI-compatible APIs reject', () => {
    const schema = normalizeSchema({
      type: 'OBJECT',
      additionalProperties: false,
      properties: {
        path: {type: 'STRING', description: 'a path', nullable: true},
        count: {type: 'INTEGER', format: 'int64'},
      },
      required: ['path'],
      propertyOrdering: ['path'],
    });

    expect(schema).toEqual({
      type: 'object',
      properties: {
        path: {type: 'string', description: 'a path'},
        count: {type: 'integer'},
      },
      required: ['path'],
    });
  });

  it('recurses into items and anyOf, and keeps only supported formats', () => {
    const schema = normalizeSchema({
      type: 'object',
      properties: {
        list: {type: 'ARRAY', items: {type: 'STRING', format: 'date-time'}},
        either: {anyOf: [{type: 'NUMBER'}, {type: 'STRING', format: 'email'}]},
      },
    });

    expect(schema['properties']).toEqual({
      list: {type: 'array', items: {type: 'string', format: 'date-time'}},
      either: {anyOf: [{type: 'number'}, {type: 'string', format: 'email'}]},
    });
  });

  it('collapses a nullable union to its non-null branch', () => {
    const schema = normalizeSchema({
      type: 'object',
      properties: {name: {type: ['string', 'null']}},
    });
    expect((schema['properties'] as Record<string, unknown>)['name']).toEqual({
      type: 'string',
    });
  });

  it('coerces numeric bounds that arrive as strings', () => {
    // ADK's Zod bridge renders `z.string().min(1)` as `minLength: "1"`, and
    // DeepSeek rejects the whole request with `"1" is not of type "integer"`.
    const schema = normalizeSchema({
      type: 'object',
      properties: {
        query: {type: 'STRING', minLength: '1', maxLength: '50'},
        count: {type: 'INTEGER', minimum: '0', maximum: 10},
      },
    });
    expect(schema['properties']).toEqual({
      query: {type: 'string', minLength: 1, maxLength: 50},
      count: {type: 'integer', minimum: 0, maximum: 10},
    });
  });

  it('drops a bound that cannot be a number at all', () => {
    const schema = normalizeSchema({
      type: 'object',
      properties: {
        query: {type: 'STRING', minLength: 'many', maxLength: {}},
      },
    });
    expect((schema['properties'] as Record<string, unknown>)['query']).toEqual({
      type: 'string',
    });
  });

  it('produces a usable empty object schema for missing input', () => {
    expect(normalizeSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('toOpenAiTools', () => {
  it('prefers parametersJsonSchema and falls back to parameters', () => {
    const tools = toOpenAiTools([
      {
        name: 'read_file',
        description: 'Reads a file',
        parametersJsonSchema: {
          type: 'object',
          properties: {path: {type: 'string'}},
        },
      },
      {
        name: 'current_time',
        description: 'Returns the time',
        parameters: {type: 'OBJECT' as never, properties: {}},
      },
    ]);

    expect(tools[0]?.function.parameters).toEqual({
      type: 'object',
      properties: {path: {type: 'string'}},
    });
    expect(tools[1]?.function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('skips declarations with no name and returns nothing for no tools', () => {
    expect(toOpenAiTools(undefined)).toEqual([]);
    expect(toOpenAiTools([{description: 'nameless'}])).toEqual([]);
  });
});
