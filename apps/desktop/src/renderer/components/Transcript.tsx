/**
 * The conversation on screen.
 *
 * Text is rendered as text, not as markup. The model's answer is untrusted input
 * — it can contain anything a web page can, because it may be quoting one — so
 * the renderer never turns it into HTML. Markdown arrives with its own pass in
 * the UI milestone, where it can be done with a renderer that escapes by
 * construction rather than by a regex somebody has to keep correct.
 */
import {useEffect, useLayoutEffect, useRef, useState} from 'react';

import type {PendingGate, TranscriptMessage} from '@marimo/protocol';

import {shouldFollow, shouldOfferJump} from '../scroll.js';
import {Copy, Markdown} from './Markdown.js';

import type {LiveToolCall, LiveTurn} from '../hooks/useAgent.js';

/** A call, collapsed to one line, with its result folded away behind it. */
function ToolCall({call}: {call: LiveToolCall}): React.JSX.Element {
  const summary =
    typeof call.args === 'object' && call.args !== null
      ? Object.values(call.args as Record<string, unknown>)
          .filter((value) => typeof value === 'string')
          .slice(0, 1)
          .join('')
      : '';

  return (
    <details className="call" data-state={call.ok === undefined ? 'running' : call.ok ? 'ok' : 'failed'}>
      <summary className="call-head">
        <span className="call-mark" aria-hidden="true">
          {call.ok === undefined ? '…' : call.ok ? '✓' : '✕'}
        </span>
        <code className="call-name">{call.tool}</code>
        {summary.length > 0 && <span className="call-args">{summary}</span>}
      </summary>
      {call.result !== undefined && (
        <pre className="call-result">{call.result}</pre>
      )}
    </details>
  );
}

/**
 * A gate, as a card.
 *
 * The hint is the server's or the tool's own description of what it is about to
 * do — it is the whole reason the card is readable, and it is shown verbatim
 * rather than paraphrased.
 */
