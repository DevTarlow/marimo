/**
 * The desktop pet.
 *
 * A moss ball with a chat bar, answers floating up above it, and nothing else —
 * no rail, no settings, no header. It exists so the agent can be asked something
 * without opening a window, and it is deliberately not a smaller version of the
 * app: everything that is not "say a thing and see the answer" is somewhere else.
 *
 * It shares the conversation with the main window rather than having one of its
 * own. Asking here and reading there is one thread, and a companion with its own
 * history would be a second agent the user has to remember to talk to.
 *
 * **It is mostly transparent, and it tells the main process where it is not.**
 * The window is a fixed 340×460 rectangle over whatever the user is working in,
 * and without click-through that rectangle swallows every click on the things
 * behind it. So the renderer reports whether the pointer is over something
 * real, and the window stops accepting the mouse when it is not. That is what
 * makes it sit *on* the desktop instead of in a box on top of it.
 */
import {useEffect, useRef, useState} from 'react';

import type {TranscriptMessage} from '@marimo/protocol';

import {Copy, Markdown} from './components/Markdown.js';
import {useAgent} from './hooks/useAgent.js';

/** How much of the conversation floats above the moss. */
const VISIBLE_MESSAGES = 6;

export function Pet(): React.JSX.Element {
  const agent = useAgent();
  const [draft, setDraft] = useState('');
  const column = useRef<HTMLDivElement>(null);

  const busy = agent.live?.running === true;

  /*
   * Reports whether the pointer is over anything. `closest` rather than a
   * per-element handler, because the answer has to be right for everything
   * inside a bubble as well — a link, a code block, a copy button.
   */
  useEffect(() => {
    const report = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      const over = target?.closest('.pet, .pet-input, .pet-bubble, .pet-gate');
      void window.marimo
        .call('companion.pointer', {over: over !== null && over !== undefined})
        .catch(() => undefined);
    };
    window.addEventListener('mousemove', report);
    return () => {
      window.removeEventListener('mousemove', report);
    };
  }, []);

  /*
   * The last few turns, oldest first. Older ones are in the window, which is
   * where a conversation is for reading; here it is for the answer that just
   * arrived.
   */
  const shown: TranscriptMessage[] = agent.messages.slice(-VISIBLE_MESSAGES);

  useEffect(() => {
    const element = column.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [shown.length, agent.live?.text.length]);

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || busy || agent.profile === undefined) {
      return;
    }
    void agent.send(text);
    setDraft('');
  };

  return (
    <div className="pet">
      <div className="pet-column" ref={column}>
        {shown.map((message) => (
          <div
            key={message.id}
            className={`pet-bubble pet-${message.role}`}
            {...(message.subagent === undefined
              ? {}
              : {'data-subagent': message.subagent})}
          >
            {message.role === 'assistant' ? (
              <Markdown text={message.text} />
            ) : (
              message.text
            )}
          </div>
        ))}

        {agent.live !== null && agent.live.text.length > 0 && (
          <div className="pet-bubble pet-assistant">
            <Markdown text={agent.live.text} />
          </div>
        )}

        {busy && agent.live?.text.length === 0 && (
          <div className="pet-bubble pet-assistant pet-thinking" aria-label="Working">
            <span />
            <span />
            <span />
          </div>
        )}

        {/*
          A gate is the one thing worth interrupting for — an unattended run that
          stops on one will not proceed and will not give up — so the companion
          shows it rather than leaving the answer to be found in the window.
        */}
        {agent.pending.map((gate) => (
          <div className="pet-bubble pet-gate" key={gate.callId}>
            <strong>{gate.tool}</strong>
            <span className="pet-gate-hint">{gate.hint}</span>
            <div className="pet-gate-actions">
              <button
                type="button"
                className="pet-button"
                onClick={() => {
                  void agent.decide(gate.callId, false);
                }}
              >
                Deny
              </button>
              <button
                type="button"
                className="pet-button pet-button-go"
                onClick={() => {
                  void agent.decide(gate.callId, true);
                }}
              >
                Allow
              </button>
            </div>
          </div>
        ))}

        {agent.error !== null && (
          <div className="pet-bubble pet-error">{agent.error}</div>
        )}
      </div>

      <div className="pet-bar">
        <input
          className="pet-input"
          value={draft}
          placeholder={busy ? 'Working…' : 'Ask Marimo…'}
          aria-label="Message"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') {
              event.currentTarget.blur();
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            className="pet-send"
            aria-label="Stop"
            onClick={() => {
              void agent.stop();
            }}
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="pet-send"
            aria-label="Send"
            disabled={draft.trim().length === 0}
            onClick={submit}
          >
            ↑
          </button>
        )}
      </div>

      {/*
        The moss, and the handle for moving the window. Dragging is the window's
        own gesture — `-webkit-app-region` in the stylesheet — rather than a
        mousedown handler, because the OS already knows how to move a window and
        reimplementing it is how a drag comes to feel wrong.
      */}
      <div className="pet-moss" title="Drag to move">
        <img src="./marimo-logo.png" alt="Marimo" draggable={false} />
        <div className="pet-hover-actions">
          <Copy text={lastAnswer(shown, agent.live?.text)} what="last answer" />
        </div>
      </div>
    </div>
  );
}

/** The most recent thing the agent said, for the copy button. */
function lastAnswer(
  messages: readonly TranscriptMessage[],
  live: string | undefined,
): string {
  if (live !== undefined && live.length > 0) {
    return live;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.text.length > 0) {
      return message.text;
    }
  }
  return '';
}
