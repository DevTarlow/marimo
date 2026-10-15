/**
 * What one bot's `…` offers.
 *
 * Two things, in the order of how reversible they are: renaming, and removal.
 * Removal is asked twice, in place — the second press is the confirmation — so a
 * misfired click opens a question rather than ending a bot, its conversations,
 * its schedule and what it remembered about the user. That is the same shape the
 * conversation menu uses, and deliberately so: this is the second destructive act
 * in the app, and two different ways of asking would be one too many.
 *
 * The last bot is offered but disabled, with the reason under it. The store
 * refuses that removal outright — an install with no profile cannot answer
 * anything — and a live menu item that ended in a thrown sentence would be a
 * worse way to find that out than an item that says why it is not available.
 */
import {useState} from 'react';

import type {AgentProfile} from '@marimo/protocol';

import {Popover, PopoverItem} from './Popover.js';
import type {PopoverAnchor} from './Popover.js';

export function BotMenu({
  bot,
  last,
  anchor,
  onClose,
  onRename,
  onRemove,
}: {
  bot: AgentProfile;
  /** Whether this is the only bot, which is the one that cannot be removed. */
  last: boolean;
  anchor: PopoverAnchor;
  onClose: () => void;
  onRename: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);

  return (
    <Popover
      anchor={anchor}
      label={`Actions for ${bot.name}`}
      onClose={onClose}
    >
      {confirming ? (
        <div className="popover-confirm">
          <p>
            Remove &ldquo;{bot.name}&rdquo;? Its conversations and scheduled
            jobs are removed for good, along with what it remembers about you.
            What it wrote inside your spaces stays.
          </p>
          <div className="popover-row">
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger button-small"
              onClick={onRemove}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <>
          <PopoverItem onSelect={onRename}>Rename…</PopoverItem>
          <PopoverItem
            danger
            disabled={last}
            onSelect={() => {
              setConfirming(true);
            }}
          >
            Remove bot…
          </PopoverItem>
          {/*
            Not a `.popover-label`: that class is uppercase for one-word headings,
            and this is a sentence somebody has to read rather than skim.
          */}
          {last && (
            <p className="popover-path">
              The last bot cannot be removed — create another one first.
            </p>
          )}
        </>
      )}
    </Popover>
  );
}
