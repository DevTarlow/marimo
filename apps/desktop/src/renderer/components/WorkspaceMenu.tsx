/**
 * What one space's `…` offers.
 *
 * Rename, open, forget — and "forget" is the word: removing a space from the
 * list touches nothing on disk, and the confirmation says so in those terms. The
 * conversations filed under it stay where they are and reappear under "Other
 * chats", because a tidy-up that loses a chat is not a tidy-up.
 */
import {useState} from 'react';

import type {Workspace} from '@marimo/protocol';

import {PopoverItem, Popover} from './Popover.js';
import type {PopoverAnchor} from './Popover.js';

export function WorkspaceMenu({
  workspace,
  anchor,
  onClose,
  onRename,
  onOpen,
  onRemove,
}: {
  workspace: Workspace;
  anchor: PopoverAnchor;
  onClose: () => void;
  onRename: () => void;
  onOpen: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);

  return (
    <Popover
      anchor={anchor}
      label={`Actions for ${workspace.name}`}
      onClose={onClose}
    >
      <span className="popover-path" title={workspace.path}>
        {workspace.path}
      </span>
      {confirming ? (
        <div className="popover-confirm">
          <p>
            Remove &ldquo;{workspace.name}&rdquo; from the list? The space and
            everything in it are left untouched; its chats move to Other chats.
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
          <PopoverItem onSelect={onOpen}>Open the space</PopoverItem>
          <div className="popover-sep" />
          <PopoverItem
            onSelect={() => {
              setConfirming(true);
            }}
            danger
          >
            Remove from list…
          </PopoverItem>
        </>
      )}
    </Popover>
  );
}
