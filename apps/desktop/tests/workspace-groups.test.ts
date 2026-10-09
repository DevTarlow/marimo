/**
 * How the rail reads the two lists it is handed.
 *
 * The grouping is the feature, so it is tested without a DOM: which folder a
 * conversation lands under, what happens to one whose folder has been forgotten,
 * and where a conversation the app started rather than the user goes. Each of
 * those has a wrong answer that looks plausible on a screen.
 */
import {describe, expect, it} from 'vitest';

import type {SessionSummary, Workspace} from '@marimo/protocol';

import {
  folderForSession,
  groupSessions,
} from '../src/renderer/workspace-groups.js';

function workspace(id: string, name: string): Workspace {
  return {id, name, path: `/home/someone/${name}`};
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    title: 'A chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 2,
    ...overrides,
  };
}

const alpha = workspace('ws-a', 'alpha');
const beta = workspace('ws-b', 'beta');

describe('groupSessions', () => {
  it('lists every folder in order, even an empty one', () => {
    const groups = groupSessions({
      workspaces: [alpha, beta],
      sessions: [],
      activeSessionId: null,
    });
    expect(groups).toEqual([
      {kind: 'workspace', workspace: alpha, sessions: []},
      {kind: 'workspace', workspace: beta, sessions: []},
    ]);
  });

  it('files a conversation under the folder it names', () => {
    const inAlpha = session({id: 'a-1', workspaceId: alpha.id});
    const inBeta = session({id: 'b-1', workspaceId: beta.id});
    const groups = groupSessions({
      workspaces: [alpha, beta],
      sessions: [inBeta, inAlpha],
      activeSessionId: null,
    });
    expect(groups[0]).toMatchObject({kind: 'workspace', sessions: [inAlpha]});
    expect(groups[1]).toMatchObject({kind: 'workspace', sessions: [inBeta]});
  });

  it('keeps the order it was given inside a folder', () => {
    const newer = session({id: 'newer', workspaceId: alpha.id});
    const older = session({id: 'older', workspaceId: alpha.id});
    const groups = groupSessions({
      workspaces: [alpha],
      sessions: [newer, older],
      activeSessionId: null,
    });
    expect(groups[0]?.sessions.map((entry) => entry.id)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('puts a conversation with no folder under Other chats', () => {
    const loose = session({id: 'loose'});
    const groups = groupSessions({
      workspaces: [alpha],
      sessions: [loose],
      activeSessionId: null,
    });
    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual({kind: 'other', sessions: [loose]});
  });

  /*
   * The folder was removed while the conversation still named it. Dropping the
   * conversation with the folder would be losing something the user wrote to a
   * tidy-up, so it moves rather than disappears.
   */
  it('puts a conversation whose folder is gone under Other chats', () => {
    const orphan = session({id: 'orphan', workspaceId: 'ws-deleted'});
    const groups = groupSessions({
      workspaces: [alpha],
      sessions: [orphan],
      activeSessionId: null,
    });
    expect(groups[1]).toEqual({kind: 'other', sessions: [orphan]});
  });

  /*
   * A Discord mention arrives in whatever folder happened to be current, and has
   * nothing to do with it. The source outranks the filing, which is the whole
   * reason the field exists.
   */
  it('files a conversation the app started under Social, whatever folder it named', () => {
    const mentioned = session({
      id: 'from-discord',
      workspaceId: alpha.id,
      source: 'discord',
    });
    const other = session({id: 'from-elsewhere', source: 'discord'});
    const groups = groupSessions({
      workspaces: [alpha],
      sessions: [mentioned, other],
      activeSessionId: null,
    });
    expect(groups[0]).toMatchObject({kind: 'workspace', sessions: []});
    expect(groups[1]).toEqual({
      kind: 'social',
      sessions: [mentioned, other],
    });
  });

  it('draws folders, then Social, then Other chats', () => {
    const groups = groupSessions({
      workspaces: [alpha],
      sessions: [
        session({id: 'loose'}),
        session({id: 'social', source: 'discord'}),
        session({id: 'filed', workspaceId: alpha.id}),
      ],
      activeSessionId: null,
    });
    expect(groups.map((group) => group.kind)).toEqual([
      'workspace',
      'social',
      'other',
    ]);
  });

  it('leaves the empty groups out when they hold nothing', () => {
    const groups = groupSessions({
      workspaces: [alpha],
      sessions: [session({id: 'filed', workspaceId: alpha.id})],
      activeSessionId: null,
    });
    expect(groups.map((group) => group.kind)).toEqual(['workspace']);
  });

  /*
   * A conversation with no messages is not listed — it exists the moment the
   * window opens one. The exception is the one on screen, which the rail would
   * otherwise appear to have lost.
   */
  it('hides an empty conversation unless it is the open one', () => {
    const empty = session({
      id: 'empty',
      messageCount: 0,
      workspaceId: alpha.id,
    });
    expect(
      groupSessions({
        workspaces: [alpha],
        sessions: [empty],
        activeSessionId: null,
      })[0]?.sessions,
    ).toEqual([]);
    expect(
      groupSessions({
        workspaces: [alpha],
        sessions: [empty],
        activeSessionId: 'empty',
      })[0]?.sessions,
    ).toEqual([empty]);
  });
});

describe('folderForSession', () => {
  const filed = session({id: 'filed', workspaceId: alpha.id});

  it('answers the open conversation own folder', () => {
    expect(
      folderForSession({
        workspaces: [alpha, beta],
        sessions: [filed],
        sessionId: 'filed',
        activeWorkspaceId: beta.id,
      }),
    ).toBe(alpha.path);
  });

  it('falls back to the current folder for one that has none', () => {
    const loose = session({id: 'loose'});
    expect(
      folderForSession({
        workspaces: [alpha, beta],
        sessions: [loose],
        sessionId: 'loose',
        activeWorkspaceId: beta.id,
      }),
    ).toBe(beta.path);
  });

  it('falls back when the folder it named has been forgotten', () => {
    const orphan = session({id: 'orphan', workspaceId: 'ws-deleted'});
    expect(
      folderForSession({
        workspaces: [alpha],
        sessions: [orphan],
        sessionId: 'orphan',
        activeWorkspaceId: alpha.id,
      }),
    ).toBe(alpha.path);
  });

  it('answers nothing when there are no folders at all', () => {
    expect(
      folderForSession({
        workspaces: [],
        sessions: [session({id: 'anything'})],
        sessionId: 'anything',
        activeWorkspaceId: null,
      }),
    ).toBeNull();
  });
});
