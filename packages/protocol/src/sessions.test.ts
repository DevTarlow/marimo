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

  /*
   * `preferences` is optional on purpose, and this is the test that keeps it so:
   * `ProfileStore.parseFile` skips a profile that fails this schema, and a file
   * whose every profile was skipped is quarantined and replaced with a fresh one.
   * A required field here would lose every existing agent on upgrade.
   */
  it('reads a profile written before preferences existed', () => {
    const parsed = agentProfileSchema.safeParse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? parsed.data.preferences : 'unparsed',
    ).toBeUndefined();
  });

  it('carries the preferences the user wrote', () => {
    const parsed = agentProfileSchema.parse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      preferences: 'Call me Tarlow. Skip the emoji.',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed.preferences).toBe('Call me Tarlow. Skip the emoji.');
  });

  it('lets a patch clear preferences with an empty string', () => {
    const parsed = agentCallSchemas['profiles.update'].parse({
      profileId: 'agent',
      patch: {preferences: ''},
    });
    // Not `undefined`: "clear it" and "say nothing about it" are different
    // requests, and the store tells them apart by exactly this.
    expect(parsed.patch.preferences).toBe('');
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

  it('accepts a model, and null for no model of its own', () => {
    const chosen = agentCallSchemas['sessions.setModel'].parse({
      profileId: 'p',
      sessionId: 's',
      model: '  deepseek-v4-pro  ',
    });
    expect(chosen.model).toBe('deepseek-v4-pro');

    /*
     * `null` is not decoration: it is the only way back to following the app
     * default, because a conversation's model is a choice with a default
     * underneath it. Both facts have to cross the boundary, and each is a
     * different state in the index.
     */
    expect(
      agentCallSchemas['sessions.setModel'].parse({
        profileId: 'p',
        sessionId: 's',
        model: null,
      }).model,
    ).toBeNull();
  });

  it('names the conversation a command acts on', () => {
    expect(
      agentCallSchemas['sessions.compact'].safeParse({
        profileId: 'p',
        sessionId: 's',
      }).success,
    ).toBe(true);
    // No text: a command is not something the user said, and a body would be one
    // more field the window has to fill in for nothing.
    expect(
      agentCallSchemas['sessions.compact'].safeParse({profileId: 'p'}).success,
    ).toBe(false);
  });

  it('refuses a blank model rather than storing one that resolves to nothing', () => {
    // An empty string would be a third state — neither a choice nor the default
    // — and the agent would then resolve a turn against a model id of "".
    expect(
      agentCallSchemas['sessions.setModel'].safeParse({
        profileId: 'p',
        sessionId: 's',
        model: '   ',
      }).success,
    ).toBe(false);
    expect(
      agentCallSchemas['sessions.setModel'].safeParse({
        profileId: 'p',
        sessionId: 's',
      }).success,
    ).toBe(false);
  });
});
