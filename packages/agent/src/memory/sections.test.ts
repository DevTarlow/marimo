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
  renderSectionGuide,
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

  it('renders each name with its description', () => {
    const guide = renderSectionGuide();
    for (const section of CANONICAL_SECTIONS) {
      expect(guide).toContain(`- ${section.name}: ${section.description}`);
    }
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
});
