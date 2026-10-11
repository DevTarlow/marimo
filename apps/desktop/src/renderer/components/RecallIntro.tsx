/**
 * The offer that follows the model download.
 *
 * A fresh install has one moment where somebody is waiting for something and is
 * disposed to answer a question: right after their model lands. This is that
 * moment, and it is spent on the one capability that is invisible until it is
 * used — a person cannot miss tools that write files, and they cannot *imagine*
 * search by meaning until they have tried it.
 *
 * Three decisions behind the copy:
 *
 * - **It says what it gives them, not what it is.** "Finds things by what you
 *   mean" and an example, rather than "embeddings" and a vector width.
 * - **It says the costs, because they are the reason somebody would say no.**
 *   One download, the processor rather than the graphics card, and nothing
 *   leaving the machine. A card that hid those would be asking for consent it
 *   had not earned.
 * - **`Not now` is a real answer.** It is not a nag: this appears once, in the
 *   session where the model was downloaded, and after that the switch lives in
 *   Settings where every other capability lives.
 */
import {useCallback, useEffect, useState} from 'react';

import type {PublicSettings, RecallModelStatus} from '@marimo/protocol';

import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';

export function RecallIntro({
  onDone,
}: {
  /** Called when the user has answered — either way. */
  onDone: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<RecallModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.marimo.call('recall.status', {}));
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The download's own events, subscribed here rather than carried up through the
   * app: this screen is the only thing that draws them, and it goes away when the
   * user answers.
   */
  useEffect(() => {
    return window.marimo.onEvent((event) => {
      if (event.type === 'recall.failed') {
        setProblem(event.message);
      }
      if (
        event.type === 'recall.progress' ||
        event.type === 'recall.installed' ||
        event.type === 'recall.indexed'
      ) {
        if (event.type === 'recall.installed') {
          setReady(true);
        }
        void load();
      }
    });
  }, [load]);

  /**
   * Turning it on, in the three steps it actually is.
   *
   * All three happen on one press because the user is answering *this* question —
   * "do you want the thing that searches by meaning" — and leaving one of them for
   * them to find in Settings is how a feature comes to be switched on and do
   * nothing. Granting the tool is a write to their profile, and it is the same
   * write choosing a capability preset makes.
   */
  const turnOn = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const {settings} = await window.marimo.call('settings.set', {
        patch: {recall: {enabled: true}},
      });
      await grantTool(settings);
      await window.marimo.call('recall.install', {piece: 'text'});
      await load();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const installed = status?.textPresent ?? false;
  const installing = status?.installing;
  const size = formatBytes(status?.sizeBytes.text ?? 0);

  return (
    <div className="onboarding">
      <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
      <h2>One more thing, and it is the interesting one</h2>

      <p className="onboarding-lead">
        Your agent can read the folder you give it. <strong>Recall</strong> lets
        it — and you — <em>find</em> things in there by what you mean, and in what
        it has remembered about you.
      </p>

      <p className="onboarding-note">
        Ask “why does the upload keep failing” and it lands on the retry code,
        even though neither of you said “retry”. Ask “what did we decide about the
        folders thing” and it finds the note from three weeks ago. In this window
        it is <strong>Ctrl+K</strong>: type what you are looking for, and read the
        lines where they live.
      </p>

      <p className="onboarding-note">
        It is one {size} download and it runs on your processor, beside the model
        that answers questions, so it does not compete for video memory. Nothing
        you search with it leaves this computer.
      </p>

      {installing !== undefined && (
        <div className="model-progress">
          <div
            className="model-progress-bar"
            role="progressbar"
            aria-valuenow={installing.percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={installing.label}
          >
            <span style={{width: `${String(installing.percent ?? 0)}%`}} />
          </div>
          <p className="onboarding-note">
            {installing.label}: {formatBytes(installing.receivedBytes)} of{' '}
            {formatBytes(installing.totalBytes)}
            {installing.percent === undefined
              ? ''
              : ` (${String(installing.percent)}%)`}
          </p>
        </div>
      )}

      <div className="onboarding-actions">
        {installed || ready ? (
          <button
            type="button"
            className="button button-primary"
            onClick={onDone}
          >
            Start using it
          </button>
        ) : installing === undefined ? (
          <button
            type="button"
            className="button button-primary"
            disabled={busy || status === null}
            onClick={() => {
              void turnOn();
            }}
          >
            Turn on Recall ({size})
          </button>
        ) : (
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={() => {
              void window.marimo.call('recall.cancel', {}).then(() => load(), () => load());
            }}
          >
            Stop downloading
          </button>
        )}

        <button
          type="button"
          className="button button-quiet"
          onClick={onDone}
        >
          {installed || ready ? 'Close' : 'Not now'}
        </button>
      </div>

      {problem !== null && <p className="settings-problem">{problem}</p>}

      <p className="onboarding-note onboarding-quiet">
        You can turn this on or off whenever you like, in Settings → Recall.
      </p>
    </div>
  );
}

/**
 * Allows the agent to use it.
 *
 * The tool is a capability like every other, so it lives in a grant on the
 * profile — and a feature that is switched on while the agent is not allowed to
 * use it is the failure this app's whole tool list exists to prevent. The write
 * is additive: nothing the user has already granted is taken away.
 */
async function grantTool(settings: PublicSettings): Promise<void> {
  const profile = settings.profiles.find(
    (entry) => entry.id === settings.activeProfileId,
  );
  if (profile === undefined || profile.enabledTools.includes('recall')) {
    return;
  }
  await window.marimo.call('profiles.update', {
    profileId: profile.id,
    patch: {enabledTools: [...profile.enabledTools, 'recall']},
  });
}
