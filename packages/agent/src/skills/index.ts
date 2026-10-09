/**
 * The composed system instruction.
 *
 * The user's prompt says who the agent is; this module says how it works and
 * what it currently remembers. The protocol and the memory block are appended by
 * the agent layer rather than stored in settings, so a prompt saved by an older
 * build still gets both.
 *
 * What is *in* the prompt is a property of the profile's tools, not of a second
 * list of switches. The operating protocol is unconditional, because the app's
 * own rules ship with the app; a capability skill rides along with the tools it
 * describes. That leaves `enabledSkills` naming the user's own skills and
 * nothing else, which is the one thing it can honestly mean.
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

/**
 * Names the app ships, which a user's skill may never take.
 *
 * Checked whatever the profile's tools are, rather than only against the skills
 * that happen to be carried: a profile can change between turns, and a saved
 * `memory` that was hidden while the memory tools were off would reappear as a
 * second `## memory` heading the moment they were switched back on.
 */
const BUILT_IN_NAMES: ReadonlySet<string> = new Set(
  SKILLS.map((skill) => skill.name),
);

export interface ComposeInstructionOptions {
  /** The profile's identity: persona and formatting. */
  base: string;
  /** Current memory.md contents, or `''` when there is none. */
  memory: string;
  /**
   * Prompt text for this turn only, when there is any.
   *
   * Appended rather than folded into `base`, because the two have different
   * lifetimes: the identity is the profile and outlives the turn, and this is
   * whatever the surface that asked wanted — the desktop companion asking for a
   * shorter answer than the window. Being last is the point: an instruction that
   * arrives after the persona is the one a model follows where the two disagree.
   */
  instruction?: string;
  /**
   * Tool names this profile may use, or absent for a caller with no profile
   * concept at all.
   *
   * Absent is not "no tools" — it is "unrestricted", which is how a test or a
   * future CLI gets every skill. An empty array is a profile that can do nothing,
   * and it carries the protocol and none of the capability skills.
   */
  tools?: readonly string[];
  /**
   * Names of the user's own skills to carry, from `/learn`.
   *
   * Absent means all of them, which is what a caller with no profile concept
   * wants; an empty array means this profile carries none of them. The built-in
   * skills are not named here and cannot be selected here — they follow `tools`.
   */
  userSkillNames?: string[];
  /**
   * The user's skills themselves, for `userSkillNames` to select from.
   *
   * Absent means the app has none, which is what a test with no skill store
   * wants. These are definitions, not a selection: which of them are carried is
   * `userSkillNames`.
   */
  userSkills?: readonly Skill[];
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
  instruction,
  tools,
  userSkillNames,
  userSkills,
}: ComposeInstructionOptions): string {
  const reachable = SKILLS.filter((skill) => canCarry(skill, tools));
  const reasoning = reachable.find(
    (skill) => skill.name === reasoningSkill.name,
  );
  const memory = reachable.find((skill) => skill.name === memorySkill.name);
  const capabilitySkills = [
    ...reachable.filter((skill) => skill.name !== reasoningSkill.name),
    ...userSkillsFor(userSkillNames, userSkills ?? []),
  ];
  const memoryBody =
    memoryText.trim().length > 0 ? memoryText.trim() : EMPTY_MEMORY;

  const sections = [
    base.trim(),
    reasoning ? `# Operating protocol\n\n${reasoning.instructions}` : '',
    capabilitySkills.length > 0
      ? `# Skills\n\n${renderSkills(capabilitySkills)}`
      : '',
    // Only an agent that can act on memory is given it: the block is otherwise a
    // set of facts from a system this profile was told to ignore, and an
    // instruction to use tools it may not have. It follows the memory skill,
    // which follows the memory tools.
    memory ? `# Long-term memory (memory.md)\n\n${memoryBody}` : '',
    // Last, and after everything else that has an opinion: this is the surface
    // the question was asked at, and it is the most specific instruction in the
    // prompt.
    instruction?.trim() ?? '',
  ];

  return sections
    .filter((section) => section.length > 0)
    .join('\n\n')
    .concat('\n');
}

/**
 * Whether a skill about tools belongs in this profile's prompt.
 *
 * "At least one" rather than "all": a capability skill is one piece of guidance
 * covering a group of tools, and requiring the whole group would drop the
 * workspace-first search advice from every profile that has not also granted an
 * arbitrary-URL fetch. Absent `tools` is the unrestricted caller, which gets
 * everything.
 */
function canCarry(skill: Skill, tools?: readonly string[]): boolean {
  return (
    skill.tools === undefined ||
    tools === undefined ||
    skill.tools.some((name) => tools.includes(name))
  );
}

/**
 * The user's skills this profile carries, in the order they were written.
 *
 * Filtered by `userSkillNames` rather than passing everything: a skill is prompt
 * text carried on every single request, so one the user switched off is a cost
 * they have already declined to pay.
 */
function userSkillsFor(
  names: string[] | undefined,
  userSkills: readonly Skill[],
): Skill[] {
  const allowed = names === undefined ? undefined : new Set(names);
  return dedupeByName(
    userSkills.filter((skill) => !BUILT_IN_NAMES.has(skill.name)),
  ).filter((skill) => allowed === undefined || allowed.has(skill.name));
}

/**
 * One skill per name, first one wins.
 *
 * Two `## memory` headings in one prompt is the sort of thing a model reads as
 * two conflicting instructions. `save_skill` refuses a built-in name and the
 * store refuses a duplicate, so this is not the guard that matters — it is the
 * backstop for a hand-edited `skills.json`, where there is no one left to refuse
 * anything.
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
