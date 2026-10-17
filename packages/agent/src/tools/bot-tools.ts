/**
 * Drafting a bot for the person to review.
 *
 * This tool does not create anything, and that is the whole design. A bot is a
 * profile, a grant and a name the person will live with; letting a model write
 * one directly would make the card in the window a receipt rather than a
 * decision. So the tool's only job is to say the draft is complete enough to
 * show: the window draws it from the call's own arguments, the person changes
 * what they like, and *they* press Create.
 *
 * The division is also what keeps the tool safe to grant. A profile with
 * `draft_bot` cannot make a bot the person has not seen, cannot change an
 * existing one, and cannot write a file. It is a proposal shaped like a tool
 * call, which is exactly what the transcript is for.
 *
 * Nothing here throws. An unknown starter role or a missing name is a sentence
 * the model can act on; an exception would end the user's turn and turn "ask one
 * more question" into "your request failed", the same rule `ask_agent` follows.
 */
import {FunctionTool} from '@google/adk';

import {
  BOT_DRAFT_PERSONA_MAX,
  BOT_TEMPLATES,
  botDraftSchema,
  botTemplateById,
  DRAFT_BOT_TOOL,
} from '@marimo/protocol';

/** The starter roles, as a line the model can choose from. */
const TEMPLATE_CHOICES = BOT_TEMPLATES.map(
  (template) => `"${template.id}" (${template.label}: ${template.blurb})`,
).join('; ');

export function createDraftBotTool() {
  return new FunctionTool({
    name: DRAFT_BOT_TOOL,
    description:
      'Draft a new bot for the person to review. This does not create the bot: ' +
      'the window shows the draft in a card, the person edits it, and they ' +
      'press Create. Use it only once you have talked through what the bot is ' +
      'for, what to call it, how it should sound and how the person wants to be ' +
      'spoken to. A starter role is a shortcut, not a requirement: ' +
      `${TEMPLATE_CHOICES}. If none fits, omit templateId and write a persona ` +
      'that says what it is for. Omit tools to use the starter role’s default. ' +
      'Do not call it twice for the same bot; if the person wants changes, tell ' +
      'them to edit the card.',
    parameters: botDraftSchema,
    execute: async (draft) => {
      const parsed = botDraftSchema.safeParse(draft);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return (
          'That draft is not ready to show: ' +
          `${first?.path.join('.') || 'a field'} ${first?.message ?? 'is wrong'}. ` +
          'Ask the person for what is missing rather than guessing.'
        );
      }
      const value = parsed.data;
      if (value.templateId !== undefined && botTemplateById(value.templateId) === undefined) {
        return (
          `There is no starter role called "${value.templateId}". Choose one of ` +
          `${TEMPLATE_CHOICES}, or omit templateId for a custom bot.`
        );
      }
      if (value.persona !== undefined && value.persona.length > BOT_DRAFT_PERSONA_MAX) {
        return (
          `That persona is ${value.persona.length} characters, over the ` +
          `${BOT_DRAFT_PERSONA_MAX}-character limit. Keep the part that changes ` +
          'how it behaves and leave the rest to the card.'
        );
      }
      const name = value.name ?? 'this bot';
      return (
        `Draft shown to the person: ${name}. They can change the name, the ` +
        'persona and the abilities, and they press Create — you do not create ' +
        'it. Stop here and wait for them.'
      );
    },
  });
}
