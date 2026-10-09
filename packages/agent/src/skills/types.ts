/**
 * A skill is a named block of prompt text the agent always carries.
 *
 * Skills are TypeScript modules rather than on-disk `SKILL.md` folders on
 * purpose: ADK's skill loader renders an `<available_skills>` catalogue for a
 * model that loads a skill on demand, which needs a skill-loading tool and
 * bundled assets in a packaged build. These skills are small enough to sit
 * directly in the system prompt, so they are composed in rather than advertised.
 */
export interface Skill {
  name: string;
  /** One line telling the model what the skill is for. */
  description: string;
  /** The instructions themselves. */
  instructions: string;
  /**
   * The tools this skill's guidance is about, if it is about any.
   *
   * A capability skill is carried only when the profile grants at least one of
   * these. Without that, guidance about `search_knowledge_base` reaches an agent
   * whose profile has switched search off, which is the failure invariant 9 is
   * named after: a capability the user turned off is absent, not *described*.
   *
   * Absent means the skill mentions no tool and is therefore always carried —
   * that is the operating protocol, which is about how to work rather than what
   * to work with.
   *
   * A user's own skill has no tools: it is selected by name alone.
   */
  tools?: readonly string[];
}
