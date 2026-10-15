/**
 * The MCP client against a real server, over a real pipe.
 *
 * Everything here spawns `test-fixtures/echo-mcp-server.mjs` as a child process
 * and speaks the actual protocol to it. That is slower than a mock and it is the
 * point: a mock cannot catch a client that ignores `nextCursor`, mishandles an
 * `isError` result, or forgets to kill the process it started — and all three of
 * those are silent failures against a mock that agrees with whatever the client
 * does.
 */
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import type {McpServer} from '@marimo/protocol';

import {McpError, McpServerConnection} from './client.js';
import {buildMcpTools} from './tools.js';

const FIXTURE = fileURLToPath(
  new URL('../../test-fixtures/echo-mcp-server.mjs', import.meta.url),
);

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp:fixture',
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    enabled: true,
    secretStorage: 'keychain',
    trusted: false,
    ...overrides,
  };
}

/** Runs `body` with a connection, and always closes it. */
async function withConnection<T>(
  config: McpServer,
  body: (connection: McpServerConnection) => Promise<T>,
): Promise<T> {
  const connection = new McpServerConnection({server: config});
  await connection.connect();
  try {
    return await body(connection);
  } finally {
    await connection.close();
  }
}

describe('McpServerConnection', () => {
  it('connects, shakes hands, and reports the server name', async () => {
    await withConnection(server(), async (connection) => {
      expect(connection.isConnected()).toBe(true);
      expect(connection.reportedName()).toBe('marimo-fixture');
      // `instructions` is the server's own note about itself.
      expect(connection.serverInstructions()).toBe('A fixture server.');
    });
  });

  /*
   * The pagination case. The fixture always serves its tools in two pages, so a
   * client that stops at the first page sees two tools and reports success —
   * which is exactly the bug worth a real server to catch.
   */
  it('follows the cursor and returns every page of tools', async () => {
    await withConnection(server(), async (connection) => {
      const tools = await connection.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'echo',
        'explode',
        'huge',
        'image_only',
        'weird name/with:chars',
      ]);
    });
  });

  it('sanitises the schema on the way in', async () => {
    await withConnection(server(), async (connection) => {
      const tools = await connection.listTools();
      const weird = tools.find((tool) => tool.name === 'weird name/with:chars');

      // The fixture's schema carries a union type, `$schema` and
      // `additionalProperties`, all of which the endpoint refuses.
      expect(weird?.inputSchema).not.toHaveProperty('$schema');
      expect(weird?.inputSchema).not.toHaveProperty('additionalProperties');
      const properties = weird?.inputSchema['properties'] as Record<string, any>;
      expect(properties['mode']?.type).toBe('string');
      // `nonexistent` is required but not a property; the fixture is checking
      // that this does not stop the tool from being usable.
      expect(weird?.inputSchema['required']).toEqual(['mode', 'nonexistent']);
    });
  });

  it('runs a tool and returns its text', async () => {
    await withConnection(server(), async (connection) => {
      await expect(connection.callTool('echo', {text: 'hello'})).resolves.toBe(
        'echo: hello',
      );
    });
  });

  it('calls a tool by the name the server knows, not the folded one', async () => {
    // The client maps `weird name/with:chars` to a legal tool name for the
    // model, but the call itself has to use the server's own name or the server
    // will not recognise it.
    await withConnection(server(), async (connection) => {
      const result = await connection.callTool('weird name/with:chars', {});
      expect(result).toContain('weird name/with:chars');
    });
  });

  it('marks an error result instead of throwing it', async () => {
    await withConnection(server(), async (connection) => {
      const result = await connection.callTool('explode', {});
      expect(result).toMatch(/reported an error/iu);
      expect(result).toContain('the server refused');
    });
  });

  it('truncates a huge result and says that it did', async () => {
    await withConnection(server(), async (connection) => {
      const result = await connection.callTool('huge', {});
      expect(result.length).toBeLessThan(50_000);
      expect(result).toMatch(/\[truncated/u);
    });
  });

  it('describes an image-only result rather than reporting nothing', async () => {
    await withConnection(server(), async (connection) => {
      await expect(connection.callTool('image_only', {})).resolves.toBe(
        '[image: image/png]',
      );
    });
  });

  it('refuses to call a tool once it is closed', async () => {
    const connection = new McpServerConnection({server: server()});
    await connection.connect();
    await connection.close();

    expect(connection.isConnected()).toBe(false);
    await expect(connection.callTool('echo', {text: 'x'})).rejects.toThrow(
      McpError,
    );
  });

  it('can be closed twice without complaining', async () => {
    const connection = new McpServerConnection({server: server()});
    await connection.connect();
    await connection.close();
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it('treats a second connect as a no-op rather than a second server', async () => {
    // The manager reconnects on a timer; without this it would leak one child
    // process per tick.
    const connection = new McpServerConnection({server: server()});
    await connection.connect();
    await connection.connect();
    try {
      expect(connection.isConnected()).toBe(true);
      await expect(connection.callTool('echo', {text: 'once'})).resolves.toBe(
        'echo: once',
      );
    } finally {
      await connection.close();
    }
  });
});

describe('a server that cannot be started', () => {
  it('reports a configuration problem rather than a crash', async () => {
    // The distinction matters because the fix is different — edit the command,
    // or go and look at the server — and this message is the only place the user
    // finds out which.
    const connection = new McpServerConnection({
      server: server({
        command: '/nonexistent/definitely-not-a-real-binary',
        args: [],
      }),
    });

    await expect(connection.connect()).rejects.toMatchObject({kind: 'config'});
  });

  it('leaves nothing connected after a failed start', async () => {
    const connection = new McpServerConnection({
      server: server({command: '/nonexistent/nope', args: []}),
    });

    await expect(connection.connect()).rejects.toThrow();
    expect(connection.isConnected()).toBe(false);
  });

  it('refuses a stdio server with no command', async () => {
    const connection = new McpServerConnection({
      server: server({command: undefined}),
    });
    await expect(connection.connect()).rejects.toMatchObject({kind: 'config'});
  });
});

describe('the tools a real server produces', () => {
  it('offers every tool under a namespaced, legal name', async () => {
    await withConnection(server(), async (connection) => {
      const tools = await connection.listTools();
      const built = buildMcpTools({
        server: server(),
        connection,
        tools,
      });

      expect(built.map((entry) => entry.name).sort()).toEqual([
        'mcp_fixture_echo',
        'mcp_fixture_explode',
        'mcp_fixture_huge',
        'mcp_fixture_image_only',
        'mcp_fixture_weird_name_with_chars',
      ]);
      for (const entry of built) {
        expect(entry.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      }
    });
  });

  it('gates every one of them while the server is untrusted', async () => {
    await withConnection(server({trusted: false}), async (connection) => {
      const tools = await connection.listTools();
      const built = buildMcpTools({server: server(), connection, tools});

      for (const entry of built) {
        await expect(entry.checkRequireConfirmation({})).resolves.toBe(true);
      }
    });
  });

  it('runs one end to end through the tool the model would call', async () => {
    await withConnection(server({trusted: true}), async (connection) => {
      const tools = await connection.listTools();
      const built = buildMcpTools({server: server({trusted: true}), connection, tools});
      const echo = built.find((entry) => entry.name === 'mcp_fixture_echo');

      const result = await echo?.runAsync({
        args: {text: 'through the whole stack'},
        toolContext: {} as never,
      });
      expect(result).toBe('echo: through the whole stack');
    });
  });
});
