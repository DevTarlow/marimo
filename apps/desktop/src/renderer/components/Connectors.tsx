/**
 * Connectors: the MCP servers this agent can reach.
 *
 * The panel is shaped around what somebody actually does — paste the line from a
 * server's README — rather than around the schema. Command and arguments are one
 * box, quoted the way every shell they have used quotes, and the parser beside
 * this file turns it back into the pair the document stores.
 *
 * **Trust is the decision the panel exists for.** An MCP server is software
 * somebody else wrote, offering tools to a model that will use them. Until it is
 * trusted, every one of its calls asks first; trusting it means they stop asking.
 * So the switch says exactly that, and the default is untrusted.
 *
 * Nothing is saved until it is tested or saved deliberately. A connector typed
 * wrongly and saved is a connector that "does not work", and the user has no way
 * to tell a typo from a broken server.
 */
import {useState} from 'react';

import type {McpServer, McpStatus} from '@marimo/protocol';

import {formatCommandLine, parseCommandLine} from '../command-line.js';

/** A connector being written, before it is a valid `McpServer`. */
interface Draft {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  /** One line, as pasted. Split on save. */
  line: string;
  url: string;
  trusted: boolean;
}

function emptyDraft(): Draft {
  return {
    id: '',
    name: '',
    transport: 'stdio',
    line: '',
    url: '',
    trusted: false,
  };
}

function draftOf(server: McpServer): Draft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    line: formatCommandLine(server.command, server.args),
    url: server.url ?? '',
    trusted: server.trusted,
  };
}

/** A name the server can be identified by, derived from what was typed. */
function idFor(draft: Draft): string {
  const base = draft.name.trim().toLowerCase().replaceAll(/[^a-z0-9_]/gu, '_');
  return `mcp:${base.length > 0 ? base : 'server'}`;
}

