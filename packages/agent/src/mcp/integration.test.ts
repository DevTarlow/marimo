/**
 * MCP tools inside the real tool catalogue.
 *
 * The unit tests prove the client talks to a server and the wrapper names and
 * gates what it finds. This proves the last mile, which is the one that
 * actually decides whether a server is usable: that an MCP server's own JSON
 * Schema survives `FunctionTool` and the OpenAI mapping and arrives at the model
 * as something the endpoint will accept.
 *
 * That chain has four conversions in it and no test at any single link would
 * catch a break between them.
 */
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import type {McpServer} from '@marimo/protocol';

import type {AgentConfig} from '../config.js';
import {MemoryStore} from '../memory/index.js';
import {toOpenAiTools} from '../models/openai-mapping.js';
import {createTools} from '../tools/index.js';
import {McpServerConnection} from './client.js';
import {buildMcpTools, McpToolNameError} from './tools.js';

const FIXTURE = fileURLToPath(
  new URL('../../test-fixtures/echo-mcp-server.mjs', import.meta.url),
);

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:1',
    model: 'deepseek-chat',
    temperature: 0,
    systemPrompt: 'test',
    workspaceRoot: process.cwd(),
    allowPrivateNetworkFetch: false,
    ...overrides,
  };
}

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp:fixture',
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    enabled: true,
    trusted: false,
    ...overrides,
  };
}

/** Everything `createTools` needs for the tools that do not need a service. */
function baseDeps() {
  return {
    memory: new MemoryStore({workspaceRoot: process.cwd()}),
    model: 'deepseek-chat',
  };
}

describe('the catalogue with an MCP server attached', () => {
  it('offers the server tools alongside the built-in ones', async () => {
    const connection = new McpServerConnection({server: server()});
    await connection.connect();
    try {
      const tools = createTools(config(), {
        ...baseDeps(),
        mcpServers: [
          {server: server(), connection, tools: await connection.listTools()},
        ],
      });

      const names = tools.map((tool) => tool.name);
      expect(names).toContain('read_file');
      expect(names).toContain('mcp_fixture_echo');
      expect(names).toContain('mcp_fixture_weird_name_with_chars');
    } finally {
      await connection.close();
    }
  });

  /*
   * A server's own `enabled` flag is its switch, so there is no per-tool
   * checkbox and nothing for the profile's list to filter. A profile that lists
   * the tools it wants should not have to relist a server's tools every time the
   * server adds one.
   */
  it('is not filtered by the profile tool list', async () => {
    const connection = new McpServerConnection({server: server()});
    await connection.connect();
    try {
      const tools = createTools(
        config({enabledTools: ['current_time']}),
        {
          ...baseDeps(),
          mcpServers: [
            {server: server(), connection, tools: await connection.listTools()},
          ],
        },
      );

      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(['current_time', 'mcp_fixture_echo']),
      );
      expect(names).not.toContain('read_file');
    } finally {
      await connection.close();
    }
  });

  /*
   * The prefix is what makes collisions rare rather than constant: a server's
   * `time` and this app's `current_time` would otherwise both want short,
   * obvious names. This is the case that works, and the next test is the one
   * that does not.
   */
  it('keeps a built-in name free by prefixing the server one', () => {
    const tools = buildMcpTools({
      server: server({name: 'current'}),
      connection: {} as never,
      tools: [{name: 'time', description: '', inputSchema: {}}],
      reserved: new Set(['current_time']),
    });
    expect(tools[0]?.name).toBe('mcp_current_time');
  });

  it('throws when a name genuinely collides', () => {
    expect(() =>
      buildMcpTools({
        server: server({name: 'notes'}),
        connection: {} as never,
        tools: [{name: 'search', description: '', inputSchema: {}}],
        reserved: new Set(['mcp_notes_search']),
      }),
    ).toThrow(McpToolNameError);
  });
});

describe('an MCP schema on the way to the model', () => {
  it('arrives as JSON Schema the endpoint will accept', async () => {
    const connection = new McpServerConnection({server: server()});
    await connection.connect();
    try {
      const tools = createTools(config(), {
        ...baseDeps(),
        mcpServers: [
          {server: server(), connection, tools: await connection.listTools()},
        ],
      });

      const declarations = tools
        .map((tool) => tool._getDeclaration())
        .filter((entry) => entry !== undefined);
      const wire = toOpenAiTools(declarations);
      const weird = wire.find(
        (entry) => entry.function.name === 'mcp_fixture_weird_name_with_chars',
      );

      expect(weird).toBeDefined();

      /*
       * The fixture's schema is deliberately full of things the endpoints
       * refuse. Each assertion below is one of them having been dealt with
       * rather than passed along — a request carrying any of these fails as a
       * whole, so "it mostly worked" is not a state that exists.
       */
      const parameters = weird?.function.parameters as Record<string, unknown>;
      expect(parameters).toBeDefined();
      expect(parameters['type']).toBe('object');
      expect(parameters).not.toHaveProperty('$schema');
      expect(parameters).not.toHaveProperty('additionalProperties');

      const properties = parameters['properties'] as Record<string, any>;
      // The union `['string','null']` collapsed to one lower-case type.
      expect(properties['mode']?.type).toBe('string');
      // The invented format was dropped, the real one kept.
      expect(properties['stamp']?.format).toBe('date-time');
      expect(properties['weird']).not.toHaveProperty('format');
      // Nested schemas went through the same treatment.
      expect(properties['nested']?.properties?.depth?.type).toBe('integer');
      expect(properties['tags']?.items?.type).toBe('string');
    } finally {
      await connection.close();
    }
  });

  it('names every tool the way the endpoint requires', async () => {
    const connection = new McpServerConnection({server: server()});
    await connection.connect();
    try {
      const tools = createTools(config(), {
        ...baseDeps(),
        mcpServers: [
          {server: server(), connection, tools: await connection.listTools()},
        ],
      });

      const wire = toOpenAiTools(
        tools.map((tool) => tool._getDeclaration()).filter((e) => e !== undefined),
      );

      // The endpoint's rule: letters, digits, underscore and dash, up to 64.
      for (const entry of wire) {
        expect(entry.function.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      }
    } finally {
      await connection.close();
    }
  });
});
