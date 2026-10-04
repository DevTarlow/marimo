/**
 * One MCP server, connected.
 *
 * This is a hand-rolled connection rather than ADK's `MCPToolset`, and the
 * reasons are worth writing down because the choice looks like duplication:
 *
 * - **ADK's `MCPTool` cannot be gated.** It extends `BaseTool`, whose options are
 *   only `{name, description, isLongRunning}` — `requireConfirmation` lives on
 *   `FunctionTool`. An MCP server's tools are the ones most in need of an
 *   approval gate, since they are software the user did not write, so a tool
 *   layer that cannot gate them is the wrong foundation.
 * - **`toGeminiSchema` is not exported**, so there is no supported way to reuse
 *   ADK's schema conversion anyway.
 * - **The SDK is not a dependency of ADK.** `@modelcontextprotocol/sdk` is
 *   imported by ADK's MCP module but is not in its dependency list, so as
 *   installed that path cannot resolve at all.
 *
 * What is used is the official SDK, which is where the protocol belongs.
 *
 * Two security properties come from the SDK and are worth knowing rather than
 * rediscovering:
 *
 * - A **stdio server inherits a safe allowlist** of the environment (`HOME`,
 *   `PATH`, `USER`, and a few more), not the app's whole environment. An API key
 *   exported in the user's shell does not leak into a third-party server as a
 *   side effect of starting it; anything the server needs, the config names.
 * - **Nothing is sent until the user asks for a tool call.** Discovery is
 *   `initialize` plus `tools/list`, both of which the protocol defines as
 *   read-only.
 */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {McpServer} from '@marimo/protocol';

/** How long a server has to answer a handshake or a tool list. */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * How long one tool call may take.
 *
 * Generous, because an MCP tool may be doing real work — cloning a repository,
 * querying a database — and a short timeout would turn "slow" into "broken" at
 * the worst moment. Two minutes is the ceiling on how long a turn can appear to
 * hang, which is the thing being traded against.
 */
const CALL_TIMEOUT_MS = 120_000;

/** How much of a tool's result is kept. */
const MAX_RESULT_CHARS = 20_000;

/** How long a server's own description may be, before the model sees it. */
const MAX_DESCRIPTION_CHARS = 1_024;

/**
 * What went wrong, in the three flavours a user can act on differently.
 *
 * `config` is a typo in the command or URL; `off` is a server that was working
 * and is not; `error` is the server answering with a refusal. Collapsing them
 * into one message is how "check your spelling" and "it crashed" become the same
 * sentence.
 */
export type McpErrorKind = 'config' | 'off' | 'error';

