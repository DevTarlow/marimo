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
 * The model picker is here rather than in Settings because it is a fact about
 * *this* conversation: which model answers the question being typed. It chooses
 * for the conversation only, and the popover offers the way back to the app
 * default, so using it once does not pin the chat for good.
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

import type {PickedFile, SkippedFile} from '@marimo/protocol';

import {composeMessage, describeSkipped} from '../attachments.js';
import {describe} from '../describe.js';
import {ModelPicker} from './ModelPicker.js';
import {Popover, PopoverItem} from './Popover.js';
import type {PopoverAnchor} from './Popover.js';

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  models,
  model,
  usingDefault,
  onSelectModel,
  onPickFiles,
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
  /** The active provider's catalogue. Must contain `model`. */
  models: readonly string[];
  /** The model this conversation will use: its own choice, else the default. */
  model: string;
  /** True when that model is the app default rather than this chat's choice. */
  usingDefault: boolean;
  /** `null` gives up the choice, so the conversation follows the default again. */
  onSelectModel: (model: string | null) => Promise<void>;
  /**
   * Asks for files, judged against the folder this conversation works in.
   *
   * Rejects with a sentence when there is no folder to attach from; answers with
   * what was accepted and what was refused otherwise. A refusal is not an error —
   * a file outside the folder is a file the agent cannot read, and saying so is
   * the answer.
   */
  onPickFiles: () => Promise<{files: PickedFile[]; skipped: SkippedFile[]}>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<PickedFile[]>([]);
  /** The last thing that happened, drawn in the hint slot. */
  const [note, setNote] = useState<{text: string; failed: boolean} | null>(null);
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

  const hint =
    busy
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

          <div className="composer-model">
            <ModelPicker
              models={models}
              value={model}
              disabled={disabled}
              // Upwards: this box is at the bottom of the window.
              placement="above"
              {...(usingDefault ? {note: 'default'} : {})}
              {...(usingDefault
                ? {}
                : {
                    onUseDefault: () => {
                      void onSelectModel(null);
                    },
                  })}
              onChange={(next) => {
                void onSelectModel(next);
              }}
            />
          </div>
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
        </Popover>
      )}
    </div>
  );
}
