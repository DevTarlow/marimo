/**
 * What the agent would like to remember.
 *
 * The queue exists because long-term memory is injected into every future system
 * prompt: a wrong entry is not a wrong answer once, it is a wrong belief carried
 * into every later conversation. So the agent proposes and the user decides.
 *
 * Both buttons remove the entry, and that is deliberate. A suggestion that stayed
 * after being refused would be proposed again on every idle look, and a queue
 * that refills itself with things already rejected is one nobody reads.
 *
 * Kept short on purpose. The reviewer is told most conversations contain nothing
 * worth keeping, and this panel assumes the same: a handful of lines, each one
 * readable at a glance, with the reasoning folded away for when it is not
 * obvious why something was proposed.
 */
import {useEffect, useState} from 'react';

import type {MemoryProposal} from '@marimo/protocol';

export function Memory({onChange}: {onChange?: () => void}): React.JSX.Element {
  const [proposals, setProposals] = useState<MemoryProposal[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const result = await window.marimo.call('memory.proposals', {});
      setProposals(result.proposals);
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

  if (proposals === null) {
    return (
      <section className="settings-section">
        <h3>What it would remember</h3>
        <p className="settings-muted">{problem ?? 'Reading…'}</p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h3>What it would remember</h3>
      <p className="settings-muted">
        After a conversation goes quiet, the agent reads it back and suggests
        what is worth keeping. These are shown to it at the start of every future
        conversation, so it asks before writing one down.
      </p>

      {proposals.length === 0 ? (
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

      {problem !== null && <p className="connector-detail connector-error">{problem}</p>}
    </section>
  );
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}
