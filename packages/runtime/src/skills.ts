/**
 * Skills the user made, in one file beside the app's other state.
 *
 * The built-in skills are TypeScript modules because they are part of the app;
 * these are not. A skill made with `/learn` is something the user asked the agent
 * to write down about how they work, so it lives with the rest of the app's data,
 * survives an upgrade, and can be edited or deleted from Settings.
 *
 * `save` upserts on the name rather than appending. Learning the same procedure
 * twice is the expected way to refine it — the second attempt has the benefit of
 * the first conversation — and two skills with one name would be
 * indistinguishable both in the checkboxes and to `enabledSkills`, which is by
 * name. The same rule is what makes the Settings editor a rename rather than an
 * edit-and-delete: the name is the identity, and everything that referred to the
 * old one is corrected by whoever called this.
 */
import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

import {
  SKILL_INSTRUCTIONS_MAX,
  emptySkillsFile,
  skillsFileSchema,
} from '@marimo/protocol';
import type {StoredSkill} from '@marimo/protocol';

import {
  assertWritable,
  DocumentTooNewError,
  readVersionedDocument,
} from '@marimo/agent';

export interface SkillStoreOptions {
  file: string;
  /**
   * Names the app already ships, which a saved skill may not take.
   *
   * Passed in rather than imported, because the names live in the agent package
   * and this store is about the file. The rule belongs here anyway: the file is
   * the namespace, and the system prompt is the other place a name is a heading.
   * A saved `memory` would be filtered out of every prompt rather than shadowing
   * anything — `composeInstruction` gives a built-in name to the built-in — so
   * the refusal is what turns "your skill is carried but never sent" into a
   * sentence the user can act on.
   */
  reserved?: readonly string[];
}

/** Thrown when a draft takes a name the app already ships. */
export class ReservedSkillNameError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is the name of a skill the app ships. Save this one under a different name.`,
    );
    this.name = 'ReservedSkillNameError';
  }
}

/**
 * Thrown when a draft is too long to carry in every request.
 *
 * Refused here rather than only in the editor and in `save_skill`, because the
 * limit is a property of the file: this text is prepended to the system prompt on
 * every turn, and a skill long enough to crowd out the conversation is a cost the
 * user pays without seeing the bill however it got written.
 */
export class SkillTooLongError extends Error {
  constructor(length: number) {
    super(
      `Those instructions are ${length} characters, over the ${SKILL_INSTRUCTIONS_MAX}-character limit for a skill.`,
    );
    this.name = 'SkillTooLongError';
  }
}

/**
 * Thrown when a rename would land on a name another skill already holds.
 *
 * A refusal rather than a merge: `enabledSkills` is a list of names, so two
 * skills with one name are two procedures behind one checkbox.
 */
export class DuplicateSkillNameError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is already the name of another skill. Pick a different name, or edit that one instead.`,
    );
    this.name = 'DuplicateSkillNameError';
  }
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

