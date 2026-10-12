/**
 * The named sections memory.md is written into.
 *
 * The vocabulary is only worth having if the prompts actually carry it, so this
 * pins the list against both the memory skill and the review prompt — the two
 * places a fact's layer is decided — rather than testing the constant alone.
 */
import {describe, expect, it} from 'vitest';

import {DEFAULT_SECTION} from './memory-store.js';
import {
  MAX_SECTION_CHARS,
  PROPOSAL_EXAMPLE_SECTION,
  reviewPrompt,
} from './review.js';
import {
  CANONICAL_SECTIONS,
  CANONICAL_SECTION_NAMES,
  describeScope,
  renderSectionGuide,
  scopeForSection,
} from './sections.js';
import {memorySkill} from '../skills/memory-skill.js';

describe('the section vocabulary', () => {
  it('describes every section', () => {
    expect(CANONICAL_SECTIONS.length).toBeGreaterThan(0);
    for (const section of CANONICAL_SECTIONS) {
      expect(section.name.trim().length).toBeGreaterThan(0);
      expect(section.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('never ships the same section twice', () => {
    expect(new Set(CANONICAL_SECTION_NAMES).size).toBe(
      CANONICAL_SECTIONS.length,
    );
  });

  /*
   * The proposal schema caps `section`, and the cap is derived from this list —
   * so a name that outgrew it would be a layer the reviewer could name in the
   * prompt and still have rejected as malformed. The bound only grows; the
   * point of the test is that nothing here is silently dropped.
   */
  it('keeps every name inside the proposal cap', () => {
    for (const section of CANONICAL_SECTIONS) {
      expect(section.name.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    }
  });

  /*
   * `DEFAULT_SECTION` is what an update without a section lands in. If it ever
   * drifted off this list, the fallback would be a layer the model was never
   * shown and cannot pick on purpose.
   */
  it('keeps the fallback section one of the named ones', () => {
    expect(CANONICAL_SECTION_NAMES).toContain(DEFAULT_SECTION);
  });

  it('renders each name with its description and its scope', () => {
    const guide = renderSectionGuide();
    for (const section of CANONICAL_SECTIONS) {
      expect(guide).toContain(
        `- ${section.name} (${describeScope(section.scope)}): ${section.description}`,
      );
    }
  });

  /*
   * The scope decides which of the two memory files a fact is written into, and
   * it is the one property of a section that is invisible in the prompt unless
   * the renderer puts it there. A section whose scope silently became
   * `workspace` would be a fact about the person remembered only while one
   * folder is open — which is the failure the split exists to fix.
   */
  it("puts the person's layers in the person file and the project's in the folder", () => {
    expect(scopeForSection('About the user')).toBe('person');
    expect(scopeForSection('Preferences and tone')).toBe('person');
    expect(scopeForSection('Boundaries')).toBe('person');
    expect(scopeForSection('Environment and conventions')).toBe('workspace');
    expect(scopeForSection('Project pointers')).toBe('workspace');
    expect(scopeForSection('Notes')).toBe('workspace');
  });

  it('matches a section name the way the store matches a heading', () => {
    expect(scopeForSection('  preferences   AND tone ')).toBe('person');
  });

  /*
   * A heading the app never named stays in the workspace file, which is where it
   * already is. The alternative — treating an unknown heading as person-level —
   * would silently relocate a section the user typed by hand.
   */
  it('leaves a heading the app never named where it already is', () => {
    expect(scopeForSection('Recipes I like')).toBe('workspace');
  });

  it('keeps an always-injected layer out of the always-only reading', () => {
    // The two axes are independent: a project rule rides along whole *and* lives
    // in the folder, and collapsing them would put one repo's conventions in
    // every other repo's prompt.
    const environment = CANONICAL_SECTIONS.find(
      (section) => section.name === 'Environment and conventions',
    );
    expect(environment?.always).toBe(true);
    expect(environment?.scope).toBe('workspace');
  });
});

describe('where the vocabulary reaches the model', () => {
  it('names every section in the memory skill', () => {
    for (const section of CANONICAL_SECTIONS) {
      expect(memorySkill.instructions).toContain(section.name);
    }
  });

  it('names every section in the review prompt', () => {
    const prompt = reviewPrompt('USER: anything');
    for (const section of CANONICAL_SECTIONS) {
      expect(prompt).toContain(section.name);
    }
  });

  /*
   * A model copies the shape of the example, so an example written into `Notes`
   * would undo the layering the prompt just asked for.
   */
  it('shows the review prompt an example in a named layer, not the fallback', () => {
    expect(CANONICAL_SECTION_NAMES).toContain(PROPOSAL_EXAMPLE_SECTION);
    expect(PROPOSAL_EXAMPLE_SECTION).not.toBe(DEFAULT_SECTION);
    expect(reviewPrompt('USER: anything')).toContain(
      `{"proposals":[{"section":"${PROPOSAL_EXAMPLE_SECTION}"`,
    );
  });

  /*
   * Arbitrary sections must keep working: memory.md is a user-editable file,
   * and a model that read the list as a whitelist would refuse to write into a
   * heading the user added by hand.
   */
  it('says the list is guidance rather than a whitelist', () => {
    expect(reviewPrompt('USER: anything')).toContain('not the only ones');
    expect(memorySkill.instructions).toContain('not a rule');
  });

  /*
   * The rule that keeps the volatile half out of the prompt: project state
   * lives in the workspace and memory keeps one pointer line to it. Without
   * this the layer fills with status that is stale by the next session, which
   * is the failure the layering exists to prevent.
   */
  it('tells the model to point at project state rather than copy it', () => {
    expect(memorySkill.instructions).toContain('one pointer line per');
    expect(memorySkill.instructions).toContain('Never copy the state itself');
    expect(memorySkill.instructions).toContain('Do not invent a handoff file');
    expect(renderSectionGuide()).toContain('one line per project');
  });

  /*
   * The failure this pins down, from a real conversation: told that the user's
   * dog was called Sunshine, the agent offered to search the workspace for a
   * dog's name and recorded nothing. The enumeration of what memory is *for* had
   * no room in it for a fact about the user's life that is not about their work,
   * and the layer meant to hold it read like a CRM record.
   */
  it("gives a fact about the user's life somewhere to go", () => {
    expect(renderSectionGuide()).toContain(
      'the people and animals in their life',
    );
    expect(memorySkill.instructions).toContain(
      'the people and animals in their life',
    );
    expect(memorySkill.instructions).toContain(
      'store it, and respond to the thing',
    );
  });

  /*
   * The same conversation wrote the agent's own purpose and tool list into
   * `Project pointers`, where it sits in every future prompt going stale.
   */
  it("keeps the agent's own description out of memory", () => {
    expect(memorySkill.instructions).toContain(
      'Never store facts about yourself',
    );
  });
});
