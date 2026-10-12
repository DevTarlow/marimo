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

import {CANONICAL_SECTIONS, renderSectionGuide} from './sections.js';

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
 * The longest section name a proposal may carry.
 *
 * A named section the file already has is always allowed, so this is a bound
 * rather than a whitelist — but it is derived from the canonical vocabulary
 * instead of being a literal, because a name too long to propose is a layer the
 * reviewer silently cannot use.
 */
export const MAX_SECTION_CHARS = Math.max(
  48,
  ...CANONICAL_SECTIONS.map((section) => section.name.length),
);

/**
 * The layer the JSON example uses.
 *
 * A model copies the shape of the example, so this has to be a real layer and
 * not the fallback — an example written into `Notes` silently undoes the
 * layering the prompt just asked for. Exported so the test can assert the two
 * agree rather than restating the name.
 */
export const PROPOSAL_EXAMPLE_SECTION = 'Preferences and tone';

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
  section: z.string().trim().min(1).max(MAX_SECTION_CHARS),
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
 *
 * The sections are named rather than left to the model, because memory is
 * layered: a fact proposed into `Notes` is one the agent will read in the same
 * pile as everything else, and the layer it belongs in is exactly what decides
 * whether it is still relevant. The example therefore uses a real section
 * instead of the fallback — a model copies the shape of the example.
 */
