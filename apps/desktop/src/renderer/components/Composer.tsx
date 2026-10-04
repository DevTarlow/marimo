/**
 * Where a message is typed.
 *
 * The textarea grows with what is in it up to a point, because a prompt worth
 * sending is often more than one line and a box that scrolls after two lines
 * hides the question the user is still writing.
 *
 * While a turn is running the button becomes Stop rather than the box becoming
 * disabled. A disabled box is the wrong shape: people compose their next thought
 * while waiting, and taking the words away — or losing them on send — is how a
 * conversation gets interrupted by its own tooling.
 */
import {useEffect, useRef} from 'react';

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
}): React.JSX.Element {
  const box = useRef<HTMLTextAreaElement>(null);

  /* Grow with the content, then stop. */
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  });

  const submit = (): void => {
    const element = box.current;
    if (element === null) {
      return;
    }
    const text = element.value.trim();
    if (text.length === 0 || busy || disabled) {
      return;
    }
    onSend(text);
    // Cleared only once the send was accepted, so a refusal cannot eat what the
    // user typed.
    element.value = '';
    element.style.height = 'auto';
  };

  return (
    <div className="composer">
      <textarea
        ref={box}
        className="composer-box"
        rows={1}
        placeholder={
          disabled ? 'Add an agent to start chatting.' : 'Ask Marimo anything…'
        }
        disabled={disabled}
        aria-label="Message"
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is the browser's newline. The other way
          // round is the convention everywhere else and gets it wrong here.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-row">
        <span className="composer-hint">
          {busy ? 'Working…' : 'Enter to send, Shift+Enter for a new line'}
        </span>
        {busy ? (
          <button type="button" className="button button-quiet" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary"
            disabled={disabled}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