/** Turns a draft into the document, or explains what is missing. */
function toServer(draft: Draft): {server: McpServer} | {problem: string} {
  const name = draft.name.trim().toLowerCase();
  if (name.length === 0) {
    return {problem: 'Give the connector a name so you can tell it apart later.'};
  }

  const base = {
    id: draft.id.length > 0 ? draft.id : idFor(draft),
    name,
    transport: draft.transport,
    enabled: true,
    trusted: draft.trusted,
  };

  if (draft.transport === 'http') {
    const url = draft.url.trim();
    if (url.length === 0) {
      return {problem: 'An address is needed for a connector reached over HTTP.'};
    }
    return {server: {...base, url}};
  }

  try {
    const {command, args} = parseCommandLine(draft.line);
    return {server: {...base, command, ...(args.length > 0 ? {args} : {})}};
  } catch (error) {
    return {
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

export function Connectors({
  servers,
  statuses,
  onChange,
}: {
  servers: McpServer[];
  statuses: Record<string, McpStatus>;
  onChange: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      onChange();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /** The server this draft describes, or a complaint. */
  const resolve = (): McpServer | null => {
    if (draft === null) {
      return null;
    }
    const result = toServer(draft);
    if ('problem' in result) {
      setProblem(result.problem);
      return null;
    }
    return result.server;
  };

  return (
    <section className="settings-section">
      <h3>Connectors</h3>
      <p className="settings-muted">
        Connect this agent to an MCP server — a program that offers it extra
        tools. Until you trust one, every tool it offers asks your permission
        before it runs.
      </p>

      {servers.length === 0 && draft === null && (
        <p className="settings-muted">No connectors yet.</p>
      )}

      {servers.map((server) => {
        const status = statuses[server.id];
        return (
          <div className="connector" key={server.id}>
            <div className="connector-head">
              <span
                className="connector-dot"
                data-state={status?.state ?? 'off'}
                aria-hidden="true"
              />
              <strong className="connector-name">{server.name}</strong>
              <span className="connector-transport">{server.transport}</span>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy}
                onClick={() => {
                  setTested(null);
                  setDraft(draftOf(server));
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    await window.marimo.call('mcp.remove', {serverId: server.id});
                  });
                }}
              >
                Remove
              </button>
            </div>
            {/*
              The detail alone. It already *is* the message — for a connected
              server it reads "5 tools." — and appending the count again gave
              "5 tools. (5 tools)".
            */}
            <p className="connector-detail">
              {status === undefined ? 'Not connected.' : status.detail}
            </p>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={server.trusted}
                disabled={busy}
                onChange={(event) => {
                  const trusted = event.target.checked;
                  void run(async () => {
                    await window.marimo.call('mcp.set', {
                      server: {...server, trusted},
                    });
                  });
                }}
              />
              <span>
                Trust this connector
                <em className="settings-why">
                  {server.trusted
                    ? 'Its tools run without asking. Only do this for a server you would let act on your computer.'
                    : 'Its tools ask before every call. Leave this off unless you wrote the server or trust whoever did.'}
                </em>
              </span>
            </label>
          </div>
        );
      })}

      {draft === null ? (
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          onClick={() => {
            setProblem(null);
            setTested(null);
            setDraft(emptyDraft());
          }}
        >
          + Add a connector
        </button>
      ) : (
        <div className="connector connector-editing">
          <label className="settings-field">
            <span>Name</span>
            <input
              className="settings-input"
              value={draft.name}
              placeholder="files"
              disabled={busy}
              onChange={(event) => {
                setDraft({...draft, name: event.target.value});
              }}
            />
          </label>

          <label className="settings-field">
            <span>How it connects</span>
            <select
              className="settings-input"
              value={draft.transport}
              disabled={busy}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  transport: event.target.value === 'http' ? 'http' : 'stdio',
                });
              }}
            >
              <option value="stdio">A command on this computer</option>
              <option value="http">A web address</option>
            </select>
          </label>

          {draft.transport === 'stdio' ? (
            <label className="settings-field">
              <span>Command</span>
              <em className="settings-why">
                Paste the line from the server&rsquo;s instructions. Put quotes
                around anything with a space in it.
              </em>
              <input
                className="settings-input"
                value={draft.line}
                placeholder="npx -y @modelcontextprotocol/server-filesystem /home/you"
                disabled={busy}
                onChange={(event) => {
                  setDraft({...draft, line: event.target.value});
                }}
              />
            </label>
          ) : (
            <label className="settings-field">
              <span>Address</span>
              <input
                className="settings-input"
                value={draft.url}
                placeholder="https://example.com/mcp"
                disabled={busy}
                onChange={(event) => {
                  setDraft({...draft, url: event.target.value});
                }}
              />
            </label>
          )}

          <label className="settings-check">
            <input
              type="checkbox"
              checked={draft.trusted}
              disabled={busy}
              onChange={(event) => {
                setDraft({...draft, trusted: event.target.checked});
              }}
            />
            <span>
              Trust it now
              <em className="settings-why">
                Its tools will run without asking. Leaving this off is the safer
                start — you can turn it on once you have seen what it offers.
              </em>
            </span>
          </label>

          <div className="connector-actions">
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={() => {
                const server = resolve();
                if (server === null) {
                  return;
                }
                void (async () => {
                  setBusy(true);
                  setProblem(null);
                  setTested(null);
                  try {
                    const result = await window.marimo.call('mcp.test', {server});
                    setTested(
                      result.ok
                        ? `Connected. ${result.detail}`
                        : `Could not connect: ${result.detail}`,
                    );
                  } catch (failure) {
                    setProblem(describe(failure));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Test
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => {
                const server = resolve();
                if (server === null) {
                  return;
                }
                void run(async () => {
                  await window.marimo.call('mcp.set', {server});
                  setDraft(null);
                  setTested(null);
                });
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setProblem(null);
                setTested(null);
              }}
            >
              Cancel
            </button>
          </div>

          {tested !== null && <p className="connector-detail">{tested}</p>}
        </div>
      )}

      {problem !== null && (
        <p className="connector-detail connector-error">{problem}</p>
      )}
    </section>
  );
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}
