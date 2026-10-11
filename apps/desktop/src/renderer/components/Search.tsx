/**
 * Search: find things by meaning, and read them where they lie.
 *
 * The window's own use of recall, and the reason the feature exists as more than
 * a tool: a person who half-remembers where something is should not have to ask a
 * model to look it up, and should not need one running to do it. It talks to the
 * same service the agent's `recall` tool does, so the scores, the caps and the
 * claims about staleness are the same ones the model sees.
 *
 * Three things it deliberately does not do. It does not index on its own: the
 * query path refreshes in bounded slices, and a search box that decided to embed
 * a thousand files because somebody typed a letter would be a window that stops
 * answering. It does not hide the scores, because "0.79" and "0.31" are the
 * difference between a good result and the only result. And it does not pretend a
 * result is current: a hit whose file has changed since it was indexed says so
 * instead of showing text that is no longer there.
 */
import {useEffect, useRef, useState} from 'react';

import type {RecallQueryHit, RecallQueryResult} from '@marimo/protocol';

import './search.css';

/** How long typing settles before a query goes out. */
const DEBOUNCE_MS = 220;
/** How many results the list asks for. The service clamps it. */
const LIMIT = 30;

export function Search({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RecallQueryResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The newest query's sequence number.
   *
   * Answers are matched to questions rather than to arrival order: a slow reply
   * to the third letter must not overwrite the results for the eighth, which is
   * exactly what a debounced box does when somebody types fast and the engine is
   * cold.
   */
  const sequence = useRef(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResult(null);
      setSelected(0);
      return;
    }
    const mine = sequence.current + 1;
    sequence.current = mine;
    setBusy(true);
    const timer = setTimeout(() => {
      void window.marimo
        .call('recall.query', {query: trimmed, limit: LIMIT})
        .then((answer) => {
          if (sequence.current !== mine) {
            return;
          }
          setResult(answer);
          setSelected(0);
          setProblem(null);
        })
        .catch((failure: unknown) => {
          if (sequence.current === mine) {
            setProblem(failure instanceof Error ? failure.message : String(failure));
          }
        })
        .finally(() => {
          if (sequence.current === mine) {
            setBusy(false);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [open, query]);

  if (!open) {
    return null;
  }

  const hits = result?.hits ?? [];
  const current = hits[selected];
  const grouped = group(hits);

  return (
    <div
      className="search-backdrop"
      role="dialog"
      aria-label="Search"
      /*
       * A click on the dark area closes it, and the panel is what stops that:
       * comparing the target to the backdrop rather than checking whether the
       * panel contains it means a click on a result cannot bubble out and shut
       * the thing the person was reading.
       */
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="search">
        <div className="search-head">
          <input
            className="search-field"
            autoFocus
            placeholder="Find something by what it means…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onClose();
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((current) => Math.min(current + 1, hits.length - 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((current) => Math.max(current - 1, 0));
              }
            }}
          />
          {/*
            The way out, in the corner where people look for it. Escape works and
            always did, but a panel with nothing to click is one somebody sits in.
          */}
          <button
            type="button"
            className="search-close"
            aria-label="Close search"
            title="Close (Esc)"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {problem !== null && <p className="search-note">{problem}</p>}

        {result !== null && (
          <div className="search-body">
            <ul className="search-list">
              {grouped.map((group) => (
                <li key={group.label}>
                  <p className="search-group">{group.label}</p>
                  <ul>
                    {group.hits.map((hit) => {
                      const at = hits.indexOf(hit);
                      return (
                        <li key={`${hit.path}:${String(hit.startLine ?? 0)}:${hit.section ?? ''}`}>
                          <button
                            type="button"
                            className={
                              at === selected
                                ? 'search-hit search-hit-on'
                                : 'search-hit'
                            }
                            onClick={() => setSelected(at)}
                          >
                            <span className="search-where">{where(hit)}</span>
                            <span className="search-score">{hit.score.toFixed(2)}</span>
                            <span className="search-preview">
                              {hit.stale ? 'changed since it was indexed' : hit.preview}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
              {hits.length === 0 && (
                <li className="search-note">
                  {busy ? 'Searching…' : 'Nothing found.'}
                </li>
              )}
            </ul>

            <div className="search-preview-pane">
              {current === undefined ? (
                <p className="search-note">
                  {result.notes.length > 0
                    ? result.notes.join(' ')
                    : 'Type at least two characters.'}
                </p>
              ) : (
                <>
                  <p className="search-where">{where(current)}</p>
                  {current.stale ? (
                    <p className="search-note">
                      This file has changed since it was indexed, so its text is
                      not shown. It will be indexed again the next time you search.
                    </p>
                  ) : (
                    <pre className="search-text">{current.text}</pre>
                  )}
                </>
              )}
              {result.notes.length > 0 && hits.length > 0 && (
                <p className="search-note">{result.notes.join(' ')}</p>
              )}
              <p className="search-note search-foot">
                {result.index.records === 0
                  ? 'Nothing is indexed yet.'
                  : `${String(result.index.records)} item(s) indexed`}
                {result.index.changed > 0
                  ? ` · ${String(result.index.changed)} changed since`
                  : ''}
              </p>
            </div>
          </div>
        )}

        {result === null && (
          <p className="search-note search-foot">
            Meaning, not spelling: ask for what you are looking for.
          </p>
        )}
      </div>
    </div>
  );
}

/** The results, grouped by what they came from. */
function group(hits: readonly RecallQueryHit[]): Array<{
  label: string;
  hits: RecallQueryHit[];
}> {
  const memory = hits.filter((hit) => hit.kind === 'memory');
  const files = hits.filter((hit) => hit.kind === 'text');
  const groups: Array<{label: string; hits: RecallQueryHit[]}> = [];
  if (files.length > 0) {
    groups.push({label: 'In this folder', hits: files});
  }
  if (memory.length > 0) {
    groups.push({label: 'From memory', hits: memory});
  }
  return groups;
}

/** Where a hit is, in the words a person can act on. */
function where(hit: RecallQueryHit): string {
  return hit.kind === 'memory'
    ? `memory — ${hit.section ?? ''}`
    : `${hit.path}:${String(hit.startLine ?? 1)}-${String(hit.endLine ?? 1)}`;
}
