#!/usr/bin/env node
/**
 * A minimal MCP server, for testing the client against a real one.
 *
 * Spawned as a child process over stdio by `client.test.ts`, so the test
 * exercises the actual protocol — the real handshake, real JSON-RPC framing,
 * real pagination — rather than a mock that agrees with whatever the client
 * happens to do. A mock cannot catch a client that ignores `nextCursor` or
 * mishandles an `isError` result; this can, and does.
 *
 * Its tools are chosen to be awkward on purpose:
 *
 * - `echo` — the ordinary case.
 * - `explode` — answers with `isError`, which is a *result*, not a failure.
 * - `weird name/with:chars` — a name that has to be folded to be usable.
 * - `huge` — more text than the client keeps, so truncation is exercised.
 * - `image_only` — content with no text at all, where a client that only reads
 *   text blocks would report an empty result instead of saying there was an
 *   image.
 *
 * `tools/list` is served in two pages, always, so a client that ignores the
 * cursor sees half the tools and no error.
 */
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const FIRST_PAGE = [
  {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: {
      type: 'object',
      properties: {text: {type: 'string', description: 'What to echo.'}},
      required: ['text'],
    },
  },
  {
    name: 'explode',
    description: 'Always answers with an error result.',
    inputSchema: {type: 'object', properties: {}},
  },
];

const SECOND_PAGE = [
  {
    name: 'weird name/with:chars',
    description: 'A name that needs folding to be a legal tool name.',
    // Deliberately full of the things a real server sends and the endpoints
    // reject: a union type, `$schema`, `additionalProperties`, an unknown format.
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {type: ['string', 'null'], enum: ['fast', 'slow']},
        nested: {
          type: 'object',
          properties: {depth: {type: 'integer', minimum: 1}},
        },
        tags: {type: 'array', items: {type: 'string'}},
        stamp: {type: 'string', format: 'date-time'},
        weird: {type: 'string', format: 'not-a-real-format'},
      },
      required: ['mode', 'nonexistent'],
    },
  },
  {
    name: 'huge',
    description: 'Returns more text than the client keeps.',
    inputSchema: {type: 'object', properties: {}},
  },
  {
    name: 'image_only',
    description: 'Returns only an image.',
    inputSchema: {type: 'object', properties: {}},
  },
];

const server = new Server(
  {name: 'marimo-fixture', version: '1.0.0'},
  {capabilities: {tools: {}}, instructions: 'A fixture server.'},
);

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  if (cursor === undefined) {
    return {tools: FIRST_PAGE, nextCursor: 'page-two'};
  }
  return {tools: SECOND_PAGE};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const {name, arguments: args} = request.params;

  if (name === 'echo') {
    return {content: [{type: 'text', text: `echo: ${String(args?.text ?? '')}`}]};
  }

  if (name === 'explode') {
    return {
      content: [{type: 'text', text: 'the server refused'}],
      isError: true,
    };
  }

  if (name === 'huge') {
    return {content: [{type: 'text', text: 'x'.repeat(50_000)}]};
  }

  if (name === 'image_only') {
    return {
      content: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}],
    };
  }

  return {content: [{type: 'text', text: `folded ok: ${name}`}]};
});

await server.connect(new StdioServerTransport());
