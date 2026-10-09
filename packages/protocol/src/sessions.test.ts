/**
 * The calls that file conversations and manage folders.
 *
 * The shapes the main process checks every inbound call against, tested where
 * the parsing happens rather than through a window: a `null` that the schema
 * refuses is a move that fails with "Invalid parameters" instead of unfiling the
 * conversation, and a whole document that fails its version check is a rail with
 * no folders in it.
 */
import {describe, expect, it} from 'vitest';

import {
  agentCallSchemas,
  agentProfileSchema,
  workspacesFileSchema,
} from './index.js';

describe('the profile schema', () => {
  it('does not carry folders any more', () => {
    // A file from before folders were install-wide parses, and the fields it
    // used to hold are dropped rather than reaching the renderer as profile
    // fields it might act on.
    const parsed = agentProfileSchema.parse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      workspaces: [{id: 'ws', name: 'project', path: '/home/someone/project'}],
      activeWorkspaceId: 'ws',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed).toEqual({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      enabledTools: [],
      enabledSkills: [],
    });
  });
});

describe('the workspaces document', () => {
  it('round-trips folders and the current one', () => {
    const parsed = workspacesFileSchema.parse({
      version: 1,
      workspaces: [{id: 'ws', name: 'project', path: '/home/someone/project'}],
      activeWorkspaceId: 'ws',
    });
    expect(parsed.activeWorkspaceId).toBe('ws');
    expect(parsed.workspaces).toHaveLength(1);
  });

  it('allows no current folder, which is an install with none', () => {
    const parsed = workspacesFileSchema.parse({
      version: 1,
      workspaces: [],
      activeWorkspaceId: null,
    });
    expect(parsed.activeWorkspaceId).toBeNull();
  });

  it('refuses a version this build does not know', () => {
    expect(
      workspacesFileSchema.safeParse({
        version: 2,
        workspaces: [],
        activeWorkspaceId: null,
      }).success,
    ).toBe(false);
  });

  it('refuses a blank folder name rather than persisting one', () => {
    expect(
      workspacesFileSchema.safeParse({
        version: 1,
        workspaces: [{id: 'ws', name: '   ', path: '/tmp/x'}],
        activeWorkspaceId: 'ws',
      }).success,
    ).toBe(false);
  });
});

describe('the workspace calls', () => {
  it('accepts a folder named by path, and none at all for the picker', () => {
    expect(agentCallSchemas['workspaces.add'].safeParse({}).success).toBe(true);
    expect(
      agentCallSchemas['workspaces.add'].safeParse({path: '/home/someone/p'})
        .success,
    ).toBe(true);
    expect(
      agentCallSchemas['workspaces.add'].safeParse({path: ''}).success,
    ).toBe(false);
  });

  it('refuses a blank id on every call that names a folder', () => {
    for (const method of [
      'workspaces.select',
      'workspaces.rename',
      'workspaces.remove',
      'workspaces.open',
    ] as const) {
      expect(
        agentCallSchemas[method].safeParse({workspaceId: ''}).success,
      ).toBe(false);
    }
  });

  it('trims a new folder name and refuses a blank one', () => {
    const parsed = agentCallSchemas['workspaces.rename'].parse({
      workspaceId: 'ws',
      name: '  Client work  ',
    });
    expect(parsed.name).toBe('Client work');
    expect(
      agentCallSchemas['workspaces.rename'].safeParse({
        workspaceId: 'ws',
        name: '   ',
      }).success,
    ).toBe(false);
  });
});

describe('the filing calls', () => {
  it('accepts an id to move to, and null to unfile', () => {
    const toFolder = agentCallSchemas['sessions.move'].parse({
      profileId: 'p',
      sessionId: 's',
      workspaceId: 'ws',
    });
    expect(toFolder.workspaceId).toBe('ws');

    const unfiled = agentCallSchemas['sessions.move'].parse({
      profileId: 'p',
      sessionId: 's',
      workspaceId: null,
    });
    expect(unfiled.workspaceId).toBeNull();
  });

  it('requires an explicit filing rather than treating an absent one as unfiling', () => {
    // `undefined` would be a move that silently unfiled a conversation for a
    // caller that forgot to send the field.
    expect(
      agentCallSchemas['sessions.move'].safeParse({
        profileId: 'p',
        sessionId: 's',
      }).success,
    ).toBe(false);
  });

  it('trims a new title and refuses a blank one', () => {
    const parsed = agentCallSchemas['sessions.rename'].parse({
      profileId: 'p',
      sessionId: 's',
      title: '  Release prep  ',
    });
    expect(parsed.title).toBe('Release prep');
    expect(
      agentCallSchemas['sessions.rename'].safeParse({
        profileId: 'p',
        sessionId: 's',
        title: '   ',
      }).success,
    ).toBe(false);
  });

  it('names the conversation to delete', () => {
    expect(
      agentCallSchemas['sessions.delete'].safeParse({
        profileId: 'p',
        sessionId: 's',
      }).success,
    ).toBe(true);
    expect(
      agentCallSchemas['sessions.delete'].safeParse({profileId: 'p'}).success,
    ).toBe(false);
  });
});
