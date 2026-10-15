/**
 * A model pick-list that can be searched.
 *
 * The native `<select>` is the better control for the handful of models a
 * provider like DeepSeek serves: it is keyboard-familiar, it is drawn by the OS,
 * and it costs no code. OpenRouter answers its `/models` with several hundred,
 * and a select that long is a list you scroll rather than one you choose from —
 * so past a threshold the field becomes this instead.
 *
 * The one rule it keeps from the select it replaces: **the stored value is only
 * ever a model the provider listed.** The search box filters; it does not commit.
 * A free-text field would let a typo into the settings file, and a mistyped model
 * id is a 404 at the start of a turn, which reads as "the agent is broken"
 * rather than "that model does not exist".
 *
 * Two placements, because the same control is used in the two places a model can
 * be chosen: Settings, where it is a field in a form and the list opens under it,
 * and the composer, where the box sits at the bottom of the window and a list
 * that opened downwards would be off screen.
 */
import {useEffect, useId, useMemo, useRef, useState} from 'react';

import {filterModels} from '../model-search.js';

export function ModelPicker({
  models,
  value,
  disabled = false,
  placement = 'below',
  note,
  defaultChoice,
  onChange,
}: {
  /** What the provider offers. The caller guarantees `value` is among them. */
  models: readonly string[];
  value: string;
  disabled?: boolean;
  /** Which way the list opens. `below` unless the trigger is near the bottom. */
  placement?: 'below' | 'above';
  /**
   * A word after the value, for a value that is a fallback rather than a
   * choice — the composer's "agent", an agent row's "default". Inside the
   * trigger rather than beside it, so the button's own name says what it is
   * showing.
   */
  note?: string;
  /**
   * The row that gives the choice up, offered only when there is something to
   * give it up to.
   *
   * Without it the first use of the picker would pin the choice for good: a
   * conversation's model would stop following its agent, and an agent's would
   * stop following the app. The label travels with the handler because *what*
   * lies underneath differs — a conversation falls back to its agent, an agent
   * to the app — and a second, differently-worded button elsewhere would be the
   * same control drawn twice.
   */
  defaultChoice?: {label: string; onUse: () => void};
  onChange: (model: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  /*
   * React's id is unique per instance, which matters because the listbox and its
   * options are addressed by id and two pickers on one page must not collide.
   */
  const listId = useId();

  const matches = useMemo(() => filterModels(models, query), [models, query]);

  const close = (): void => {
    setOpen(false);
    setQuery('');
    setHighlight(0);
  };

  const choose = (model: string): void => {
    onChange(model);
    close();
  };

  /** Open on the model already selected, so Enter does not silently move it. */
  const openList = (): void => {
    const index = models.indexOf(value);
    setQuery('');
    setHighlight(index >= 0 ? index : 0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    /*
     * Closing on the document rather than on the field's blur: a click on an
     * option blurs the field first, and a blur handler that closed the list
     * would remove the option before the click could land on it.
     */
    const onPointerDown = (event: MouseEvent): void => {
      if (
        root.current !== null &&
        !root.current.contains(event.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      search.current?.focus();
    }
  }, [open]);

  /*
   * Keep the highlighted row in view when the arrow keys walk past the fold of a
   * three-hundred-row list. `nearest` rather than `center`: the list should move
   * only when the highlight would otherwise leave it.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    document
      .getElementById(`${listId}-option-${String(highlight)}`)
      ?.scrollIntoView({block: 'nearest'});
  }, [open, highlight, listId]);

  const active =
    matches[highlight] === undefined
      ? undefined
      : `${listId}-option-${String(highlight)}`;

  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        className="settings-input model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close();
          } else {
            openList();
          }
        }}
      >
        <span className="model-picker-value">{value}</span>
        {note !== undefined && (
          <span className="model-picker-note">{note}</span>
        )}
        <span className="model-picker-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className={
            placement === 'above'
              ? 'model-picker-popover is-above'
              : 'model-picker-popover'
          }
        >
          <input
            ref={search}
            className="settings-input model-picker-search"
            type="text"
            value={query}
            placeholder="Search models…"
            aria-label="Search models"
            aria-controls={listId}
            aria-activedescendant={active}
            aria-autocomplete="list"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setHighlight((current) =>
                  Math.max(0, Math.min(current + 1, matches.length - 1)),
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlight((current) => Math.max(current - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const model = matches[highlight];
                if (model !== undefined) {
                  choose(model);
                }
              } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          />

          {/*
            A button rather than one more option in the listbox: it is not a
            model, `aria-selected` would have nothing true to say about it, and
            folding it into the highlight arithmetic would move the keyboard off
            the row the user is actually on.
          */}
          {defaultChoice !== undefined && (
            <button
              type="button"
              className="model-picker-default"
              onClick={() => {
                close();
                defaultChoice.onUse();
              }}
            >
              {defaultChoice.label}
            </button>
          )}

          <ul
            id={listId}
            className="model-picker-list"
            role="listbox"
            aria-label="Models"
          >
            {matches.map((model, index) => (
              <li
                key={model}
                id={`${listId}-option-${String(index)}`}
                role="option"
                aria-selected={model === value}
                className={[
                  'model-picker-option',
                  index === highlight ? 'is-highlighted' : '',
                  model === value ? 'is-selected' : '',
                ]
                  .filter((name) => name.length > 0)
                  .join(' ')}
                onMouseDown={(event) => {
                  // Keep the search field focused through the click so the list
                  // does not close under the pointer.
                  event.preventDefault();
                }}
                onMouseEnter={() => {
                  setHighlight(index);
                }}
                onClick={() => {
                  choose(model);
                }}
              >
                {model}
              </li>
            ))}
            {matches.length === 0 && (
              <li className="model-picker-empty">
                No model matches &ldquo;{query.trim()}&rdquo;.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
