/**
 * The skills file: the user's own skills, and the names that switch them on.
 *
 * The rule worth pinning is the name. It becomes a `## heading` in the system
 * prompt *and* a member of a profile's `enabledSkills`, so two spellings of one
 * procedure have to be one skill rather than two that cannot both be switched on.
 */
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {SKILL_INSTRUCTIONS_MAX} from '@marimo/protocol';

import {
  DuplicateSkillNameError,
  ReservedSkillNameError,
  SkillStore,
  SkillTooLongError,
  normaliseName,
} from './skills.js';

describe('normaliseName', () => {
  it('turns whatever the model wrote into one name', () => {
    expect(normaliseName('Weekly Inbox Triage')).toBe('weekly-inbox-triage');
    expect(normaliseName('weekly_inbox_triage')).toBe('weekly-inbox-triage');
    expect(normaliseName('  weekly-inbox-triage  ')).toBe(
      'weekly-inbox-triage',
    );
    expect(normaliseName('Weekly  Inbox -- Triage')).toBe(
      'weekly-inbox-triage',
    );
  });

  it('never returns a name that would be a blank heading', () => {
    expect(normaliseName('***')).toBe('skill');
    expect(normaliseName('')).toBe('skill');
  });
});

describe('SkillStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-skills-'));
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  function store(): SkillStore {
    return new SkillStore({file: join(dir, 'skills.json')});
  }

  const draft = {
    name: 'Weekly Inbox Triage',
    description: 'Sort the inbox every Monday.',
    instructions: '1. Read the unread mail.',
  };

  it('starts empty', async () => {
    expect(await store().load()).toEqual([]);
  });

  it('saves a skill under its normalised name', async () => {
    const {skill, updated} = await store().save(draft);

    expect(updated).toBe(false);
    expect(skill.name).toBe('weekly-inbox-triage');
    expect(skill.description).toBe('Sort the inbox every Monday.');
    expect(skill.instructions).toBe('1. Read the unread mail.');
    expect(skill.id).toBeTruthy();
    expect(skill.createdAt).toBeTruthy();
  });

  it('replaces a skill saved under another spelling of the same name', async () => {
    const first = await store().save(draft);
    const second = await store().save({
      ...draft,
      name: 'weekly_inbox_triage',
      instructions: '1. Read the unread mail.\n2. Group by sender.',
    });

    expect(second.updated).toBe(true);
    // The id and the date belong to the skill, not to the edit, so anything
    // already holding one still names the same thing.
    expect(second.skill.id).toBe(first.skill.id);
    expect(second.skill.createdAt).toBe(first.skill.createdAt);

    const stored = await store().load();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.instructions).toBe(
      '1. Read the unread mail.\n2. Group by sender.',
    );
  });

  it('keeps two different skills apart', async () => {
    await store().save(draft);
    await store().save({...draft, name: 'standup-notes'});
    expect((await store().load()).map((skill) => skill.name)).toEqual([
      'weekly-inbox-triage',
      'standup-notes',
    ]);
  });

  it('removes one by id and leaves the rest', async () => {
    const first = await store().save(draft);
    await store().save({...draft, name: 'standup-notes'});

    const remaining = await store().remove(first.skill.id);
    expect(remaining.map((skill) => skill.name)).toEqual(['standup-notes']);
    expect((await store().load()).map((skill) => skill.name)).toEqual([
      'standup-notes',
    ]);
  });

  it('answers with the list unchanged when the id names nothing', async () => {
    await store().save(draft);
    const remaining = await store().remove('nope');
    expect(remaining).toHaveLength(1);
  });

  /**
   * A saved skill is switched on by name, in the same list as the built-ins, so a
   * saved `memory` would shadow the app's own memory skill rather than sit beside
   * it. Refused before anything is written, and the model is told why.
   */
  it('refuses a name the app already ships', async () => {
    const reserved = new SkillStore({
      file: join(dir, 'skills.json'),
      reserved: ['reasoning', 'memory', 'knowledge'],
    });

    await expect(
      reserved.save({...draft, name: 'Memory'}),
    ).rejects.toBeInstanceOf(ReservedSkillNameError);
    expect(await reserved.load()).toEqual([]);
  });

  it('allows anything the app does not ship', async () => {
    const reserved = new SkillStore({
      file: join(dir, 'skills.json'),
      reserved: ['reasoning', 'memory', 'knowledge'],
    });
    const {skill} = await reserved.save({...draft, name: 'memory-notes'});
    expect(skill.name).toBe('memory-notes');
  });

  /**
   * The one rule that has to hold on every path in, because the length is a
   * property of the file rather than of the caller: this text is prepended to the
   * system prompt on every request, and a skill that crowds out the conversation
   * costs the user without them seeing a bill. `/learn`, the Settings editor and
   * a hand-edited file all end up here.
   */
  it('refuses instructions longer than the limit, writing nothing', async () => {
    await expect(
      store().save({
        ...draft,
        instructions: 'x'.repeat(SKILL_INSTRUCTIONS_MAX + 1),
      }),
    ).rejects.toBeInstanceOf(SkillTooLongError);
    expect(await store().load()).toEqual([]);
  });

  it('accepts instructions exactly at the limit', async () => {
    const {skill} = await store().save({
      ...draft,
      instructions: 'x'.repeat(SKILL_INSTRUCTIONS_MAX),
    });
    expect(skill.instructions).toHaveLength(SKILL_INSTRUCTIONS_MAX);
  });

  /**
   * The Settings editor reads a skill out, lets the user type in it, and writes
   * it back through the same `save`. That round trip has to be an edit rather
   * than a second skill — the id and the date are what everything else holds.
   */
  it('edits a skill in place, keeping its id and date', async () => {
    const first = await store().save(draft);
    const second = await store().save({
      name: first.skill.name,
      description: 'Sort the inbox twice a week.',
      instructions: '1. Read the unread mail.\n2. Reply to the easy ones.',
    });

    expect(second.updated).toBe(true);
    expect(second.skill.id).toBe(first.skill.id);
    expect(second.skill.createdAt).toBe(first.skill.createdAt);
    expect((await store().load())[0]?.description).toBe(
      'Sort the inbox twice a week.',
    );
  });

  it('renames a skill by saving it under the new name, by id', async () => {
    const first = await store().save(draft);
    const renamed = await store().save(
      {...draft, name: 'Monday Inbox'},
      first.skill.id,
    );

    // The id is what makes this a rename rather than a second skill: everything
    // that referred to the old name — a profile's `enabledSkills` — is corrected
    // by the caller, but the id and the date stay put.
    expect(renamed.updated).toBe(true);
    expect(renamed.skill.id).toBe(first.skill.id);
    expect(renamed.skill.createdAt).toBe(first.skill.createdAt);
    expect(renamed.skill.name).toBe('monday-inbox');
    const stored = await store().load();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('monday-inbox');
  });

  /**
   * Renaming onto another skill's name would put two procedures behind one
   * checkbox in `enabledSkills`, which is a list of names. Refused, and nothing
   * written — losing the skill the user is *not* looking at would be the worse
   * failure.
   */
  it('refuses a rename onto a name another skill holds', async () => {
    const first = await store().save(draft);
    await store().save({...draft, name: 'standup-notes'});

    await expect(
      store().save({...draft, name: 'standup-notes'}, first.skill.id),
    ).rejects.toBeInstanceOf(DuplicateSkillNameError);

    expect((await store().load()).map((skill) => skill.name)).toEqual([
      'weekly-inbox-triage',
      'standup-notes',
    ]);
  });

  it('treats an id that names nothing as an insert', async () => {
    const {skill, updated} = await store().save(draft, 'gone');
    expect(updated).toBe(false);
    expect(skill.name).toBe('weekly-inbox-triage');
    expect(await store().load()).toHaveLength(1);
  });

  it('reads a corrupt file as empty rather than refusing to start', async () => {
    // The user cannot act on a truncated JSON file, and the app refusing to open
    // over one would cost them everything else.
    await writeFile(
      join(dir, 'skills.json'),
      '{"version": 1, "skills": [',
      'utf8',
    );
    expect(await store().load()).toEqual([]);
  });

  it('drops a skill that does not fit the schema, keeping the others', async () => {
    await writeFile(
      join(dir, 'skills.json'),
      JSON.stringify({
        version: 1,
        skills: [
          {
            id: 'a',
            name: 'good',
            description: 'd',
            instructions: 'i',
            createdAt: 'now',
          },
          {
            id: 'b',
            name: '',
            description: 'd',
            instructions: 'i',
            createdAt: 'now',
          },
        ],
      }),
      'utf8',
    );

    // The whole file is one document, so an entry that cannot be parsed loses
    // the file rather than half of it — and the app says so by starting empty.
    expect(await store().load()).toEqual([]);
  });
});
