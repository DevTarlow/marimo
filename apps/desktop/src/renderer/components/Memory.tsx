/**
 * Memory, in two halves: how much of it there is, and what the agent would add.
 *
 * The size control is first because it is what the rest is measured against. A
 * byte limit means nothing on its own — "8 KB" is not a quantity anybody has a
 * feel for — so it is drawn as a slider in kilobytes beside a readout of the
 * file it applies to, with the line the agent is warned at made visible. That
 * readout is the same number the agent's `read_memory` quotes, read from the
 * same place, so the bar cannot drift from the warning.
 *
 * The proposals are the other half. Long-term memory is injected into every
 * future system prompt, so a wrong entry is not a wrong answer once — it is a
 * wrong belief carried into every later conversation. The agent proposes and the
 * user decides.
 *
 * Both buttons remove an entry, and that is deliberate: a suggestion that stayed
 * after being refused would be proposed again on every idle look, and a queue
 * that refills itself with things already rejected is one nobody reads.
 */
import {useEffect, useState} from 'react';

import {
  DEFAULT_MEMORY_SOFT_LIMIT_BYTES,
  MEMORY_SOFT_LIMIT_MAX_BYTES,
  MEMORY_SOFT_LIMIT_MIN_BYTES,
} from '@marimo/protocol';
import type {MemoryProposal, MemoryUsage} from '@marimo/protocol';

import {formatKiB, summarizeMemory} from '../memory-format.js';
import {SettingsSection} from './SettingsSection.js';

export function Memory({
  opened,
  onToggle,
  onChange,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  onChange?: () => void;
}): React.JSX.Element {
  const [proposals, setProposals] = useState<MemoryProposal[] | null>(null);
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  /**
   * The slider's own value while it is being dragged.
   *
   * Held apart from `usage.limitBytes` so dragging is smooth: the stored value
   * only changes when the pointer is released, and a slider whose handle snapped
   * back to the old number between steps would be unusable.
   */
  const [draftLimit, setDraftLimit] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const [listed, measured] = await Promise.all([
        window.marimo.call('memory.proposals', {}),
        window.marimo.call('memory.usage', {}),
      ]);
      setProposals(listed.proposals);
      setUsage(measured);
      setDraftLimit(null);
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const resolve = async (id: string, accept: boolean): Promise<void> => {
    setBusy(true);
    setProblem(null);
    /*
     * Taken out of the list straight away rather than after the round trip. The
     * button has been pressed, and an entry that stays put invites a second
     * press — which on the accept side would write the same fact twice.
     */
    setProposals((current) =>
      (current ?? []).filter((proposal) => proposal.id !== id),
    );
    try {
      const result = await window.marimo.call('memory.resolve', {
        proposalId: id,
        accept,
      });
      /*
       * A refusal — the agent cannot be built right now — puts it back rather
       * than pretending it worked. It is still in the store, and the next look
       * at this panel will find it.
       */
      if (!result.ok) {
        setProblem(result.problem ?? 'That suggestion could not be saved.');
      }
      await load();
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
      await load();
    } finally {
      setBusy(false);
    }
  };

  /*
   * Saved when the drag ends rather than on every step. A slider fires an event
   * per pixel, and writing the settings file on each one would be a burst of disk
   * writes for what is one decision.
   */
  const commitLimit = async (bytes: number): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('settings.set', {
        patch: {memorySoftLimitBytes: bytes},
      });
      await load();
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
      setDraftLimit(null);
    } finally {
      setBusy(false);
    }
  };

  const summary = usage === null ? null : summarizeMemory(usage);
  const limit =
    draftLimit ?? usage?.limitBytes ?? DEFAULT_MEMORY_SOFT_LIMIT_BYTES;

  return (
    <SettingsSection title="Memory" opened={opened} onToggle={onToggle}>
      {usage === null ? (
        <p className="settings-muted">{problem ?? 'Reading…'}</p>
      ) : (
        <>
          <p className="settings-muted">
            What this agent remembers about you and your work. The whole file is
            shown to it at the start of every conversation, so the smaller it is
            the less of each prompt it takes up.
          </p>

          <div
            className={`memory-meter memory-meter-${summary?.pressure ?? 'room'}`}
          >
            <div
              className="memory-meter-fill"
              style={{width: `${String(summary?.percent ?? 0)}%`}}
              role="img"
              aria-label={summary?.size ?? ''}
            />
          </div>
          <p className="memory-readout">{summary?.size}</p>
          <p className="settings-why">{summary?.detail}</p>

          <label className="memory-limit">
            <span className="memory-limit-label">
              Ask it to prune past{' '}
              <strong className="memory-limit-value">{formatKiB(limit)}</strong>
            </span>
            <input
              type="range"
              min={MEMORY_SOFT_LIMIT_MIN_BYTES}
              max={MEMORY_SOFT_LIMIT_MAX_BYTES}
              step={1024}
              value={limit}
              disabled={busy}
              aria-label="Memory size before the agent is asked to prune"
              onChange={(event) => {
                setDraftLimit(Number(event.target.value));
              }}
              onPointerUp={() => {
                void commitLimit(limit);
              }}
              onKeyUp={() => {
                void commitLimit(limit);
              }}
            />
            <span className="memory-limit-range">
              <span>{formatKiB(MEMORY_SOFT_LIMIT_MIN_BYTES)}</span>
              <span>{formatKiB(MEMORY_SOFT_LIMIT_MAX_BYTES)}</span>
            </span>
          </label>
        </>
      )}

      <h4 className="memory-proposals-heading">What it would remember</h4>
      <p className="settings-muted">
        After a conversation goes quiet, the agent reads it back and suggests
        what is worth keeping. These are shown to it at the start of every
        future conversation, so it asks before writing one down.
      </p>

      {proposals === null ? (
        <p className="settings-muted">Reading…</p>
      ) : proposals.length === 0 ? (
        <p className="settings-muted">
          Nothing waiting. Most conversations have nothing in them worth keeping
          — that is the expected answer, not a problem.
        </p>
      ) : (
        proposals.map((proposal) => (
          <div className="memory-item" key={proposal.id}>
            <p className="memory-text">{proposal.text}</p>
            {proposal.reason.length > 0 && (
              <details className="memory-why">
                <summary>Why it suggested this</summary>
                <p>{proposal.reason}</p>
              </details>
            )}
            <div className="memory-actions">
              <span className="memory-section">{proposal.section}</span>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy}
                onClick={() => {
                  void resolve(proposal.id, false);
                }}
              >
                Don&rsquo;t remember
              </button>
              <button
                type="button"
                className="button button-primary button-small"
                disabled={busy}
                onClick={() => {
                  void resolve(proposal.id, true);
                }}
              >
                Remember
              </button>
            </div>
          </div>
        ))
      )}

      {problem !== null && (
        <p className="connector-detail connector-error">{problem}</p>
      )}
    </SettingsSection>
  );
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}
