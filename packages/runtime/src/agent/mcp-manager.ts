/**
 * The MCP servers this install has, kept connected.
 *
 * `@marimo/agent` knows how to talk to *one* server: dial it, list what it
 * offers, call a tool. This is the other half — which servers exist, which
 * should be up, what to do when one dies, and where its credentials come from.
 *
 * It is Electron-free and lives here rather than in the app for the same reason
 * `AgentRuntime` does: the window and the headless runner both need it, and the
 * only thing that differs between them is where a secret is read from — which is
 * a callback, not a branch.
 *
 * Three rules shape it:
 *
 * - **One bad server does not break the app.** A name collision, a command that
 *   does not exist, a server that speaks nonsense: each becomes an `error`
 *   status with a sentence in it. Throwing would take down whatever was starting
 *   the others, and the user would see an app that will not open rather than one
 *   server that will not connect.
 * - **A server that is enabled is kept up.** One that dies is retried on a
 *   backoff, not left dead until somebody presses Save — which is what the
 *   version this is extracted from did, and why a crashed server stayed crashed
 *   for days.
 * - **Discovery happens on connect and on demand, never per turn.** Listing a
 *   server's tools is a round trip; doing it before every turn would add its
 *   latency to every message.
 */
import {
  buildMcpTools,
  McpError,
  McpServerConnection,
  McpToolNameError,
} from '@marimo/agent';
import type {McpResolvedSecrets, McpToolInfo, McpToolsetSource} from '@marimo/agent';

import type {McpServer} from '@marimo/protocol';

import type {AppPaths} from '../paths.js';
import {secretFile} from '../paths.js';
import type {FileSecretStore} from '../secrets.js';

/**
 * Where one server's credential lives.
 *
 * Named by server, target and variable rather than by server alone, because a
 * server may need a header *and* an environment variable — and because renaming
 * a variable in the form should not silently reuse the previous value.
 */
export function mcpSecretFile(
  paths: AppPaths,
  serverId: string,
  target: 'env' | 'header',
  name: string,
): string {
  return secretFile(paths, `${serverId}-${target}-${name}`);
}

export type McpConnectionState = 'off' | 'connecting' | 'online' | 'error';

export interface McpStatus {
  state: McpConnectionState;
  /** One sentence, shown under the server's name in Settings. */
  detail: string;
  /** How many tools it offers, once it is up. */
  toolCount: number;
}

/** How many times to retry a failing server before waiting much longer. */
const DEFAULT_RETRY_DELAYS_MS = [
  5_000, 15_000, 60_000, 300_000, 900_000,
] as const;

export interface McpManagerOptions {
  /**
   * Reads the credentials a server declared.
   *
   * Supplied rather than done here because only the caller knows *where* secrets
   * live: the window decrypts through the OS keychain, and the runner reads the
   * plain-text opt-in. This module knows only that a value is needed for a name.
   */
  readSecrets: (server: McpServer) => Promise<McpResolvedSecrets>;
  /** How this app introduces itself during `initialize`. */
  clientName?: string;
  clientVersion?: string;
  /** Told when a server's state changes, so the window can redraw. */
  onStatus?: (serverId: string, status: McpStatus) => void;
  /** The backoff schedule. Injected so a test does not wait five minutes. */
  retryDelaysMs?: readonly number[];
  /** The clock, for the same reason the job store takes one. */
  now?: () => number;
}

/** One server's live state: the connection, what it offers, and its health. */
interface ManagedServer {
  server: McpServer;
  connection: McpServerConnection;
  tools: McpToolInfo[];
  status: McpStatus;
  /** When a retry is allowed. Zero means "now". */
  retryAt: number;
  /** How many consecutive failures, which picks the backoff step. */
  failures: number;
}

