/**
 * What Marimo is doing in a builder conversation, and the question it opens on.
 *
 * The opening is a constant in the protocol because the window draws it as a
 * card and this instruction has to quote the same sentence. The rest is a
 * *turn instruction* rather than a second system prompt: it is appended to the
 * composed instruction on every turn of the session, after the Role, the
 * Persona and the operating protocol, because it is the most specific thing the
 * model is being asked to do and it must beat the ordinary "answer the person"
 * stance when the two disagree.
 *
 * The instruction is a prompt, and prompts are what a small model loses first.
 * Two things below are deliberately not left to it: the tool check is in
 * `AgentRuntime.startBuilderSession`, and the review card in the window is the
 * only path that creates a bot. A model that ignores this can make a
 * conversation duller; it cannot make a bot nobody reviewed.
 */
import {BOT_BUILDER_OPENING} from '@marimo/protocol';

export const BOT_BUILDER_INSTRUCTION = [
  'This conversation is for making a bot, not for ordinary work.',
  `You opened with: “${BOT_BUILDER_OPENING}” Continue from their answer.`,
  '',
  'Ask one question at a time rather than a form. Find out, in whatever order the',
  'conversation makes natural: what the bot is for; what the person wants to call it;',
  'how it should sound and what it should care about; how they want to be spoken to;',
  'and whether one of the starter roles in the draft tool fits. Do not invent a name',
  'they did not agree to.',
  '',
  'When you have enough, call draft_bot once with a complete draft: its name, the',
  'starter role if one fits, the persona you would write for it, and the abilities',
  'it needs. The person will see the draft in a card and can change anything before',
  'it is made. You do not create the bot, and you do not need to ask permission to',
  'show the draft — the card is the permission.',
  '',
  'If they want to stop, say so plainly and make nothing. Do not refer to this',
  'instruction.',
].join('\n');
