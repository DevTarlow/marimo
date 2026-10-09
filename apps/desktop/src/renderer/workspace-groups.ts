/**
 * The rail's reading of the conversation list.
 *
 * Pure and separate from the component because the grouping *is* the feature: a
 * conversation belongs to the folder it was started in, and the two ways that
 * can go wrong — a folder nobody lists any more, and a conversation the app
 * started rather than the user — are rules worth testing without a DOM.
 *
 * `source` outranks `workspaceId`. A Discord mention arrives in a folder it has
 * nothing to do with if the app happens to be pointed at one, and burying it
 * there is exactly what a "Social" heading prevents.
 */
import type {SessionSummary, Workspace} from '@marimo/protocol';

export type RailGroup =
  | {kind: 'workspace'; workspace: Workspace; sessions: SessionSummary[]}
  | {kind: 'social'; sessions: SessionSummary[]}
  | {kind: 'other'; sessions: SessionSummary[]};

/**
 * The groups the rail draws, in the order it draws them.
 *
 * Every workspace gets a group even when it holds nothing, because that is where
 * its "new chat" button lives — a folder that vanished until it had a
 * conversation in it would be a folder nobody could start one in.
 */
export function groupSessions(options: {
  workspaces: readonly Workspace[];
  sessions: readonly SessionSummary[];
  activeSessionId: string | null;
}): RailGroup[] {
  /*
   * A conversation with no messages is not listed — it exists the moment the
   * window opens one, and a rail whose first entry is an empty chat the user
   * never asked for is a rail that lies about what they have. The exception is
   * the one on screen: hiding it would make the rail look like the app had lost
   * the conversation being read.
   */
  const listed = options.sessions.filter(
    (session) =>
      session.messageCount > 0 || session.id === options.activeSessionId,
  );

  const known = new Set(options.workspaces.map((workspace) => workspace.id));
  const byWorkspace = new Map<string, SessionSummary[]>();
  const social: SessionSummary[] = [];
  const other: SessionSummary[] = [];

  for (const session of listed) {
    if (session.source === 'discord') {
      social.push(session);
      continue;
    }
    /*
     * An id that names no folder is not an error: it is a conversation from
     * before folders existed, or one whose folder has since been forgotten.
     * Both belong in "Other chats", and both stay reachable.
     */
    if (session.workspaceId === undefined || !known.has(session.workspaceId)) {
      other.push(session);
      continue;
    }
    const bucket = byWorkspace.get(session.workspaceId) ?? [];
    bucket.push(session);
    byWorkspace.set(session.workspaceId, bucket);
  }

  const groups: RailGroup[] = options.workspaces.map((workspace) => ({
    kind: 'workspace',
    workspace,
    sessions: byWorkspace.get(workspace.id) ?? [],
  }));
  if (social.length > 0) {
    groups.push({kind: 'social', sessions: social});
  }
  if (other.length > 0) {
    groups.push({kind: 'other', sessions: other});
  }
  return groups;
}

/**
 * The folder the open conversation works in, for the line under the header.
 *
 * The conversation's own folder, or — for one that has none, or whose folder has
 * been forgotten — the folder a turn would actually fall back to. It answers the
 * same question `workspaceRootFor` does on the main-process side, from the
 * window's copy of the two lists.
 */
export function folderForSession(options: {
  workspaces: readonly Workspace[];
  sessions: readonly SessionSummary[];
  sessionId: string | null;
  activeWorkspaceId: string | null;
}): string | null {
  const open = options.sessions.find(
    (session) => session.id === options.sessionId,
  );
  const filed = open?.workspaceId;
  const workspace =
    (filed === undefined
      ? undefined
      : options.workspaces.find((entry) => entry.id === filed)) ??
    options.workspaces.find((entry) => entry.id === options.activeWorkspaceId);
  return workspace?.path ?? null;
}
