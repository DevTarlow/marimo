/**
 * The named sections memory.md is written into.
 *
 * Memory is one file injected into every future system prompt, and until now it
 * was also one undifferentiated pile of bullets. That works until two facts of
 * different kinds meet: a tone preference is relevant in every conversation and
 * changes about once a year, while a piece of project state is relevant only
 * inside that project and can be stale by the next session. Mixed together, the
 * model cannot tell which is which, and deduplicating a file means reading all
 * of it.
 *
 * These names are **guidance, not a whitelist.** memory.md stays plain markdown
 * a user can edit by hand, so a section nobody here named still works: the merge
 * logic is line-based and matches headings by text. What the list buys is a
 * default the model picks deliberately instead of falling through to `Notes`,
 * and a shared vocabulary the review prompt can route proposals by.
 *
 * Adding a section is cheap, so the set is kept small on purpose — every entry
 * is a decision the model has to make on every write.
 */

export interface CanonicalSection {
  /** The `##` heading, exactly as it is written in memory.md. */
  name: string;
  /** What belongs here, in one line, shown to the model. */
  description: string;
}

export const CANONICAL_SECTIONS: readonly CanonicalSection[] = [
  {
    name: 'About the user',
    description:
      'Durable facts about the person, not the work: name, timezone, role.',
  },
  {
    name: 'Preferences and tone',
    description:
      'How they want to be talked to, and corrections they made to you.',
  },
  {
    name: 'Environment and conventions',
    description:
      'Paths, machines, tooling quirks and repo rules of this workspace.',
  },
  {
    name: 'Project pointers',
    description:
      'Where each project keeps its state, one line per project, in the workspace.',
  },
  {
    name: 'Boundaries',
    description: 'Standing always/never instructions, and topics not to raise.',
  },
  {
    name: 'Notes',
    description: 'Fallback for anything that fits none of the layers above.',
  },
];

/** The canonical names, for a caller that only needs to check membership. */
export const CANONICAL_SECTION_NAMES: readonly string[] =
  CANONICAL_SECTIONS.map((section) => section.name);

/**
 * The list as prompt text, for the memory skill and the review prompt.
 *
 * One renderer rather than two copies, because the two prompts disagreeing
 * about what "Boundaries" means is how a fact lands in one layer when said
 * aloud and another when proposed.
 */
export function renderSectionGuide(): string {
  return CANONICAL_SECTIONS.map(
    (section) => `- ${section.name}: ${section.description}`,
  ).join('\n');
}