function ApprovalCard({
  gate,
  onDecide,
}: {
  gate: PendingGate;
  onDecide: (callId: string, confirmed: boolean) => void;
}): React.JSX.Element {
  const waited = describeWait(gate.askedAt);

  return (
    <div className="approval" role="group" aria-label={`Approve ${gate.tool}`}>
      <div className="approval-head">
        <strong>{titleFor(gate.tool)}</strong>
        <code className="approval-tool">{gate.tool}</code>
      </div>
      <pre className="approval-hint">{gate.hint || JSON.stringify(gate.args, null, 2)}</pre>
      <div className="approval-foot">
        <span className="approval-waited">waiting {waited}</span>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            onDecide(gate.callId, false);
          }}
        >
          Deny
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            onDecide(gate.callId, true);
          }}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function Message({
  message,
  onFeedback,
}: {
  message: TranscriptMessage;
  onFeedback?: (
    messageId: string,
    excerpt: string,
    correction?: string,
  ) => Promise<boolean>;
}): React.JSX.Element {
  /**
   * Whether the correction box is open, and what has been typed into it.
   *
   * Local to the message rather than lifted: two answers on screen can be judged
   * at once in principle, and a single piece of state in the transcript would
   * make opening the second close the first.
   */
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState('');
  const [noted, setNoted] = useState(false);

  /*
   * What a compaction wrote, in place of the messages it replaced. Drawn as its
   * own thing rather than as a user's bubble — the words are the model's, and the
   * role is the user's only because that is how the provider is sent it — and it
   * says where the messages went, because "fewer messages than I wrote" is the
   * one thing about compaction that reads as loss.
   */
  if (message.compacted !== undefined) {
    return (
      <article className="message message-compacted">
        <div className="compacted-head">
          <span className="compacted-label">Compacted history</span>
          <Copy text={message.text} what="summary" />
        </div>
        <p className="compacted-note">
          {message.compacted === 1
            ? 'One earlier message was replaced by this summary.'
            : `${String(message.compacted)} earlier messages were replaced by this summary.`}{' '}
          They are still in this conversation&rsquo;s file — the agent is simply
          not sent them any more.
        </p>
        <div className="bubble bubble-answer">
          <Markdown text={message.text} />
        </div>
      </article>
    );
  }

  return (
    <article className={`message message-${message.role}`}>
      {message.toolCalls !== undefined && message.toolCalls.length > 0 && (
        <div className="calls">
          {message.toolCalls.map((call) => (
            <ToolCall key={call.callId} call={call} />
          ))}
        </div>
      )}
      {message.text.length > 0 && (
        message.role === 'assistant' ? (
          <div className="bubble bubble-answer">
            <Markdown text={message.text} />
            <div className="bubble-actions">
              <Copy text={message.text} what="answer" />
              {/*
               * The one place the user can say an answer was wrong. Offered only
               * on a stored message and never on the live one: a turn still
               * arriving is not one to judge, and the live bubble carries a
               * turn id rather than the message id this records against.
               */}
              {onFeedback !== undefined && !noted && (
                <button
                  type="button"
                  className="button button-quiet bubble-note"
                  onClick={() => {
                    setCorrecting((open) => !open);
                  }}
                >
                  Not quite
                </button>
              )}
              {noted && (
                <span className="bubble-noted" role="status">
                  Noted
                </span>
              )}
            </div>
            {correcting && onFeedback !== undefined && (
              <form
                className="bubble-correction"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onFeedback(
                    message.id,
                    message.text,
                    correction,
                  ).then((ok) => {
                    if (ok) {
                      setNoted(true);
                      setCorrecting(false);
                      setCorrection('');
                    }
                  });
                }}
              >
                <label htmlFor={`correction-${message.id}`}>
                  What was wrong, or what is right instead?
                </label>
                <div className="bubble-correction-row">
                  <input
                    id={`correction-${message.id}`}
                    type="text"
                    value={correction}
                    maxLength={400}
                    placeholder="Optional — the agent will read this next time"
                    onChange={(event) => {
                      setCorrection(event.target.value);
                    }}
                  />
                  <button type="submit" className="button button-primary button-small">
                    Send
                  </button>
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => {
                      setCorrecting(false);
                    }}
                  >
                    Never mind
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="bubble">{message.text}</div>
        )
      )}
      {message.error !== undefined && message.error.length > 0 && (
        <p className="message-error">{message.error}</p>
      )}
    </article>
  );
}

