/**
 * `@` in the composer: what it opens, and what it means when the message is sent.
 *
 * Both halves are text rules, and they are here rather than inside the component
 * because they are the halves that can be wrong in ways nobody sees: a mention is
 * only a mention at the start of a word, a name can be more than one word, and an
 * address that disagrees with the words would send a message to somebody the user
 * did not name. `addressedAgent` reads the address back out of the text rather
 * than tracking it beside the text, so the two cannot drift apart — deleting the
 * mention is what un-addresses the message.
 */
import type {Participant} from './participants.js';

/** The `@`-query the caret is at the end of, when it is in one. */
export interface MentionQuery {
  /** Index of the `@` in the text. */
  start: number;
  /** What has been typed after it, which may be empty. */
  query: string;
}

/**
 * The characters a name and a query are made of.
 *
 * Unicode letters and digits rather than `\w`, because an agent may be called
 * anything, and a rule that treated `Ünicode` as a boundary would open the picker
 * in the middle of a word.
 */
const WORD = /[\p{L}\p{N}_]/u;

function isWord(char: string): boolean {
  return WORD.test(char);
}

/**
 * The mention the caret is inside, if it is inside one.
 *
 * Scanned back from the caret over the characters a name is made of, so `@wri`
 * is a query for a name beginning `wri` and `mail@wri` is not a query at all —
 * an address is not an agent. A name containing a space is never *typed* as a
 * query; it is picked from the list, which is what the list is for.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const end = Math.min(Math.max(caret, 0), text.length);
  let start = end;
  while (start > 0) {
    const char = text.charAt(start - 1);
    if (!isWord(char) && char !== '@') {
      break;
    }
    start -= 1;
  }
  const run = text.slice(start, end);
  // The run may hold more than one `@` — `@a@wri` — and that is not a mention of
  // anybody: the query would be a name no agent has, so the picker stays shut.
  if (!run.startsWith('@') || run.indexOf('@', 1) !== -1) {
    return null;
  }
  return {start, query: run.slice(1)};
}

/**
 * The participant a message addresses, if it names one.
 *
 * The longest name wins a tie, because `@Writer Bot` names the agent called
 * "Writer Bot" and not the one called "Writer" followed by the word "Bot"; the
 * earliest mention wins otherwise, because that is the one the reader meets
 * first. Case is ignored so `@writer` addresses Writer — nobody types a
 * capital to reach a name they can see.
 */
export function addressedAgent(
  text: string,
  participants: readonly Participant[],
): Participant | null {
  let found: {participant: Participant; start: number; length: number} | null = null;
  for (const participant of participants) {
    const start = mentionIndexOf(text, participant.name);
    if (start === null) {
      continue;
    }
    if (
      found === null ||
      start < found.start ||
      (start === found.start && participant.name.length > found.length)
    ) {
      found = {participant, start, length: participant.name.length};
    }
  }
  return found?.participant ?? null;
}

/** Where `@name` appears at a word boundary, or `null`. */
function mentionIndexOf(text: string, name: string): number | null {
  const needle = `@${name}`.toLowerCase();
  const haystack = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) {
      return null;
    }
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = text.charAt(at + needle.length);
    // Both ends have to be a boundary: `@Writerly` is a different name, and
    // `mail@Writer` is an address.
    if (!isWord(before) && !isWord(after)) {
      return at;
    }
    from = at + 1;
  }
}
