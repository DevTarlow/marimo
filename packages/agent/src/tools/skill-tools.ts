/**
 * The one tool that writes a skill.
 *
 * It exists for `/learn`: the user points at a conversation and asks the agent to
 * turn the repeatable part of it into something it can do again, and the agent —
 * which already has that conversation in its context — writes the procedure down.
 * Nothing else in the app can put text into the system prompt, which is why this
 * is a tool with an approval gate rather than a settings field.
 *
 * It is deliberately **not** part of the per-profile tool selection. Every other
 * tool is a capability the user grants; this one is the mechanism behind a
 * command the user types, and a profile that predates the command must still be
 * able to run it. It is therefore absent from `profiles.catalog` — there is no
 * checkbox, because there is nothing to switch off.
 *
 * The gate is not ceremony. Everything else the agent writes is data it will read
 * again; this is prompt text that changes how it works, so the card is the user's
 * only chance to read what they are about to start following.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {SKILL_INSTRUCTIONS_MAX} from '@marimo/protocol';

/** What the tool needs from whoever owns the skills file. */
export interface SkillService {
  /**
   * Stores the skill and switches it on for the agent that asked.
   *
   * One call rather than "save" plus "enable": a skill saved but not enabled is
   * invisible, and the whole point of asking for it is to use it. `updated` says
   * whether this replaced a skill of the same name, which the model repeats back
   * so the user knows their earlier version was not kept.
   */
  save(input: {
    name: string;
    description: string;
    instructions: string;
  }): Promise<{name: string; updated: boolean}>;
}

export interface SkillToolContext {
  skills: SkillService;
}

/**
 * The longest instructions worth putting in a prompt.
 *
 * Re-exported from the protocol rather than declared here: the Settings editor
 * enforces the same number while the user types, and it may not import this
 * package. The store refuses an over-long skill as well, so the limit holds
 * whether the text arrives from a turn, from the editor or from a hand-edited
 * file.
 */
export {SKILL_INSTRUCTIONS_MAX};

export function createSaveSkillTool(context: SkillToolContext) {
  return new FunctionTool({
    name: 'save_skill',
    description:
      'Save a reusable skill and switch it on for this agent. A skill is a ' +
      'short set of instructions that goes into your system prompt on every ' +
      'later request, so it changes how you work rather than what you know. Use ' +
      'it when the user runs /learn, or when they ask you to remember a way of ' +
      'doing something and use it from now on. `name` is a short kebab-case ' +
      'label ("weekly-inbox-triage"); saving a name that already exists replaces ' +
      'that skill. `description` is one line for the list in Settings. ' +
      '`instructions` is the procedure itself, in the imperative, naming the ' +
      'tools it uses. The user has to approve it before it is saved.',
    parameters: z.object({
      name: z
        .string()
        .describe('Short kebab-case name, e.g. "weekly-inbox-triage".'),
      description: z
        .string()
        .describe('One line saying what the skill is for.'),
      instructions: z
        .string()
        .describe(
          'The steps themselves, written as instructions to yourself. Keep it ' +
            'short enough to be worth carrying in every request.',
        ),
    }),
    requireConfirmation: true,
    execute: async ({name, description, instructions}) => {
      if (instructions.trim().length === 0) {
        return 'Nothing to save: the instructions were empty.';
      }
      if (instructions.length > SKILL_INSTRUCTIONS_MAX) {
        // Refused rather than stored: this text is prepended to every request,
        // and a skill long enough to crowd out the conversation is a cost the
        // user pays on every turn without seeing the bill.
        return (
          `Those instructions are ${instructions.length} characters, over the ` +
          `${SKILL_INSTRUCTIONS_MAX}-character limit for a skill. Rewrite them ` +
          'as the steps that matter, without the background.'
        );
      }
      try {
        const saved = await context.skills.save({
          name,
          description,
          instructions,
        });
        return saved.updated
          ? `Replaced the skill "${saved.name}" and left it switched on. It applies from your next request.`
          : `Saved the skill "${saved.name}" and switched it on. It applies from your next request.`;
      } catch (error) {
        return `Could not save the skill: ${describe(error)}`;
      }
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
