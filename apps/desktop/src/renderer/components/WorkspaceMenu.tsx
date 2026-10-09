/**
 * What one folder's `…` offers.
 *
 * Rename, open, forget — and "forget" is the word: removing a folder from the
 * list touches nothing on disk, and the confirmation says so in those terms. The
 * conversations filed under it stay where they are and reappear under "Other
 * chats", because a tidy-up that loses a chat is not a tidy-up.
 */
import {useState} from 'react';

import type {Workspace} from '@marimo/protocol';

import {RailMenuItem, RailPopover} from './RailPopover.js';
import type {PopoverAnchor} from './RailPopover.js';

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
    <RailPopover
      anchor={anchor}
      label={`Actions for ${workspace.name}`}
      onClose={onClose}
    >
      <span className="rail-menu-path" title={workspace.path}>
        {workspace.path}
      </span>
      {confirming ? (
        <div className="rail-menu-confirm">
          <p>
            Remove &ldquo;{workspace.name}&rdquo; from the list? The folder and
            everything in it are left untouched; its chats move to Other chats.
          </p>
          <div className="rail-menu-row">
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
          <RailMenuItem onSelect={onRename}>Rename…</RailMenuItem>
          <RailMenuItem onSelect={onOpen}>Open folder</RailMenuItem>
          <div className="rail-menu-sep" />
          <RailMenuItem
            onSelect={() => {
              setConfirming(true);
            }}
            danger
          >
            Remove from list…
          </RailMenuItem>
        </>
      )}
    </RailPopover>
  );
}
