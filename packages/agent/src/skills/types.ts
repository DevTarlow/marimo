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
}
