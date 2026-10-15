/**
 * Who is in a conversation, and what they are called.
 *
 * The window is handed ids everywhere — a message says which agent wrote it, a
 * conversation says which agents are in it — and the names live in the roster
 * Settings edits. Resolving one into the other is here because the case every
 * caller has to get right the same way is the one with no name to find: an agent
 * that has been deleted is still named in every conversation it was part of.
 */
import type {AgentProfile} from '@marimo/protocol';

/**
 * What an agent is called when the roster no longer holds it.
 *
 * Neither the raw id nor a blank. A profile id is a UUID, and a UUID over a
 * bubble reads as a rendering bug rather than as a person who was deleted; an
 * empty line reads as neither. The id stays on the participant, so a caller that
 * wants to show it — a `title`, say — still can.
 */
const GONE = 'a deleted bot';

/** One member of a conversation, named. */
export interface Participant {
  id: string;
  /** What to draw. Never empty. */
  name: string;
  /** False when the id names an agent this install no longer has. */
  known: boolean;
}

export function participantFor(
  id: string,
  agents: readonly AgentProfile[],
): Participant {
  const found = agents.find((agent) => agent.id === id);
  return found === undefined
    ? {id, name: GONE, known: false}
    : {id, name: found.name, known: true};
}

/**
 * The members of a conversation, lead first.
 *
 * `agentIds` absent means a chat with one agent — the one that owns it. That is
 * every conversation written before groups existed and most of them since, which
 * is why it is not an empty list: it reads as the owner rather than as nobody,
 * and the header of such a chat is unchanged by any of this.
 *
 * An id the roster has forgotten is still listed. A member who was deleted did
 * not stop having been in the conversation, and dropping it here would silently
 * rewrite who took part.
 */
export function sessionMembers({
  agentIds,
  ownerId,
  agents,
}: {
  agentIds: readonly string[] | undefined;
  /** The agent that owns the conversation, which is the lead when none is named. */
  ownerId: string | undefined;
  agents: readonly AgentProfile[];
}): Participant[] {
  /*
   * An empty list is the same answer as no list, not a conversation with nobody
   * in it: `sessions.setParticipants` documents `[]` as "just the agent that owns
   * it", so the two spellings of one agent must not draw differently.
   */
  const ids =
    agentIds !== undefined && agentIds.length > 0
      ? agentIds
      : ownerId === undefined
        ? []
        : [ownerId];
  return ids.map((id) => participantFor(id, agents));
}
