/**
 * Where a message is typed.
 *
 * One box, and the send button is *in* it rather than on a row underneath: the
 * thing being pressed belongs to the line being typed, and a Send below the box
 * reads as the next form field rather than as the end of the sentence. It is a
 * circle with an arrow because that is what it does — the arrow follows the
 * message out — and while a turn is running the same circle becomes Stop, so
 * the control you reach for next is where the one you just pressed was.
 *
 * The foot row is where the actions that act on the *message* live: `+` on the
 * left, the keyboard hint in the middle, the model picker on the right. The
 * textarea grows with what is in it up to a point, because a prompt worth
 * sending is often more than one line and a box that scrolls after two lines
 * hides the question the user is still writing.
 *
 * While a turn is running the button becomes Stop rather than the box becoming
 * disabled. A disabled box is the wrong shape: people compose their next thought
 * while waiting, and taking the words away — or losing them on send — is how a
 * conversation gets interrupted by its own tooling.
 */
import {useEffect, useRef, useState} from 'react';

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
}: {
  /**
   * Resolves `true` when the turn was accepted.
   *
   * The boolean is why this returns a promise: a send that is refused — a turn
   * already running in another window, a conversation that no longer exists —
   * arrives as `accepted: false`, and clearing the box on the press instead
   * would throw the user's words away for a message that was never stored.
   */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  /* Grow with the content, then stop. */
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const ready = text.trim().length > 0 && !busy && !disabled;

  const submit = async (): Promise<void> => {
    if (!ready) {
      return;
    }
    if (await onSend(text.trim())) {
      setText('');
    }
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <div className="composer-line">
          <textarea
            ref={box}
            className="composer-input"
            rows={1}
            value={text}
            placeholder={
              disabled ? 'Add an agent to start chatting.' : 'Ask Marimo anything…'
            }
            disabled={disabled}
            aria-label="Message"
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter is the browser's newline. The other way
              // round is the convention everywhere else and gets it wrong here.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="composer-send is-stop"
              aria-label="Stop"
              title="Stop"
              onClick={onStop}
            >
              <span aria-hidden="true">■</span>
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              aria-label="Send message"
              title="Send (Enter)"
              disabled={!ready}
              onClick={() => {
                void submit();
              }}
            >
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>

        <div className="composer-foot">
          <span className="composer-hint">
            {busy ? 'Working…' : 'Enter to send, Shift+Enter for a new line'}
          </span>
        </div>
      </div>
    </div>
  );
}
