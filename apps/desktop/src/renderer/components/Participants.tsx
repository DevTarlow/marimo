/**
 * Who is in this conversation.
 *
 * It sits in the header rather than in a toolbar of its own: who is in a chat is
 * the same kind of fact as where the chat works, and the header is where that is
 * already said. It is deliberately not a row of avatars — the names are the
 * conversation's own line, and this is the small thing beside them.
 *
 * The rule it follows is the one about controls that cannot do anything: the
 * trigger is drawn only when there is an agent left to add. A window whose only
 * agent is already in the chat therefore draws no membership control at all,
 * which is every fresh install; a chat that could become a group draws a way to
 * make it one, because a second agent is exactly the case where it can.
 */
import {useRef, useState} from 'react';

import type {AgentProfile} from '@marimo/protocol';

import type {Participant} from '../participants.js';
import {Popover, PopoverItem} from './Popover.js';
import type {PopoverAnchor} from './Popover.js';

export function Participants({
  members,
  agents,
  onAdd,
}: {
  /** The conversation's agents, lead first. */
  members: readonly Participant[];
  /** Every agent in the install, which is what an addition is chosen from. */
  agents: readonly AgentProfile[];
  /**
   * The whole membership, with the new agent last.
   *
   * The whole list rather than the one id, because the call it makes replaces
   * the membership: a caller that had to append to its own copy could disagree
   * with the file about whether the agent that owns the chat is still in it.
   */
  onAdd: (agentIds: string[]) => void;
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const others = agents.filter(
    (agent) => !members.some((member) => member.id === agent.id),
  );
  if (others.length === 0) {
    return null;
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="button button-quiet button-small"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title="Bots in this chat"
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor(
            anchor !== null || rect === undefined
              ? null
              : {top: rect.top, bottom: rect.bottom, left: rect.left},
          );
        }}
      >
        + Bot
      </button>

      {anchor !== null && (
        <Popover
          anchor={anchor}
          label="Bots in this chat"
          onClose={() => {
            setAnchor(null);
          }}
        >
          <span className="popover-label">In this chat</span>
          {members.map((member) => (
            /*
             * The id on the title of a member the roster has lost, so the line
             * says what happened without a UUID being the first thing read.
             */
            <p
              className="popover-path"
              key={member.id}
              title={member.known ? undefined : member.id}
            >
              {member.name}
            </p>
          ))}

          <div className="popover-sep" />
          <span className="popover-label">Add a bot</span>
          {others.map((agent) => (
            <PopoverItem
              key={agent.id}
              onSelect={() => {
                setAnchor(null);
                onAdd([...members.map((member) => member.id), agent.id]);
              }}
            >
              {agent.name}
            </PopoverItem>
          ))}
        </Popover>
      )}
    </>
  );
}
