/**
 * Noticing what is worth remembering.
 *
 * The agent already has `update_memory`, and it calls it when it thinks to. This
 * is the other half: after a conversation has moved on, something reads back
 * what was said and proposes the durable facts the agent did not stop to write
 * down. A preference mentioned in passing, a decision that was settled, the way
 * a project is laid out.
 *
 * Four decisions shape it, and each is the difference between a feature and a
 * nuisance.
 *
 * **It proposes; it does not write.** Long-term memory is injected into every
 * future system prompt, so a wrong entry is not a wrong answer once — it is a
 * wrong belief the agent carries into every later conversation. The user sees
 * what would be written and decides.
 *
 * **It reviews only what it has not seen.** A watermark records how far the
 * review has read, so an idle conversation is not re-read and re-proposed every
 * time the app goes quiet.
 *
 * **A malformed answer proposes nothing.** The model's reply is untrusted input
 * like any other, and the failure mode of guessing at a half-parsed fact is a
 * confident sentence in memory that nobody wrote.
 *
 * **The rubric says what to leave out**, not just what to include. A model asked
 * for "facts worth remembering" will happily propose that the user said hello.
 * The exclusions are what make the queue short enough to read.
 */
import {z} from 'zod';

/** One thing the agent would remember, if the user agrees. */
export interface MemoryProposal {
  /** Where it would go in `memory.md`. */
  section: string;
  /** The fact, as it would be written. */
  text: string;
  /** Why it is worth keeping, in the model's words, for the user to judge by. */
  reason: string;
}

/** The most proposals one review may produce. */
export const MAX_PROPOSALS = 5;

/** How much of a conversation one review may read. */
export const MAX_REVIEW_CHARS = 24_000;

/**
 * The shapes a proposal may take.
 *
 * `text` is bounded because it becomes a line in a file that is injected into
 * every future prompt: a model that answers with an essay would otherwise put
 * the essay in the system prompt forever. The bound is generous enough for a
 * real fact and short enough that five of them are still smaller than the
 * conversation they came from.
 */
const proposalSchema = z.object({
  section: z.string().trim().min(1).max(48),
  text: z.string().trim().min(3).max(400),
  reason: z.string().trim().max(200),
});

const answerSchema = z.object({
  proposals: z.array(proposalSchema).max(MAX_PROPOSALS),
});

/**
 * What to ask, given a conversation.
 *
 * Written as a list of exclusions as much as inclusions. "Anything worth
 * remembering" produces a queue nobody reads; naming what does *not* count is
 * what keeps it to the things a person would actually want written down.
 */
export function reviewPrompt(conversation: string): string {
  return [
    'You are reviewing a conversation between a user and their desktop agent,',
    'to find facts worth keeping in the agent\'s long-term memory.',
    '',
    'Long-term memory is shown to the agent at the start of every future',
    'conversation. Propose something only if it would still be true and still',
    'useful in a month, and only if it is about the *user* or their work.',
    '',
    'Worth proposing:',
    '- a preference they stated, especially one they had to correct the agent on',
    '- a decision that was settled, and the reason if they gave one',
    '- how their project or machine is set up, when it is not obvious',
    '- something they asked the agent to always or never do',
    '',
    'Do not propose:',
    '- anything already in the memory below',
    '- the content of the task itself, or what the agent did to complete it',
    '- pleasantries, or that the conversation happened at all',
    '- anything you inferred rather than were told',
    '- secrets, keys, passwords or tokens — never these, under any framing',
    '',
    'Answer with JSON only, no prose around it:',
    '{"proposals":[{"section":"Notes","text":"...","reason":"..."}]}',
    '',
    'At most 5. An empty list is the right answer for most conversations.',
    '',
    '--- conversation ---',
    conversation,
  ].join('\n');
}

/**
 * Reads the model's answer.
 *
 * Never throws. A review that cannot be understood proposes nothing, because the
 * alternative — salvaging half a sentence — writes something nobody said into a
 * file that shapes every future conversation.
 *
 * JSON is asked for and extracted leniently: models wrap it in prose or a fenced
 * block often enough that refusing those would make the feature look broken. The
 * *content* is still validated strictly.
 */
export function parseProposals(answer: string): MemoryProposal[] {
  const json = extractJson(answer);
  if (json === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const result = answerSchema.safeParse(parsed);
  return result.success ? result.data.proposals : [];
}

/**
 * The JSON object inside whatever the model actually wrote.
 *
 * Scans for the outermost braces rather than matching a pattern, so a fenced
 * block, a leading sentence and a trailing apology all work. Strings inside are
 * skipped, because a `}` inside a proposed fact would otherwise end the object
 * early and hand the parser a truncated one.
 */
function extractJson(answer: string): string | undefined {
  const start = answer.indexOf('{');
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < answer.length; index += 1) {
    const character = answer[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return answer.slice(start, index + 1);
      }
    }
  }

  // Unbalanced: the answer was cut off, which a streaming reply often is.
  return undefined;
}

/**
 * Whether a proposal is one the memory does not already hold.
 *
 * Compared case-insensitively on collapsed whitespace, because the same fact
 * phrased with different spacing is the same fact and proposing it again is how
 * a queue stops being read.
 */
export function isNewProposal(
  proposal: MemoryProposal,
  existing: string,
): boolean {
  const normalise = (value: string): string =>
    value.toLowerCase().replaceAll(/\s+/gu, ' ').trim();
  const target = normalise(proposal.text);
  if (target.length === 0) {
    return false;
  }
  const haystack = normalise(existing);
  if (haystack.includes(target)) {
    return false;
  }
  /*
   * And the other direction, coarsely: a proposal that *contains* an existing
   * line is usually the same fact with more context attached. Compared by line,
   * so a long memory file does not swallow every short proposal.
   */
  return !haystack
    .split('\n')
    .map(normalise)
    .some((line) => line.length > 20 && target.includes(line));
}
