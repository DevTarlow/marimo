/**
 * The first thing a new install should say.
 *
 * It used to be a screen that asked for an API key, and then one that said what
 * was ready. It is a download now, because the app carries no weights: a fresh
 * install has a graphics card and nothing to run on it, and the honest first screen
 * is the one that fetches the model and says how far along it is.
 *
 * Two things about it are deliberate.
 *
 * **It reads the status rather than guessing.** What to offer — a download, a
 * resume, or nothing at all — depends on whether the engine is here, whether the
 * machine can take a tier, and which tiers are already on disk. That is four states
 * and only the main process can tell them apart, so this asks.
 *
 * **A machine that cannot run the model is told so, once.** There is no CPU path,
 * so a machine with no usable device is not a download waiting to happen; it is a
 * dead end, and the sentence says what is missing rather than offering a button
 * that would end in the same place.
 */
import {useCallback, useEffect, useState} from 'react';

import type {LocalModelStatus} from '@marimo/protocol';

import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';
import type {ModelProgress} from '../hooks/useAgent.js';

export function Onboarding({
  problem,
  progress,
  revision,
  onOpenSettings,
  onChanged,
}: {
  /** Why the app cannot answer, in the words of whoever knew. */
  problem: string;
  /** A download in flight, if one is. */
  progress: ModelProgress | null;
  /** Changes when the model files do, so this re-reads them. */
  revision: number;
  onOpenSettings: () => void;
  /** Told after a download starts or is cancelled, so the window re-reads. */
  onChanged?: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.marimo.call('localModel.status', {}));
    } catch (problem) {
      setFailure(describe(problem));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const start = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await window.marimo.call('localModel.install', {});
      await load();
      onChanged?.();
    } catch (problem) {
      setFailure(describe(problem));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.marimo.call('localModel.cancel', {});
      await load();
    } catch (problem) {
      setFailure(describe(problem));
    } finally {
      setBusy(false);
    }
  };

  /*
   * The engine is fetched first and is the first thing missing, so it is what
   * decides whether this screen offers a download at all. Its absence is not a
   * hardware verdict — nothing has asked the hardware yet.
   */
  const needsEngine = status !== null && !status.enginePresent;
  const blocked = status !== null && status.enginePresent && !status.runnable;
  const needsWeights =
    status !== null &&
    status.enginePresent &&
    status.runnable &&
    !status.modelPresent;
  const wanted =
    status === null
      ? 0
      : (status.tiers.find((tier) => !tier.installed)?.bytes ?? 0);

  return (
    <div className="onboarding">
      <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
      <h2>Welcome to Marimo Agent</h2>

      {blocked ? (
        <>
          <p className="onboarding-lead">
            This computer cannot run the model, so the agent has nothing to think
            with.
          </p>
          {/*
            The plan's own sentence: it knows which card it asked and what it
            heard, and a rewrite here would be a second, vaguer account.
          */}
          <p className="onboarding-note">{status.problem ?? problem}</p>
        </>
      ) : (
        <>
          <p className="onboarding-lead">
            {needsEngine || needsWeights
              ? 'The agent needs to download its model before it can answer. This is the one time it needs the network.'
              : problem}
          </p>

          {progress !== null && (
            <div className="model-progress">
              <div
                className="model-progress-bar"
                role="progressbar"
                aria-valuenow={progress.percent ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={progress.label}
              >
                <span style={{width: `${String(progress.percent ?? 0)}%`}} />
              </div>
              <p className="onboarding-note">
                {progress.label}: {formatBytes(progress.receivedBytes)} of{' '}
                {formatBytes(progress.totalBytes)}
                {progress.percent === undefined
                  ? ''
                  : ` (${String(progress.percent)}%)`}
              </p>
            </div>
          )}

          {(needsEngine || needsWeights) && progress === null && status !== null && (
            <p className="onboarding-note">
              {status.tierLabel} model at{' '}
              {String(Math.round(status.contextSize / 1024))}K context
              {wanted > 0 ? `, about ${formatBytes(wanted)} to download` : ''}.
            </p>
          )}

          <div className="onboarding-actions">
            {progress === null ? (
              <button
                type="button"
                className="button button-primary"
                disabled={busy || status === null}
                onClick={() => {
                  void start();
                }}
              >
                {needsEngine || needsWeights ? 'Download the model' : 'Continue'}
              </button>
            ) : (
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  void cancel();
                }}
              >
                Stop downloading
              </button>
            )}
            <button
              type="button"
              className="button button-quiet"
              onClick={onOpenSettings}
            >
              Open Settings
            </button>
          </div>
        </>
      )}

      {failure !== null && <p className="settings-problem">{failure}</p>}

      <p className="onboarding-note onboarding-quiet">
        It can read files in the folder you choose and use whatever else you
        switch on. Anything that changes something asks you first.
      </p>
    </div>
  );
}