export class McpError extends Error {
  constructor(
    message: string,
    readonly kind: McpErrorKind = 'error',
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** A tool as the server describes it. */
export interface McpToolInfo {
  /** The name the *server* calls it — what a call has to use. */
  name: string;
  description: string;
  /** Its JSON Schema, sanitised for the model's API. */
  inputSchema: Record<string, unknown>;
}

/** Values for the names the server declared, resolved from the secret store. */
export interface McpResolvedSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface McpConnectionOptions {
  server: McpServer;
  /** Supplied by the app; never read from disk here. */
  secrets?: McpResolvedSecrets;
  /** How this app introduces itself during `initialize`. */
  clientName?: string;
  clientVersion?: string;
}

export class McpServerConnection {
  private client: Client | undefined;
  private transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | undefined;
  /** The server's own name for itself, from `initialize`. */
  private serverName = '';
  private instructions = '';

  constructor(private readonly options: McpConnectionOptions) {}

  /** The name the server reported, once connected. */
  reportedName(): string {
    return this.serverName;
  }

  /** The server's own note to the model, if it sent one. */
  serverInstructions(): string {
    return this.instructions;
  }

  isConnected(): boolean {
    return this.client !== undefined;
  }

  /**
   * Starts the server and completes the handshake.
   *
   * Idempotent in the sense that matters: a second call on a live connection is
   * a no-op rather than a second server process, because the manager reconnects
   * on a timer and would otherwise leak one process per tick.
   */
  async connect(): Promise<void> {
    if (this.client !== undefined) {
      return;
    }

    const client = new Client(
      {
        name: this.options.clientName ?? 'marimo-agent',
        version: this.options.clientVersion ?? '0.1.0',
      },
      {capabilities: {}},
    );

    const transport = this.buildTransport();

    try {
      await client.connect(transport, {timeout: HANDSHAKE_TIMEOUT_MS});
    } catch (error) {
      /*
       * A failed handshake leaves a spawned process behind if the transport got
       * as far as starting one. Closing here rather than in the caller is what
       * keeps a misconfigured server from accumulating.
       */
      await this.closeQuietly(client, transport);
      throw asMcpError(error);
    }

    this.client = client;
    this.transport = transport;

    const version = client.getServerVersion();
    this.serverName = version?.name ?? '';
    this.instructions = (client.getInstructions() ?? '').slice(
      0,
      MAX_DESCRIPTION_CHARS,
    );
  }

  /**
   * Every tool the server offers, following pagination to the end.
   *
   * The cursor is why this is a loop rather than one call: a server with more
   * tools than fit in one page answers with a `nextCursor`, and a client that
   * ignores it sees a subset and reports it as the whole list. The bound is
   * there so a server that always answers with a cursor cannot spin forever.
   */
  async listTools(): Promise<McpToolInfo[]> {
    const client = this.requireClient();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page: {
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: unknown;
        }>;
        nextCursor?: string;
      } = await client.listTools(cursor === undefined ? {} : {cursor}, {
        timeout: HANDSHAKE_TIMEOUT_MS,
      });

      for (const tool of page.tools) {
        if (typeof tool.name !== 'string' || tool.name.length === 0) {
          continue;
        }
        tools.push({
          name: tool.name,
          description: (tool.description ?? '').slice(
            0,
            MAX_DESCRIPTION_CHARS,
          ),
          inputSchema: sanitiseSchema(tool.inputSchema),
        });
      }

      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && cursor !== '' && pages < 50);

    return tools;
  }

  /**
   * Runs one tool and returns what the model should read.
   *
   * Always a string, always the server's own words wherever possible — the same
   * rule the rest of the tools follow, so the model cannot tell which tools are
   * local by the shape of the answer.
   */
  async callTool(name: string, args: unknown): Promise<string> {
    const client = this.requireClient();

    let result: unknown;
    try {
      result = await client.callTool(
        {
          name,
          arguments: isRecord(args) ? args : {},
        },
        undefined,
        {timeout: CALL_TIMEOUT_MS},
      );
    } catch (error) {
      throw asMcpError(error);
    }

    return renderResult(result);
  }

  /** Stops the server. Safe to call more than once, and after a failed connect. */
  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.serverName = '';
    this.instructions = '';
    await this.closeQuietly(client, transport);
  }

  private buildTransport(): StdioClientTransport | StreamableHTTPClientTransport {
    const {server, secrets} = this.options;

    if (server.transport === 'stdio') {
      if (server.command === undefined || server.command.length === 0) {
        throw new McpError('This server has no command to run.', 'config');
      }
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        /*
         * Config values first, secrets second: a secret named the same as a
         * plain value is the more specific intention, and the config file is the
         * one that can be read by anyone.
         */
        env: {
          ...(server.env ?? {}),
          ...(secrets?.env ?? {}),
        },
        // Piped rather than inherited, so the manager can quote a server's last
        // words when it dies instead of having them land in the app's own log.
        stderr: 'pipe',
      });
    }

    if (server.url === undefined || server.url.length === 0) {
      throw new McpError('This server has no URL.', 'config');
    }

    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: {
          ...(server.headers ?? {}),
          ...(secrets?.headers ?? {}),
        },
      },
    });
  }

  private requireClient(): Client {
    if (this.client === undefined) {
      throw new McpError(
        `The server "${this.options.server.name}" is not connected.`,
        'off',
      );
    }
    return this.client;
  }

  private async closeQuietly(
    client: Client | undefined,
    transport: StdioClientTransport | StreamableHTTPClientTransport | undefined,
  ): Promise<void> {
    /*
     * Both are attempted and neither is allowed to throw: this runs on the
     * failure path too, where the connection is already broken and a second
     * error would replace the one that explains what happened.
     */
    try {
      await client?.close();
    } catch {
      // Already gone.
    }
    try {
      await transport?.close();
    } catch {
      // Already gone.
    }
  }
}

