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
 * left and the keyboard hint beside it. The textarea grows with what is in it up
 * to a point, because a prompt worth sending is often more than one line and a
 * box that scrolls after two lines hides the question the user is still writing.
 *
 * There is no model picker here any more. There was one, for a conversation's own
 * choice of model, and it went with the second model: a control that cannot
 * change what answers is a control that wastes a look.
 *
 * `+` is on the left of the same row, for the things a message can carry that
 * are not typed: a file to hand over, and the commands that act on the
 * conversation itself. Its menu opens upwards, which is what the popover
 * primitive already does when there is no room below — and there never is, at the
 * bottom of the window.
 *
 * While a turn is running the button becomes Stop rather than the box becoming
 * disabled. A disabled box is the wrong shape: people compose their next thought
 * while waiting, and taking the words away — or losing them on send — is how a
 * conversation gets interrupted by its own tooling.
 */
import {useEffect, useRef, useState} from 'react';

import type {CommandId, PickedFile, SkippedFile} from '@marimo/protocol';

import {composeMessage, describeSkipped} from '../attachments.js';
import {describe} from '../describe.js';
import {Popover, PopoverItem} from './Popover.js';
import type {PopoverAnchor} from './Popover.js';

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  onPickFiles,
  commands,
  onRunCommand,
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
  /**
   * Asks for files, judged against the folder this conversation works in.
   *
   * Rejects with a sentence when there is no folder to attach from; answers with
   * what was accepted and what was refused otherwise. A refusal is not an error —
   * a file outside the folder is a file the agent cannot read, and saying so is
   * the answer.
   */
  onPickFiles: () => Promise<{files: PickedFile[]; skipped: SkippedFile[]}>;
  /**
   * The commands the `+` menu offers — the ones Settings has not switched off.
   *
   * Passed in rather than looked up here, so the catalogue and the switch that
   * turns one off live in the same place: this component draws what it is given.
   */
  commands: readonly {id: CommandId; label: string; blurb: string}[];
  /**
   * Runs one, and answers with what to say about it.
   *
   * A note rather than a result object, because the only thing the composer can
   * do with an outcome is draw one line of it. A rejection is a genuine failure
   * and is drawn in the failure colour; a resolved note is news.
   */
  onRunCommand: (id: CommandId) => Promise<string | null>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<PickedFile[]>([]);
  /** The last thing that happened, drawn in the hint slot. */
  const [note, setNote] = useState<{text: string; failed: boolean} | null>(null);
  /** The command being run, so the row can say so while it does. */
  const [running, setRunning] = useState<CommandId | null>(null);
  const [menu, setMenu] = useState<PopoverAnchor | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const add = useRef<HTMLButtonElement>(null);

  /* Grow with the content, then stop. */
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const ready =
    (text.trim().length > 0 || attached.length > 0) && !busy && !disabled;

  const submit = async (): Promise<void> => {
    if (!ready) {
      return;
    }
    /*
     * Cleared only once the turn was accepted, and cleared as a pair: the words
     * and the files are one message, so a refusal must not leave the box empty
     * with two chips the user now has to remove by hand.
     */
    if (await onSend(composeMessage(text, attached))) {
      setText('');
      setAttached([]);
      setNote(null);
    }
  };

  const pick = async (): Promise<void> => {
    try {
      const {files, skipped} = await onPickFiles();
      if (files.length > 0) {
        setAttached((current) => [...current, ...files]);
      }
      const refused = describeSkipped(skipped);
      setNote(
        refused === null ? null : {text: `Not attached — ${refused}`, failed: true},
      );
    } catch (failure) {
      setNote({text: describe(failure), failed: true});
    }
  };

  const run = async (id: CommandId): Promise<void> => {
    setRunning(id);
    setNote(null);
    try {
      const answer = await onRunCommand(id);
      setNote(answer === null ? null : {text: answer, failed: false});
    } catch (failure) {
      setNote({text: describe(failure), failed: true});
    } finally {
      setRunning(null);
    }
  };

  const hint =
    running !== null
      ? 'Working…'
      : busy
        ? 'Working…'
        : note !== null
          ? note.text
          : 'Enter to send, Shift+Enter for a new line';

  return (
    <div className="composer">
      <div className="composer-box">
        {attached.length > 0 && (
          <div className="composer-chips">
            {attached.map((file) => (
              <span className="composer-chip" key={file.path} title={file.path}>
                <span className="composer-chip-name">{file.name}</span>
                <button
                  type="button"
                  className="composer-chip-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => {
                    setAttached((current) =>
                      current.filter((entry) => entry.path !== file.path),
                    );
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

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
          <button
            ref={add}
            type="button"
            className="composer-add"
            aria-label="Add files or run a command"
            title="Add files or run a command"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            disabled={disabled}
            onClick={() => {
              const rect = add.current?.getBoundingClientRect();
              setMenu(
                menu !== null || rect === undefined
                  ? null
                  : {top: rect.top, bottom: rect.bottom, left: rect.left},
              );
            }}
          >
            <span aria-hidden="true">+</span>
          </button>

          <span
            className={
              note === null || !note.failed
                ? 'composer-hint'
                : 'composer-hint is-failure'
            }
            role={note?.failed === true ? 'alert' : undefined}
          >
            {hint}
          </span>
        </div>
      </div>

      {menu !== null && (
        <Popover
          anchor={menu}
          label="Add to the message"
          onClose={() => {
            setMenu(null);
          }}
        >
          <PopoverItem
            onSelect={() => {
              setMenu(null);
              void pick();
            }}
          >
            Add files…
          </PopoverItem>

          {commands.length > 0 && (
            <>
              <div className="popover-sep" />
              <span className="popover-label">Commands</span>
              {commands.map((command) => (
                <PopoverItem
                  key={command.id}
                  // A command acts on the conversation the turn is running in, so
                  // it waits for the turn: the agent refuses mid-flight anyway,
                  // and a menu item that can only be refused is a dead control.
                  disabled={busy || running !== null}
                  onSelect={() => {
                    setMenu(null);
                    void run(command.id);
                  }}
                >
                  {command.label}
                </PopoverItem>
              ))}
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
