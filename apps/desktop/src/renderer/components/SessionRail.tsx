/**
 * The conversations, down the side.
 *
 * A conversation with no messages is not listed: it exists the moment the window
 * opens one, and a rail whose first entry is an empty chat the user never asked
 * for is a rail that lies about what they have.
 */
import type {SessionSummary} from '@marimo/protocol';

import {KeepRunning} from './KeepRunning.js';

export function SessionRail({
  sessions,
  activeId,
  onOpen,
  onNew,
  disabled,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  onOpen: (sessionId: string) => void;
  onNew: () => void;
  disabled: boolean;
}): React.JSX.Element {
  // Only conversations that have something in them, plus whichever one is open —
  // hiding the one on screen because it is still empty would make the rail look
  // like the app had lost it.
  const listed = sessions.filter(
    (session) => session.messageCount > 0 || session.id === activeId,
  );

  return (
    <aside className="rail" aria-label="Conversations">
      <div className="rail-head">
        <span className="rail-title">Chats</span>
        <button
          type="button"
          className="button button-quiet button-small"
          onClick={onNew}
          disabled={disabled}
        >
          New
        </button>
      </div>
      <nav className="rail-list">
        {listed.length === 0 && <p className="rail-empty">Nothing yet.</p>}
        {listed.map((session) => (
          <button
            key={session.id}
            type="button"
            className="rail-row"
            aria-current={session.id === activeId ? 'true' : undefined}
            onClick={() => {
              onOpen(session.id);
            }}
          >
            <span className="rail-row-title">{session.title}</span>
            <span className="rail-row-when">{shortDate(session.updatedAt)}</span>
          </button>
        ))}
      </nav>
      <KeepRunning />
    </aside>
  );
}

/** Time for today, a date before that. */
function shortDate(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) {
    return '';
  }
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();

  return sameDay
    ? when.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
    : when.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}