/**
 * A JSON Schema the model's API will accept, and the one place that is decided.
 *
 * MCP servers describe their arguments with whatever JSON Schema they like, and
 * the dialect is wider than the OpenAI-compatible endpoints accept: `$schema`,
 * `additionalProperties`, `$ref` and union `type` arrays are all rejected
 * outright, and a rejection is not a warning — it fails the whole turn, with a
 * message that names the offending tool and nothing about why.
 *
 * So this narrows rather than passes through, and what it cannot express it
 * drops. The cost is a slightly less precise description; the alternative is a
 * server that cannot be used at all.
 */
export function sanitiseSchema(input: unknown): Record<string, unknown> {
  const node = sanitiseNode(input);

  /*
   * The top level is always an object, whatever the server declared.
   *
   * This is not tidiness. These schemas describe a tool's *arguments*, and
   * arguments are always named — there is no way to call `f(1, 2)` through the
   * function-calling API. A server that describes its input as, say,
   * `{type: 'array'}` is describing the shape of one conceptual value it would
   * like, and an endpoint handed an array-typed parameter object refuses the
   * request outright.
   *
   * When the declared shape is not an object, the rest of its keywords describe
   * something arguments cannot be (`items` on an object is meaningless), so the
   * schema is replaced rather than patched. The description is kept: it is the
   * one part that still tells the model what the tool wants, and for a tool
   * being called with no arguments it is the only useful thing left.
   */
  if (node['type'] !== 'object') {
    const description = node['description'];
    return {
      type: 'object',
      properties: {},
      ...(typeof description === 'string' ? {description} : {}),
    };
  }

  if (node['properties'] === undefined) {
    node['properties'] = {};
  }

  return node;
}

/** Keys Gemini and OpenAI-compatible validators both refuse, dropped everywhere. */
const DROPPED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'unevaluatedProperties',
  'patternProperties',
  'examples',
  'title',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

/** The numeric constraints both dialects spell the same way. */
const NUMERIC_KEYS = new Set([
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'multipleOf',
]);

function sanitiseNode(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    return {type: 'object', properties: {}};
  }

  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (DROPPED_KEYS.has(key) || value === undefined || value === null) {
      continue;
    }

    if (key === 'type') {
      output['type'] = pickType(value);
      continue;
    }

    if (key === 'description') {
      if (typeof value === 'string') {
        output['description'] = value.slice(0, MAX_DESCRIPTION_CHARS);
      }
      continue;
    }

    if (key === 'default') {
      // A default is only useful if the endpoint accepts its type, and a
      // schema's default is the one value nothing validates first.
      if (isJsonScalar(value)) {
        output['default'] = value;
      }
      continue;
    }

    if (key === 'enum') {
      if (Array.isArray(value)) {
        const allowed = value.filter(isJsonScalar).map((entry) => String(entry));
        if (allowed.length > 0) {
          output['enum'] = allowed;
        }
      }
      continue;
    }

    if (key === 'properties' && isRecord(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(value)) {
        properties[name] = sanitiseNode(schema);
      }
      output['properties'] = properties;
      continue;
    }

    if (key === 'items') {
      output['items'] = sanitiseNode(value);
      continue;
    }

    if (key === 'required') {
      if (Array.isArray(value)) {
        const names = value.filter(
          (entry): entry is string => typeof entry === 'string',
        );
        if (names.length > 0) {
          output['required'] = names;
        }
      }
      continue;
    }

    if (key === 'anyOf' || key === 'oneOf') {
      if (Array.isArray(value)) {
        const branches = value
          .filter(isRecord)
          .map((entry) => sanitiseNode(entry));
        if (branches.length > 0) {
          /*
           * `oneOf` becomes `anyOf`. They are not the same thing — `oneOf`
           * requires exactly one branch to match — but neither endpoint
           * understands the difference, and refusing to accept a schema is worse
           * than accepting a slightly looser one.
           */
          output['anyOf'] = branches;
        }
      }
      continue;
    }

    if (key === 'format') {
      // A format the endpoint does not know is rejected, so only the ones it
      // does are kept; `date-time` and `email` are the two worth having.
      if (value === 'date-time' || value === 'email' || value === 'uuid') {
        output['format'] = value;
      }
      continue;
    }

    if (NUMERIC_KEYS.has(key)) {
      const numeric = toFiniteNumber(value);
      if (numeric !== undefined) {
        output[key] = numeric;
      }
      continue;
    }
  }

  return output;
}

