/**
 * What the pet asks for, in words.
 *
 * The companion has no conversation of its own — that is the point of it, and it
 * is why this cannot be a profile or a session setting: the same thread is read
 * in the window and typed into at the moss, so *how long the answer should be*
 * is a property of where the question was asked rather than of the conversation.
 * It travels with the turn, and is gone again by the next one.
 *
 * A function here rather than a sentence inside the companion window, because
 * this is prompt text: it belongs beside the config it ends up in, where a test
 * can assert on it without a browser.
 */
import type {CompanionAnswerLength} from '@marimo/protocol';

/**
 * One instruction per length, written out rather than generated.
 *
 * The three are not one sentence with a word swapped. `brief` has to say what to
 * leave *out* — a model told only "be brief" answers briefly and then adds the
 * three paragraphs of caveats it was trained to add — while `detailed` has to
 * say that the pet is not the wrong place to be thorough, or the identity's own
 * "prefer a short, direct answer" wins.
 */
const LENGTHS: Record<CompanionAnswerLength, string> = {
  brief: [
    '# Where this question was asked',
    '',
    'This came from the desktop companion — a small floating window over whatever',
    'the user is working in — so the answer has to fit in a few lines.',
    '',
    '- Lead with the answer. One or two sentences if that is enough.',
    '- No preamble, no restating the question, no summary at the end.',
    '- Trim what the user did not ask for: no alternatives they did not ask about,',
    '  no caveats, no offer to do more.',
    '- Code, commands and file paths stay whole. Brevity never costs accuracy.',
    '- If the answer genuinely needs more room, give the short version here and',
    '  say that the full one is in the main window.',
  ].join('\n'),
  balanced: [
    '# Where this question was asked',
    '',
    'This came from the desktop companion — a small floating window over whatever',
    'the user is working in. Keep the answer to what was asked, at the length the',
    'question deserves: short for a lookup, as long as it needs to be for anything',
    'that genuinely takes several steps. No preamble and no restating the question.',
  ].join('\n'),
  detailed: [
    '# Where this question was asked',
    '',
    'This came from the desktop companion, and the user has asked it to answer in',
    'full here rather than deferring to the window. Answer completely: the',
    'reasoning, the alternatives that matter, and the detail a careful answer',
    'needs — written so it is worth reading in a narrow window, which means plain',
    'prose and short paragraphs rather than broad tables.',
  ].join('\n'),
};

/**
 * The instruction for a turn, or undefined for an ordinary one.
 *
 * `origin` is optional so every existing caller — a job, a Discord mention, a
 * test — keeps getting exactly the instruction it got before.
 */
export function turnInstruction(
  origin: 'window' | 'pet' | undefined,
  answerLength: CompanionAnswerLength,
): string | undefined {
  return origin === 'pet' ? LENGTHS[answerLength] : undefined;
}