export class SkillStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SkillStoreOptions) {}

  /**
   * The stored skills, or none.
   *
   * A missing or truncated file reads as empty rather than throwing: the user
   * cannot act on a corrupt JSON file, and refusing to open the app over one
   * would cost them every other setting.
   *
   * What it does *not* do is swallow a file from a newer build. Reading one as
   * empty and then saving would overwrite it with this build's format, and the
   * user's own procedures would be gone with nothing to point at. It throws, and
   * `save` refuses before writing.
   */
  async load(): Promise<StoredSkill[]> {
    const read = await readVersionedDocument(this.options.file, {
      label: 'The skills file',
    });
    if (read.state === 'too-new') {
      throw new DocumentTooNewError(
        'The skills file',
        read.found,
        read.supported,
      );
    }
    if (read.state === 'migrated') {
      /*
       * Written back straight away, so the upgrade is not repeated on every
       * launch and a user who never edits anything still reaches the newer
       * format.
       */
      const migrated = skillsFileSchema.safeParse(read.document);
      if (migrated.success) {
        await this.write(migrated.data.skills);
        return migrated.data.skills;
      }
    }
    const parsed = skillsFileSchema.safeParse(
      read.state === 'current' ? read.document : undefined,
    );
    return parsed.success ? parsed.data.skills : emptySkillsFile().skills;
  }

  /**
   * Saves one skill, replacing any with the same name.
   *
   * The name is normalised here rather than trusted: it becomes part of the
   * system prompt's `## heading` and a member of a profile's `enabledSkills`, so
   * "Weekly Inbox Triage" and "weekly-inbox-triage" have to be the same skill.
   *
   * `id` names the skill being edited, and it is the only way to rename one: the
   * store's identity is the name, so a save under a different name would
   * otherwise insert a second skill rather than move the first. A save by name
   * and a save by id are the same operation from the caller's side — pass the id
   * you were handed and the skill keeps it, along with its `createdAt`.
   */
  async save(
    draft: SkillDraft,
    id?: string,
  ): Promise<{skill: StoredSkill; updated: boolean}> {
    return await this.withLock(async () => {
      const name = normaliseName(draft.name);
      if (this.options.reserved?.includes(name)) {
        throw new ReservedSkillNameError(name);
      }
      const instructions = draft.instructions.trim();
      if (instructions.length > SKILL_INSTRUCTIONS_MAX) {
        throw new SkillTooLongError(instructions.length);
      }
      const current = await this.load();
      const byName = current.find((skill) => skill.name === name);
      const byId =
        id === undefined ? undefined : current.find((skill) => skill.id === id);
      /*
       * Two skills may not share a name, because `enabledSkills` refers to them
       * by name: a profile would have one checkbox for two procedures. Renaming
       * onto a name that is already taken is refused rather than merged, because
       * silently discarding the other skill is a worse answer than saying so —
       * and the one that would be discarded is the one the user is not looking
       * at.
       */
      if (byId && byName && byName.id !== byId.id) {
        throw new DuplicateSkillNameError(name);
      }
      // An id that no longer names anything is not an error: the file may have
      // changed under an open dialog, and the save becomes an insert.
      const existing = byId ?? byName;
      const skill: StoredSkill = {
        // A save that replaces keeps the original id, so anything holding one —
        // the Settings list, a window with the dialog open — still names the same
        // skill afterwards.
        id: existing?.id ?? randomUUID(),
        name,
        description: draft.description.trim(),
        instructions,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      const skills = existing
        ? current.map((entry) => (entry.id === existing.id ? skill : entry))
        : [...current, skill];
      await this.write(skills);
      return {skill, updated: existing !== undefined};
    });
  }

  /** Removes one skill by id, and answers with what is left. */
  async remove(skillId: string): Promise<StoredSkill[]> {
    return await this.withLock(async () => {
      const current = await this.load();
      const skills = current.filter((skill) => skill.id !== skillId);
      if (skills.length !== current.length) {
        await this.write(skills);
      }
      return skills;
    });
  }

  private async write(skills: StoredSkill[]): Promise<void> {
    /*
     * Refused before anything is written. A lenient read plus a write is how a
     * user's data disappears, and a newer file is exactly the case where the
     * read had to be lenient.
     */
    await assertWritable(this.options.file, {label: 'The skills file'});
    await mkdir(dirname(this.options.file), {recursive: true});
    // Written to a sibling and renamed, so a crash mid-write cannot leave half a
    // file where the user's skills were.
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({version: 1, skills}, null, 2)}\n`,
      'utf8',
    );
    await rename(temporary, this.options.file);
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }
}

/**
 * A name that can be a heading and a list entry.
 *
 * Anything that is not a letter, a digit or a separator becomes a dash, runs of
 * dashes collapse, and the result is lower-cased — so a model that answers
 * "Weekly Inbox Triage" and one that answers "weekly_inbox_triage" produce the
 * same skill rather than two.
 */
export function normaliseName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  // A name that was entirely punctuation would be a blank heading; the tool
  // refuses one before this is reached, and this is the backstop.
  return name.length > 0 ? name : 'skill';
}