/**
 * One type name, from a string or a union.
 *
 * A union like `["string", "null"]` is legal JSON Schema and rejected by the
 * endpoints, so the first non-null branch is taken — which is the meaningful
 * one, since these schemas use a union with null to mean "optional", and
 * optionality is already expressed by leaving the property out of `required`.
 */
function pickType(value: unknown): string {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  if (Array.isArray(value)) {
    const first = value.find((entry) => entry !== 'null');
    if (typeof first === 'string') {
      return first.toLowerCase();
    }
  }
  return 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * An MCP tool result as text.
 *
 * MCP answers with a list of content blocks, which is a shape the model's API
 * has no room for. Everything is flattened into one string, and nothing is
 * silently dropped: an image becomes a note that there was one, because a tool
 * that returns only an image and says nothing would look like a tool that
 * returned nothing.
 */
export function renderResult(result: unknown): string {
  if (!isRecord(result)) {
    return stringify(result);
  }

  const blocks = Array.isArray(result['content']) ? result['content'] : [];
  const parts: string[] = [];

  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    const type = block['type'];

    if (type === 'text') {
      const text = block['text'];
      if (typeof text === 'string') {
        parts.push(text);
      }
      continue;
    }

    if (type === 'image' || type === 'audio') {
      const mime = typeof block['mimeType'] === 'string' ? block['mimeType'] : 'unknown type';
      parts.push(`[${type}: ${mime}]`);
      continue;
    }

    if (type === 'resource') {
      const resource = block['resource'];
      if (isRecord(resource)) {
        const text = resource['text'];
        const uri = resource['uri'];
        if (typeof text === 'string') {
          parts.push(text);
        } else if (typeof uri === 'string') {
          parts.push(`[resource: ${uri}]`);
        } else {
          parts.push('[resource]');
        }
      }
      continue;
    }

    // A block type from a future protocol revision: say so rather than nothing.
    parts.push(`[${String(type)} content]`);
  }

  /*
   * `structuredContent` is the machine-readable half of a result. It is appended
   * rather than preferred: the text blocks are what the server wrote for a
   * reader, and the structured copy is often the same information.
   */
  const structured = result['structuredContent'];
  if (parts.length === 0 && structured !== undefined) {
    parts.push(stringify(structured));
  }

  const joined = parts.length > 0 ? parts.join('\n') : '(the server returned nothing)';
  const clipped =
    joined.length > MAX_RESULT_CHARS
      ? `${joined.slice(0, MAX_RESULT_CHARS)}\n... [truncated: the server returned more than ${MAX_RESULT_CHARS} characters]`
      : joined;

  /*
   * An error result is still a result. It is prefixed so the model can tell a
   * refusal from an answer — the same in-band convention the other tools use,
   * since a thrown error would end the turn rather than let it adapt.
   */
  return result['isError'] === true
    ? `The server reported an error: ${clipped}`
    : clipped;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Turns anything thrown by the SDK into something with a kind and a sentence. */
function asMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  /*
   * A spawn that cannot find its command is a configuration mistake and reads
   * like one; everything else is the server misbehaving. The distinction is
   * worth keeping because the fix is different — edit the command, or look at
   * the server — and the message is the only place the user learns which.
   */
  const config =
    /ENOENT|not found|no such file|cannot find|spawn .* EACCES/iu.test(message);

  return new McpError(
    config
      ? `Could not start the server: ${message}`
      : `The server did not answer: ${message}`,
    config ? 'config' : 'error',
  );
}