export function reviewPrompt(
  conversation: string,
  refused: readonly RefusedFact[] = [],
): string {
  return [
    'You are reviewing a conversation between a user and their desktop agent,',
    "to find facts worth keeping in the agent's long-term memory.",
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
    /*
     * "what the user already knows" rather than "the memory below", which is what
     * this said and was not true: the memory file is never put in this prompt.
     * The filter against it is code (`isNewProposal`), and the prompt names the
     * rule only because a model told what *not* to send produces less to filter.
     * A sentence pointing at a section that is not there is the kind of small lie
     * that makes a model invent an answer to match it.
     */
    '- anything the user already knows, or that is already in the agent memory',
    '- the content of the task itself, or what the agent did to complete it',
    '- pleasantries, or that the conversation happened at all',
    '- anything you inferred rather than were told',
    '- secrets, keys, passwords or tokens — never these, under any framing',
    ...(refused.length === 0
      ? []
      : [
          '',
          /*
           * Named as a block rather than as more bullets, because the reason is
           * different from the rest of the list: this is not a rule about what
           * matters, it is a record of this person's answers. A model that
           * understands *why* keeps applying it to paraphrases.
           */
          'The user has already been shown these and said no. Do not propose them',
          'again, and do not propose the same fact in different words:',
          ...refused.map((entry) => `- ${entry.text}`),
        ]),
    '',
    'Put each proposal in the layer it belongs in:',
    renderSectionGuide(),
    '',
    'Those are the common layers, not the only ones: a section the memory file',
    'already has is fine to use, and "Notes" is the fallback when nothing fits.',
    '',
    'Answer with JSON only, no prose around it:',
    '{"proposals":[{"section":"' +
      PROPOSAL_EXAMPLE_SECTION +
      '","text":"...","reason":"..."}]}',
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

/** One stored event, as this file reads it. */
export interface ReviewEvent {
  author?: string;
  content?: {parts?: Array<{text?: string; thought?: boolean}>};
}

/**
 * A fact the user refused, as the reviewer reads it.
 *
 * The text alone: the profile it belongs to and when it was refused are the
 * store's business, and a reviewer that could see the timestamps would be tempted
 * to weigh them, which is not a judgement this prompt asks for.
 */
export interface RefusedFact {
  text: string;
}

export interface ReviewRequest {
  events: readonly ReviewEvent[];
  /** The memory as it stands, so nothing already known is proposed again. */
  memory: string;
  /**
   * Facts the user has already said no to, so they are not asked about twice.
   *
   * Not folded into `memory`: the memory file is what the agent *knows*, and this
   * is what it was told not to suggest. Keeping them apart matters because the
   * agent may still know a refused fact — the user can refuse a *suggestion* and
   * still say the thing themselves later — and a prompt that confused the two
   * would have the reviewer arguing with the memory file.
   */
  refused?: readonly RefusedFact[];
  /** Asks the model. Injected, so the whole review is testable without one. */
  ask: (prompt: string) => Promise<string>;
}

/**
 * What one review produced, and how far into the conversation it read.
 *
 * `used` travels with the proposals because the caller owns the watermark: only
 * it knows where this stretch started, and only the pair of numbers together say
 * where the next look should resume.
 */
export interface ReviewResult {
  proposals: MemoryProposal[];
  /** How many of the events handed in this look covered. */
  used: number;
}

/**
 * Reads a conversation and proposes what is worth remembering.
 *
 * The orchestration is here rather than in the host so the whole thing — the
 * transcript rendering, the prompt, the parse, the filter against memory — can be
 * tested with a function instead of a provider.
 *
 * A failure from the model answers no proposals. A review is something that
 * happens on its own while nobody is watching, so an exception would surface as
 * an unhandled rejection at an idle moment; and there is nothing to tell the
 * user, because nothing happened. The stretch still counts as read, because it
 * was handed to the model — advancing only on success would re-send a failing
 * prompt on every idle moment.
 */
export async function runReview(
  request: ReviewRequest,
): Promise<ReviewResult> {
  const stretch = renderConversation(request.events);
  if (stretch.text.trim().length === 0) {
    return {proposals: [], used: stretch.used};
  }

  let answer: string;
  try {
    answer = await request.ask(
      reviewPrompt(stretch.text, request.refused ?? []),
    );
  } catch {
    return {proposals: [], used: stretch.used};
  }

  return {
    proposals: parseProposals(answer).filter(
      (proposal) =>
        isNewProposal(proposal, request.memory) &&
        !wasRefused(proposal, request.refused ?? []),
    ),
    used: stretch.used,
  };
}

/**
 * Whether the user has already said no to this suggestion.
 *
 * Compared the same way the store dedupes refusals and the same way
 * `isNewProposal` compares against memory — collapsed and case-insensitive —
 * because the model will re-word a fact slightly and a filter that only caught
 * exact repeats would let it ask again in a way nobody could see. Deliberately
 * *not* a prefix or substring match: a refusal is of a specific sentence, and
 * treating a shared opening as the same fact would silence a whole subject
 * because one sentence about it was refused.
 *
 * The prompt asks for this too. Both are here because the two fail differently:
 * a model that ignores an instruction wastes a call, and a model that ignores
 * this filter puts a rejected fact back in front of the user.
 */
export function wasRefused(
  proposal: MemoryProposal,
  refused: readonly RefusedFact[],
): boolean {
  const normalise = (value: string): string =>
    value.toLowerCase().replaceAll(/\s+/gu, ' ').trim();
  const target = normalise(proposal.text);
  if (target.length === 0) {
    return false;
  }
  return refused.some((entry) => normalise(entry.text) === target);
}

/**
 * One look's worth of a conversation: the text, and how far it reached.
 *
 * `used` is the point of the pair. A review reads a fixed number of characters,
 * and a conversation longer than that has to be read over several looks — so the
 * caller needs to know which events this look actually covered, because the
 * watermark may only move past those. Rendering the tail and then advancing past
 * the whole slice is how the beginning of a long conversation is marked read
 * without ever having been sent anywhere.
 */
export interface ReviewStretch {
  /** The conversation text for one look, at most {@link MAX_REVIEW_CHARS}. */
  text: string;
  /** How many of the events handed in are covered by `text`. */
  used: number;
}

/**
 * The conversation as text for the reviewer.
 *
 * Reasoning parts are left out: they are the model's working, not what was said,
 * and a review that read them would propose things nobody stated. The agent's
 * tool calls are left out for the same reason — "the agent read a file" is not a
 * fact about the user.
 *
 * Capped at a stretch taken from the *earliest* event it was handed, which is
 * the earliest not yet reviewed. Taking the tail instead would prefer the most
 * recent exchange when a backlog is large, and it cannot be made to cover the
 * conversation: the events it dropped are in front of the watermark, so the next
 * look would either send them again forever or step over them. A look that
 * starts where the last one stopped loses nothing, and the calls that drain a
 * long backlog are spaced by the review cadence rather than run back to back.
 */
export function renderConversation(
  events: readonly ReviewEvent[],
): ReviewStretch {
  const lines: string[] = [];
  let length = 0;
  let used = 0;

  for (const event of events) {
    used += 1;
    const text = (event.content?.parts ?? [])
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? '')
      .filter((part) => part.length > 0)
      .join('')
      .trim();
    if (text.length === 0) {
      // Nothing to review, and nothing for the next look to carry.
      continue;
    }
    const who = event.author === 'user' ? 'USER' : 'AGENT';
    const line = `${who}: ${text}`;
    const added = lines.length === 0 ? line.length : line.length + 2;
    if (lines.length > 0 && length + added > MAX_REVIEW_CHARS) {
      /*
       * The event belongs to the next look, and `used` must not count it or the
       * watermark would step over text no prompt ever carried. The first line is
       * taken whatever its size, so a single enormous message still makes
       * progress instead of being retried forever.
       */
      used -= 1;
      break;
    }
    lines.push(line);
    length += added;
  }

  return {text: lines.join('\n\n'), used};
}
