/**
 * The composed system instruction.
 *
 * The user's prompt says who the agent is; this module says how it works and
 * what it currently remembers. The protocol and the memory block are appended by
 * the agent layer rather than stored in settings, so a prompt saved by an older
 * build still gets both.
 */
import {knowledgeSkill} from './knowledge-skill.js';
import {memorySkill} from './memory-skill.js';
import {reasoningSkill} from './reasoning-skill.js';
import type {Skill} from './types.js';

export {knowledgeSkill, memorySkill, reasoningSkill};
export type {Skill};

/** Every installed skill; `reasoning` renders as the operating protocol. */
export const SKILLS: readonly Skill[] = [
  reasoningSkill,
  memorySkill,
  knowledgeSkill,
];

export interface ComposeInstructionOptions {
  /** The profile's identity: persona and formatting. */
  base: string;
  /** Current memory.md contents, or `''` when there is none. */
  memory: string;
  /**
   * Skill names this profile carries. Absent means all of them; an empty array
   * means the profile deliberately carries none, which drops the operating
   * protocol, the skills and the memory block — an agent that was not given the
   * memory skill must not be told to use it, nor have facts injected for it.
   */
  skills?: string[];
  /**
   * Skills the user wrote, from `/learn`.
   *
   * They are selected by the same names as the built-in ones — one list of
   * checkboxes in Settings, one `enabledSkills` on the profile — so a saved skill
   * is switched on and off like any other. Absent means the app has none, which
   * is what a test with no skill store wants.
   */
  extraSkills?: readonly Skill[];
}

const EMPTY_MEMORY =
  '(no memory yet — use update_memory to record facts worth keeping across sessions)';

/** Renders skills as `## name` blocks, in the order given. */
export function renderSkills(skills: readonly Skill[]): string {
  return skills
    .map(
      (skill) =>
        `## ${skill.name}\n${skill.description}\n\n${skill.instructions}`,
    )
    .join('\n\n');
}

export function composeInstruction({
  base,
  memory: memoryText,
  skills,
  extraSkills,
}: ComposeInstructionOptions): string {
  const selected = selectSkills(skills, extraSkills ?? []);
  const reasoning = selected.find(
    (skill) => skill.name === reasoningSkill.name,
  );
  const memory = selected.find((skill) => skill.name === memorySkill.name);
  const capabilitySkills = selected.filter(
    (skill) => skill.name !== reasoningSkill.name,
  );
  const memoryBody =
    memoryText.trim().length > 0 ? memoryText.trim() : EMPTY_MEMORY;

  const sections = [
    base.trim(),
    reasoning ? `# Operating protocol\n\n${reasoning.instructions}` : '',
    capabilitySkills.length > 0
      ? `# Skills\n\n${renderSkills(capabilitySkills)}`
      : '',
    // Only an agent that carries the memory skill gets its memory: the block is
    // otherwise a set of facts from a system this profile was told to ignore,
    // and an instruction to use tools it may not have.
    memory ? `# Long-term memory (memory.md)\n\n${memoryBody}` : '',
  ];

  return sections
    .filter((section) => section.length > 0)
    .join('\n\n')
    .concat('\n');
}

/**
 * The skills a profile carries, in the canonical order and no other.
 *
 * The user's own come last and in the order they were written: the built-ins are
 * the operating protocol and the app's own capabilities, and a skill made from a
 * conversation is a procedure layered on top of them rather than a replacement
 * for any of it.
 *
 * `names === undefined` means every skill, which is what a caller with no profile
 * concept wants; it includes the user's, because "all of them" has to mean all of
 * them for a saved skill to be usable at all.
 */
export function selectSkills(
  names?: string[],
  extra: readonly Skill[] = [],
): Skill[] {
  const available = dedupeByName([...SKILLS, ...extra]);
  if (names === undefined) {
    return available;
  }
  const allowed = new Set(names);
  return available.filter((skill) => allowed.has(skill.name));
}

/**
 * One skill per name, first one wins.
 *
 * Two `## memory` headings in one prompt is the sort of thing a model reads as
 * two conflicting instructions, and a saved skill is named by the same string the
 * built-ins are. `save_skill` refuses a name the app already ships, so this is
 * not the guard that matters — it is the backstop for a hand-edited
 * `skills.json`, where there is no one left to refuse anything.
 */
function dedupeByName(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.name)) {
      return false;
    }
    seen.add(skill.name);
    return true;
  });
}