export class McpManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly retryDelays: readonly number[];
  private readonly now: () => number;
  private stopped = true;

  constructor(private readonly options: McpManagerOptions) {
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Brings the manager in line with a settings document.
   *
   * Called at launch and again whenever the servers are edited, so this is the
   * one place that decides what should be running. A server that was removed is
   * closed; one that was disabled is closed; one that was added or enabled is
   * dialled.
   */
  async apply(servers: readonly McpServer[]): Promise<void> {
    this.stopped = false;
    const wanted = new Map(servers.map((server) => [server.id, server]));

    // Anything no longer configured, or now switched off, goes away.
    for (const [id, managed] of [...this.servers]) {
      const next = wanted.get(id);
      const keep = next !== undefined && next.enabled;
      if (!keep) {
        await this.closeOne(id);
      } else if (!sameServer(next, managed.server)) {
        // Re-dialled rather than patched: a changed command or URL is a
        // different server, and there is nothing meaningful to reuse.
        await this.closeOne(id);
      }
    }

    // Everything that should be up, and is not, comes up.
    for (const server of servers) {
      if (!server.enabled || this.servers.has(server.id)) {
        continue;
      }
      await this.dial(server);
    }
  }

  /**
   * Reconnects anything enabled that should be up and is not.
   *
   * Separate from `apply` because it is what a timer calls: the configuration
   * has not changed, a server has simply died. A server still inside its backoff
   * is left alone, so a server that is down for an hour is not dialled sixty
   * times a minute.
   */
  async reconcile(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const now = this.now();
    for (const managed of this.servers.values()) {
      if (!managed.server.enabled) {
        continue;
      }
      if (managed.connection.isConnected()) {
        continue;
      }
      if (managed.retryAt > now) {
        continue;
      }
      await this.dial(managed.server);
    }
  }

  /** Closes everything. Called when the app quits. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.servers.keys()]) {
      await this.closeOne(id);
    }
  }

  statusOf(serverId: string): McpStatus {
    return (
      this.servers.get(serverId)?.status ?? {
        state: 'off',
        detail: 'Not connected.',
        toolCount: 0,
      }
    );
  }

  statuses(): Record<string, McpStatus> {
    const out: Record<string, McpStatus> = {};
    for (const [id, managed] of this.servers) {
      out[id] = managed.status;
    }
    return out;
  }

  /**
   * Everything a turn may call, in the shape `createTools` wants.
   *
   * Only connected servers appear. An unreachable server contributes nothing
   * rather than contributing a tool that would fail when called: a model offered
   * a tool it cannot use will use it, and the user gets an error where they
   * expected an answer.
   */
  toolsets(): readonly McpToolsetSource[] {
    const sources: McpToolsetSource[] = [];
    for (const managed of this.servers.values()) {
      if (!managed.connection.isConnected() || managed.tools.length === 0) {
        continue;
      }
      sources.push({
        server: managed.server,
        connection: managed.connection,
        tools: managed.tools,
      });
    }
    return sources;
  }

  /**
   * Dials a server once, without keeping it, and reports what happened.
   *
   * This is the Settings **Test** button. It deliberately does not disturb a
   * live connection: the question is "would this configuration work", and
   * answering it by taking down the working server the user is looking at would
   * make the button dangerous to press.
   */
  async test(server: McpServer): Promise<{ok: boolean; detail: string}> {
    const connection = this.connectionFor(server);
    try {
      await connection.connect();
      const tools = await connection.listTools();
      // Names are checked here too, so a collision is reported by Test rather
      // than discovered at the first turn.
      buildMcpTools({server, connection, tools});
      const name = connection.reportedName();
      return {
        ok: true,
        detail:
          `${name.length > 0 ? name : server.name} offers ${tools.length} ` +
          `tool${tools.length === 1 ? '' : 's'}.`,
      };
    } catch (error) {
      return {ok: false, detail: describe(error)};
    } finally {
      await connection.close();
    }
  }

  /** Re-lists a connected server's tools, for the Refresh button. */
  async refresh(serverId: string): Promise<{
    ok: boolean;
    detail: string;
    tools: string[];
  }> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      return {ok: false, detail: 'That server is not connected.', tools: []};
    }

    try {
      const tools = await managed.connection.listTools();
      buildMcpTools({server: managed.server, connection: managed.connection, tools});
      managed.tools = tools;
      this.setStatus(managed, {
        state: 'online',
        detail: `${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
        toolCount: tools.length,
      });
      return {
        ok: true,
        // The singular case, which the line above it has and this one did not —
        // a server offering one tool reported "1 tools." to whoever pressed
        // Refresh.
        detail: `${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
        tools: tools.map((tool) => tool.name),
      };
    } catch (error) {
      const detail = describe(error);
      this.fail(managed, detail);
      return {ok: false, detail, tools: []};
    }
  }

  /**
   * Dials one server and records what happened.
   *
   * Every failure is caught: this runs inside `apply` and `reconcile`, and an
   * exception escaping here would abandon the servers that had not been reached
   * yet, turning one bad configuration into an app with no MCP at all.
   */
  private async dial(server: McpServer): Promise<void> {
    const existing = this.servers.get(server.id);
    if (existing?.connection.isConnected()) {
      return;
    }

    /*
     * A previous attempt may have left a dead connection behind — a spawned
     * process that has exited, a socket that has closed. Closing it before
     * replacing is what stops a server that fails every retry from accumulating
     * one orphaned child process per attempt.
     */
    if (existing) {
      try {
        await existing.connection.close();
      } catch {
        // Already gone, which is the usual case here.
      }
    }

    const managed: ManagedServer = existing ?? {
      server,
      connection: this.connectionFor(server),
      tools: [],
      status: {state: 'off', detail: 'Not connected.', toolCount: 0},
      retryAt: 0,
      failures: 0,
    };
    managed.server = server;
    this.servers.set(server.id, managed);
    this.setStatus(managed, {
      state: 'connecting',
      detail: 'Connecting…',
      toolCount: managed.status.toolCount,
    });

    try {
      const secrets = await this.options.readSecrets(server);
      const connection = new McpServerConnection({
        server,
        secrets,
        ...(this.options.clientName ? {clientName: this.options.clientName} : {}),
        ...(this.options.clientVersion
          ? {clientVersion: this.options.clientVersion}
          : {}),
      });
      await connection.connect();
      const tools = await connection.listTools();

      /*
       * Checked here rather than left to `createTools`, because this is where a
       * user can still be told. A collision at turn time would be an exception
       * in the middle of a conversation; here it is a sentence under the
       * server's name.
       */
      buildMcpTools({server, connection, tools});

      managed.connection = connection;
      managed.tools = tools;
      managed.failures = 0;
      managed.retryAt = 0;
      this.setStatus(managed, {
        state: 'online',
        detail: `${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
        toolCount: tools.length,
      });
    } catch (error) {
      managed.tools = [];
      this.fail(managed, describe(error));
    }
  }

  /** Records a failure and schedules the next attempt. */
  private fail(managed: ManagedServer, detail: string): void {
    const step = Math.min(managed.failures, this.retryDelays.length - 1);
    const delay = this.retryDelays[step] ?? 0;
    managed.failures += 1;
    managed.retryAt = this.now() + delay;

    this.setStatus(managed, {
      state: 'error',
      // The delay is part of the message on purpose: "it will try again" with no
      // when is the sort of status that makes a user press Refresh forever.
      detail: `${detail} Retrying in ${describeDelay(delay)}.`,
      toolCount: 0,
    });
  }

  private async closeOne(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      return;
    }
    this.servers.delete(serverId);
    try {
      await managed.connection.close();
    } catch {
      // Closing a connection that is already gone is not a problem worth
      // reporting, and it must not stop the others from closing.
    }
    /*
     * Emitted unconditionally rather than through `setStatus`, whose whole job
     * is to swallow an unchanged status. A server switching off *is* a change,
     * and it is the one the window most needs to hear about — suppressing it
     * would leave a server showing as online after it had been turned off.
     */
    this.options.onStatus?.(serverId, {
      state: 'off',
      detail: 'Switched off.',
      toolCount: 0,
    });
  }

  private connectionFor(server: McpServer): McpServerConnection {
    return new McpServerConnection({
      server,
      ...(this.options.clientName ? {clientName: this.options.clientName} : {}),
      ...(this.options.clientVersion
        ? {clientVersion: this.options.clientVersion}
        : {}),
    });
  }

  private setStatus(
    managed: {server: McpServer; status: McpStatus},
    status: McpStatus,
  ): void {
    /*
     * Only on change. A reconnect timer that fires every few seconds and
     * reported "still not connected" each time would have the window redrawing
     * for nothing, and would drown the one message that mattered.
     */
    const before = managed.status;
    if (
      before.state === status.state &&
      before.detail === status.detail &&
      before.toolCount === status.toolCount
    ) {
      return;
    }
    managed.status = status;
    this.options.onStatus?.(managed.server.id, status);
  }
}

/** Whether two configurations would dial the same server the same way. */
function sameServer(a: McpServer, b: McpServer): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describe(error: unknown): string {
  if (error instanceof McpToolNameError) {
    return error.message;
  }
  if (error instanceof McpError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** A delay as a person would say it, because "300000ms" is not a sentence. */
function describeDelay(ms: number): string {
  if (ms < 1_000) {
    return 'a moment';
  }
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) {
    return `${seconds} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/**
 * Reads the credentials a server declared, from the one-file-per-secret store.
 *
 * The counterpart to {@link mcpSecretFile}: this is the implementation both the
 * window and the runner can pass to the manager, differing only in the store
 * they hand it.
 */
export function secretReaderFor(
  paths: AppPaths,
  stores: (file: string, label: string) => FileSecretStore,
): (server: McpServer) => Promise<McpResolvedSecrets> {
  return async (server) => {
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};

    for (const reference of server.secrets ?? []) {
      const file = mcpSecretFile(paths, server.id, reference.target, reference.name);
      const store = stores(file, `the ${reference.name} for "${server.name}"`);
      const value = await store.get();
      if (value.length === 0) {
        continue;
      }
      if (reference.target === 'env') {
        env[reference.name] = value;
      } else {
        headers[reference.name] = value;
      }
    }

    return {env, headers};
  };
}