export function Transcript({
  messages,
  outbox,
  live,
  pending,
  onDecide,
  onFeedback,
  busy,
}: {
  messages: TranscriptMessage[];
  /**
   * The user's words while they are sent but not yet read back from the
   * conversation. Drawn in the position the stored copy will take, so the turn
   * ending does not move it.
   */
  outbox: string | null;
  live: LiveTurn | null;
  pending: PendingGate[];
  onDecide: (callId: string, confirmed: boolean) => void;
  /**
   * Records that an answer was wrong. Absent in a caller with nowhere to put it.
   *
   * Optional rather than required because the transcript is also drawn in tests
   * and in states where the agent is not answering — and a prop the component
   * cannot do without would make every one of those carry a stub.
   */
  onFeedback?: (
    messageId: string,
    excerpt: string,
    correction?: string,
  ) => Promise<boolean>;
  busy: boolean;
}): React.JSX.Element {
  const empty =
    messages.length === 0 &&
    outbox === null &&
    live === null &&
    pending.length === 0;

  const view = useRef<HTMLDivElement>(null);
  const [jumpable, setJumpable] = useState(false);
  /*
   * Whether to follow is decided from the geometry *before* the new content
   * arrived, which is why it is a ref rather than a comparison made after the
   * render: by then the element is already taller and the view looks further from
   * the bottom than the user left it.
   */
  const follow = useRef(true);

  const onScroll = (): void => {
    const element = view.current;
    if (element === null) {
      return;
    }
    const geometry = {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
    follow.current = shouldFollow(geometry);
    setJumpable(shouldOfferJump(geometry));
  };

  /*
   * Runs before the browser paints, so streamed text never appears a frame late
   * and then jumps. A `useEffect` here would show the new text at the old scroll
   * position first, which reads as a stutter on every token.
   */
  useLayoutEffect(() => {
    const element = view.current;
    if (element === null || !follow.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
    setJumpable(false);
  });

  /*
   * A new conversation starts at the bottom, whatever the last one was doing.
   * Keyed on emptiness rather than on the messages themselves, so arriving text
   * does not re-run it and fight the follow rule above.
   */
  const blank = messages.length === 0 && outbox === null && live === null;
  useEffect(() => {
    follow.current = true;
    setJumpable(false);
    const element = view.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [blank]);

  return (
    <div className="transcript-wrap">
    <div
      className="transcript"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      ref={view}
      onScroll={onScroll}
    >
      {empty && (
        <div className="empty">
          <img className="empty-mark" src="./marimo-logo.png" alt="" />
          <h2>Say something to Marimo</h2>
          <p>
            It can read and write files in the space you chose, and use whatever
            else you have switched on — anything that changes something asks you
            first.
          </p>
        </div>
      )}

      {messages.map((message) => (
        <Message
          key={message.id}
          message={message}
          {...(onFeedback === undefined ? {} : {onFeedback})}
        />
      ))}

      {outbox !== null && (
        <article className="message message-user">
          <div className="bubble">{outbox}</div>
        </article>
      )}

      {live !== null && (
        <article className="message message-assistant">
          {live.toolCalls.length > 0 && (
            <div className="calls">
              {live.toolCalls.map((call) => (
                <ToolCall key={call.callId} call={call} />
              ))}
            </div>
          )}
          {live.text.length > 0 && (
            <div className="bubble bubble-answer">
              <Markdown text={live.text} />
            </div>
          )}
          {live.running && live.text.length === 0 && (
            <div className="bubble thinking" aria-label="Working">
              <span />
              <span />
              <span />
            </div>
          )}
        </article>
      )}

      {pending.map((gate) => (
        <ApprovalCard key={gate.callId} gate={gate} onDecide={onDecide} />
      ))}

      {/*
        The turn is on its way but has not streamed its first event, so there is
        no live copy to hang the dots on yet. The same dots in the same shape as
        the live article's, because waiting is one thing and should look like
        one — the paragraph that used to be here could not draw at all, since
        `busy` was defined as a live turn running and this branch requires none.
      */}
      {busy && pending.length === 0 && live === null && (
        <article className="message message-assistant">
          <div className="bubble thinking" aria-label="Working">
            <span />
            <span />
            <span />
          </div>
        </article>
      )}
    </div>

      {/*
        Offered only once somebody has clearly stopped following. A button that
        appeared the moment they scrolled a line would flicker in and out while
        they read, which is worse than not offering one.
      */}
      {jumpable && (
        <button
          type="button"
          className="jump"
          onClick={() => {
            const element = view.current;
            if (element !== null) {
              element.scrollTop = element.scrollHeight;
            }
            follow.current = true;
            setJumpable(false);
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** The heading on a card, in the words of the thing being asked about. */
function titleFor(tool: string): string {
  if (tool === 'run_shell') {
    return 'Run this command?';
  }
  if (tool === 'write_file') {
    return 'Write this file?';
  }
  return `Use ${tool}?`;
}

/**
 * How long a card has waited, in the roughest useful unit.
 *
 * Rough on purpose: the question a person is asking is "did I leave this
 * overnight", not "how many seconds".
 */
function describeWait(askedAt: string): string {
  const then = Date.parse(askedAt);
  if (!Number.isFinite(then)) {
    return 'a moment';
  }
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) {
    return 'a moment';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
