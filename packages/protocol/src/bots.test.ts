/**
 * The two seeds and the starter roles.
 *
 * They are constants in the protocol because several places have to agree about
 * them: `ProfileStore` seeds a profile, the runtime builds the Reset maps, and
 * the window draws the starter cards. A copy in the renderer would reset a bot
 * to something the app never shipped, which looks like the button working.
 *
 * The rule about what a seed must *not* contain — the app's own method
 * vocabulary, and a tool name a profile may not have — is pinned in
 * `packages/agent/src/skills/skills.test.ts`, beside the code that appends it.
 * This file is about the seeds being different from each other in the way the
 * two kinds of profile need them to be.
 */
import {describe, expect, it} from 'vitest';

import {
  availableBotTemplates,
  BOT_TEMPLATES,
  botPersonaFor,
  botRoleFor,
  botTemplateById,
  DEFAULT_AGENT_PERSONA,
  DEFAULT_AGENT_ROLE,
  DEFAULT_BOT_PERSONA,
} from './index.js';

describe('the lead seed', () => {
  it('names Marimo Bot in its Role', () => {
    expect(DEFAULT_AGENT_ROLE).toContain('You are Marimo Bot');
  });

  /*
   * The split is the whole point. The Role is the app's and Reset restores it;
   * the Persona is the person's and must not be inside it, or a reset would
   * erase what they wrote.
   */
  it('keeps the character out of the Role', () => {
    expect(DEFAULT_AGENT_ROLE).not.toBe(DEFAULT_AGENT_PERSONA);
    expect(DEFAULT_AGENT_ROLE).not.toContain('Be funny when it is funny');
    expect(DEFAULT_AGENT_PERSONA).toContain('funny when it is funny');
  });
});

describe('the bot seeds', () => {
  it('names a generic bot rather than introducing it as Marimo Bot', () => {
    const text = botRoleFor('Writer');
    expect(text).toContain('Writer');
    expect(text).not.toContain('You are Marimo Bot');
  });

  /*
   * A name is user text, and a blank one is a field somebody cleared rather
   * than a bot with no name: the fallback keeps the first line a sentence
   * instead of "You are .".
   */
  it('falls back rather than opening on a blank name', () => {
    const text = botRoleFor('   ');
    expect(text).not.toContain('You are .');
    expect(text.startsWith('You are this bot.')).toBe(true);
  });

  it('puts the starter role after the generic bot contract', () => {
    const writer = botTemplateById('writer');
    expect(writer).toBeDefined();
    const text = botRoleFor('Writer', writer);
    expect(text).toContain('You are Writer.');
    expect(text).toContain(writer?.role ?? '');
    expect(text.indexOf(writer?.role ?? '')).toBeGreaterThan(
      text.indexOf('You are Writer.'),
    );
  });

  it('uses a starter role persona, and the generic one without a role', () => {
    expect(botPersonaFor(botTemplateById('writer'))).toBe(
      botTemplateById('writer')?.persona,
    );
    expect(botPersonaFor(undefined)).toBe(DEFAULT_BOT_PERSONA);
  });
});

describe('the starter roles', () => {
  it('has unique ids and a name to suggest', () => {
    const ids = BOT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of BOT_TEMPLATES) {
      expect(template.suggestedName.trim().length).toBeGreaterThan(0);
      expect(template.role.trim().length).toBeGreaterThan(0);
      expect(template.persona.trim().length).toBeGreaterThan(0);
    }
  });

  /*
   * The Role and Persona are text a person will read and edit. A tool name in
   * them is a capability claim the profile may not grant — the capability
   * skills are what tell the model what it can do, and they follow the tools.
   */
  it('keeps tool names out of the editable text', () => {
    const toolNames = [
      'read_file',
      'write_file',
      'run_shell',
      'web_search',
      'http_fetch',
      'read_memory',
      'update_memory',
      'ask_agent',
      'draft_bot',
    ];
    for (const template of BOT_TEMPLATES) {
      for (const name of toolNames) {
        expect(template.role).not.toContain(name);
        expect(template.persona).not.toContain(name);
      }
    }
  });

  it('narrows tools to what the install has', () => {
    const writer = BOT_TEMPLATES.find((template) => template.id === 'writer');
    expect(writer).toBeDefined();
    expect(writer?.tools.length).toBeGreaterThan(0);
    const narrowed = availableBotTemplates(['current_time', 'read_file']);
    expect(narrowed.find((entry) => entry.id === 'writer')?.tools).toEqual([
      'current_time',
      'read_file',
    ]);
  });
});
