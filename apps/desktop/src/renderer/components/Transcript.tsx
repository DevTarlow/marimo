/**
 * The conversation on screen.
 *
 * Text is rendered as text, not as markup. The model's answer is untrusted input
 * — it can contain anything a web page can, because it may be quoting one — so
 * the renderer never turns it into HTML. Markdown arrives with its own pass in
 * the UI milestone, where it can be done with a renderer that escapes by
 * construction rather than by a regex somebody has to keep correct.
 */
import type {PendingGate, TranscriptMessage} from '@marimo/protocol';

import type {LiveSubagent, LiveToolCall, LiveTurn} from '../hooks/useAgent.js';

/**
 * A helper agent's work, folded into one group.
 *
 * Closed by default once it has finished, open while it runs: a helper exists to
 * keep detail *out* of the conversation, so unfolding it after the fact would
 * undo the reason it was spawned. While it is working the opposite is true —
 * something that shows nothing for thirty seconds reads as a hang.
 */
function SubagentGroup({
  helper,
  live,
}: {
  helper: LiveSubagent;
  live: boolean;
}): React.JSX.Element {
  const running = helper.ok === undefined;
  const failed = helper.ok === false;

  return (
    <details
      className="helper"
      open={live || failed}
      data-state={running ? 'running' : failed ? 'failed' : 'ok'}
    >
      <summary className="helper-head">
        <span className="helper-mark" aria-hidden="true">
          {running ? '…' : failed ? '✕' : '✓'}
        </span>
        <span className="helper-name">{helper.name}</span>
        <span className="helper-task">{helper.task}</span>
      </summary>
      {helper.text.length > 0 && <div className="helper-text">{helper.text}</div>}
      {helper.error !== undefined && (
        <p className="helper-error">{helper.error}</p>
      )}
    </details>
  );
}

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

function Message({message}: {message: TranscriptMessage}): React.JSX.Element {
  return (
    <article
      className={`message message-${message.role}`}
      /*
       * A helper's words are kept visually apart from the agent's. They are in
       * one conversation because an approval asked by a helper has to be visible
       * here, and without a mark the summary that follows reads as if the helper
       * wrote it.
       */
      data-subagent={message.subagent ?? undefined}
    >
      {message.subagent !== undefined && (
        <div className="helper-label">
          <span className="helper-mark" aria-hidden="true">
            ⤷
          </span>
          {message.subagent}
        </div>
      )}
      {message.toolCalls !== undefined && message.toolCalls.length > 0 && (
        <div className="calls">
          {message.toolCalls.map((call) => (
            <ToolCall key={call.callId} call={call} />
          ))}
        </div>
      )}
      {message.text.length > 0 && (
        <div className="bubble">{message.text}</div>
      )}
      {message.error !== undefined && message.error.length > 0 && (
        <p className="message-error">{message.error}</p>
      )}
    </article>
  );
}

export function Transcript({
  messages,
  live,
  pending,
  onDecide,
  busy,
}: {
  messages: TranscriptMessage[];
  live: LiveTurn | null;
  pending: PendingGate[];
  onDecide: (callId: string, confirmed: boolean) => void;
  busy: boolean;
}): React.JSX.Element {
  const empty = messages.length === 0 && live === null && pending.length === 0;

  return (
    <div className="transcript" role="log" aria-live="polite" aria-label="Conversation">
      {empty && (
        <div className="empty">
          <img className="empty-mark" src="./marimo-logo.png" alt="" />
          <h2>Say something to Marimo</h2>
          <p>
            It can read and write files in the folder you chose, and use whatever
            else you have switched on — anything that changes something asks you
            first.
          </p>
        </div>
      )}

      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}

      {live !== null && (
        <article className="message message-assistant">
          {live.toolCalls.length > 0 && (
            <div className="calls">
              {live.toolCalls.map((call) => (
                <ToolCall key={call.callId} call={call} />
              ))}
            </div>
          )}
          {live.subagents.map((helper) => (
            <SubagentGroup key={helper.callId} helper={helper} live={live.running} />
          ))}
          {live.text.length > 0 && <div className="bubble">{live.text}</div>}
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

      {busy && pending.length === 0 && live === null && (
        <p className="working-note">Working…</p>
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
