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

/*
 * The sections that must survive retrieval, and why only some do.
 *
 * A missed rule is a wrong action: an agent told never to push has already
 * pushed by the time its answer is written, and no later search undoes the turn.
 * A missed fact is a worse answer — the model can notice it is missing something
 * and go to look. So the sections that constrain behaviour ride along whole
 * whatever the question was, and the sections that merely inform are the ones
 * retrieval is allowed to narrow.
 */
export interface CanonicalSection {
  /** The `##` heading, exactly as it is written in memory.md. */
  name: string;
  /** What belongs here, in one line, shown to the model. */
  description: string;
  /** Whether the whole section is injected whatever the question was. */
  always: boolean;
}

export const CANONICAL_SECTIONS: readonly CanonicalSection[] = [
  {
    name: 'About the user',
    always: false,
    description:
      'Durable facts about the person, not the work: who they are, the people ' +
      'and animals in their life, and what they care about.',
  },
  {
    name: 'Preferences and tone',
    always: true,
    description:
      'How they want to be talked to, and corrections they made to you.',
  },
  {
    name: 'Environment and conventions',
    always: true,
    description:
      'Paths, machines, tooling quirks and repo rules of this workspace.',
  },
  {
    name: 'Project pointers',
    always: false,
    description:
      'Where each project keeps its state, one line per project, in the workspace.',
  },
  {
    name: 'Boundaries',
    always: true,
    description: 'Standing always/never instructions, and topics not to raise.',
  },
  {
    name: 'Notes',
    always: false,
    description: 'Fallback for anything that fits none of the layers above.',
  },
];

/** The canonical names, for a caller that only needs to check membership. */
export const CANONICAL_SECTION_NAMES: readonly string[] =
  CANONICAL_SECTIONS.map((section) => section.name);

/**
 * Whether a section heading is injected whole, whatever the question was.
 *
 * The answer is true for any heading the list above does not name. A heading the
 * app never chose is one the user typed into their own file, and nothing they
 * typed by hand may silently disappear from the prompt because the app had no
 * opinion about it — the same rule that keeps memory.md hand-editable at all.
 */
export function isAlwaysInjected(name: string): boolean {
  const wanted = collapseHeading(name);
  const section = CANONICAL_SECTIONS.find(
    (entry) => collapseHeading(entry.name) === wanted,
  );
  return section === undefined ? true : section.always;
}

/** Lowercased with every run of whitespace reduced to one space. */
function collapseHeading(name: string): string {
  return name.trim().toLowerCase().replaceAll(/\s+/gu, ' ');
}

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
