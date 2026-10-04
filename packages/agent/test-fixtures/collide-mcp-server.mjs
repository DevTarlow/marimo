#!/usr/bin/env node
/**
 * An MCP server whose tools cannot all be offered.
 *
 * Two of its tools fold onto the same name — `read/file` and `read:file` both
 * become `read_file` once the illegal characters are replaced — so a client that
 * accepted them would offer the model two tools it cannot tell apart, and one
 * would silently replace the other for good.
 *
 * It exists so the *manager* can be tested against a genuinely broken server:
 * what matters is not that the collision is detected (the agent package tests
 * that) but that detecting it does not take down the servers beside it. A user
 * with one bad server should still have their other servers.
 */
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

void CallToolRequestSchema;

const server = new Server(
  {name: 'collide-fixture', version: '1.0.0'},
  {capabilities: {tools: {}}},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read/file',
      description: 'Read a file, spelled with a slash.',
      inputSchema: {type: 'object', properties: {}},
    },
    {
      name: 'read:file',
      description: 'Read a file, spelled with a colon.',
      inputSchema: {type: 'object', properties: {}},
    },
  ],
}));

await server.connect(new StdioServerTransport());
