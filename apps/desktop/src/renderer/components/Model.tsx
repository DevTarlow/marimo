/**
 * What answers the questions.
 *
 * One model, two sizes of it, and this card is where both facts live: which size
 * the app chose for this machine and why, and the switch to disagree with it.
 *
 * The card is drawn at both sizes, and the difference is the point. Simple gets
 * what is answering and whether it is running. Power gets the tier, the download,
 * the temperature, the Start and Stop buttons and the engine's own paths, command
 * line and last words — every one of those is a number to tune or a failure to
 * diagnose, and hiding a diagnosis from the person who can act on it is worse than
 * the noise of showing it.
 *
 * Two things here are not decoration. The reason line is the plan's own sentence,
 * shown verbatim, because it is the only account of *why* this machine got the tier
 * it got — and a user who disagrees needs to see what was assumed before they
 * override it. And the size of the download is on the button, because 4.5 GB is
 * somebody's afternoon.
 *
 * Nothing here starts the engine. A read of the status is a read; starting is a
 * button, a question, or the app warming it after launch. A card that loaded
 * gigabytes of weights because somebody opened Settings would be a card nobody
 * opens twice.
 */
import {useCallback, useEffect, useState} from 'react';

import {MODEL_TIER_CHOICES} from '@marimo/protocol';
import type {LocalModelStatus, ModelTierChoice, PublicSettings} from '@marimo/protocol';

import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';
import type {ModelProgress} from '../hooks/useAgent.js';
import {SettingsSection} from './SettingsSection.js';

/** How often to look again while the engine is loading. */
const STARTING_POLL_MS = 500;

/** What the three choices say, in the order the picker draws them. */
const TIER_LABELS: Record<ModelTierChoice, string> = {
  auto: 'Automatic — the best this computer can run',
  low: 'Low — the smaller download',
  high: 'High — the larger download, needs more video memory',
};

export function Model({
  opened,
  onToggle,
  power,
  progress,
  revision,
  onChange,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /** Whether the power screen is showing. */
  power: boolean;
  /** A download in flight, from the event stream. */
  progress: ModelProgress | null;
  /** Changes when the model files do, so this re-reads them. */
  revision: number;
  /** Told after a write, so the rest of the dialog re-reads what changed. */
  onChange?: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The temperature while the slider is being dragged.
   *
   * Held apart from the stored value because the write happens when the gesture
   * ends, and a slider whose handle snapped back to the stored number between
   * steps would be unusable.
   */
  const [temperatureDraft, setTemperatureDraft] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [measured, loaded] = await Promise.all([
        window.marimo.call('localModel.status', {}),
        window.marimo.call('settings.get', {}),
      ]);
      setStatus(measured);
      setSettings(loaded.settings);
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  /*
   * A load in progress is the one state worth watching, because it is the only one
   * that changes on its own. Every other state is changed by something the user
   * did, and every one of those re-reads afterwards.
   */
  useEffect(() => {
    if (status?.state !== 'starting') {
      return undefined;
    }
    const timer = setInterval(() => {
      void load();
    }, STARTING_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [status?.state, load]);

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await load();
      onChange?.();
    } catch (failure) {
      setProblem(describe(failure));
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** Saves the dragged temperature, and only when it moved. */
  const commitTemperature = (): void => {
    const next = temperatureDraft;
    setTemperatureDraft(null);
    if (next === null || settings === null || next === settings.temperature) {
      return;
    }
    void run(async () => {
      await window.marimo.call('settings.set', {patch: {temperature: next}});
    });
  };

  if (settings === null || status === null) {
    return (
      <SettingsSection title="Model" opened={opened} onToggle={onToggle}>
        <p className="settings-muted">{problem ?? 'Reading…'}</p>
      </SettingsSection>
    );
  }

  const chosen = status.tiers.find((tier) => tier.name === status.tier);
  const wanted = chosen !== undefined && !chosen.installed ? chosen.bytes : 0;
  const blocked = status.enginePresent && !status.runnable;

  return (
    <SettingsSection title="Model" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        One model, run on this computer&rsquo;s graphics card, so nothing you type
        leaves it — and there is no account and no key to set up. It comes in two
        sizes; the app picks the largest this machine can hold.
      </p>

      <ModelStatusLine status={status} />

      {blocked && (
        <p className="settings-problem">
          {status.problem ?? 'This machine cannot run the model.'}
        </p>
      )}

      {!blocked && (
        <>
          <h4 className="settings-group">What it runs</h4>
          <p className="settings-muted">
            {status.tierLabel} at{' '}
            {String(Math.round(status.contextSize / 1024))}K context
            {status.backend === undefined ? '' : `, on ${status.backend}`}.
          </p>
          {/* The plan's own sentence: it is the only account of why this machine
              got this tier, and somebody about to override it needs to see what
              was assumed. */}
          <p className="settings-muted">{status.reason}</p>

          {/*
            Only once the engine has been asked. Before that `fits` is false
            because nothing has probed the hardware, and "it may not fit" about a
            machine nobody has asked is a warning about the wrong thing — the real
            state is that nothing is downloaded yet.
          */}
          {status.enginePresent && !status.fits && (
            <p className="settings-problem">
              The estimate says this will not fit in video memory. It may fail to
              start.
            </p>
          )}

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
              <p className="settings-muted">
                {progress.label}: {formatBytes(progress.receivedBytes)} of{' '}
                {formatBytes(progress.totalBytes)}
              </p>
            </div>
          )}

          <div className="settings-row">
            {progress === null ? (
              <button
                type="button"
                className="button button-quiet"
                disabled={busy || !status.enginePresent || !status.runnable}
                onClick={() => {
                  void run(async () => {
                    await window.marimo.call('localModel.install', {});
                  });
                }}
              >
                {status.modelPresent
                  ? 'Check for updates'
                  : wanted > 0
                    ? `Download (${formatBytes(wanted)})`
                    : 'Download'}
              </button>
            ) : (
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    await window.marimo.call('localModel.cancel', {});
                  });
                }}
              >
                Stop downloading
              </button>
            )}
          </div>
        </>
      )}

      {power && (
        <>
          <h4 className="settings-group">Which size</h4>
          <label className="settings-field">
            <span>Model size</span>
            <select
              className="settings-input"
              aria-label="Model size"
              value={settings.modelTier}
              disabled={busy}
              onChange={(event) => {
                const next = MODEL_TIER_CHOICES.find(
                  (choice) => choice === event.target.value,
                );
                if (next === undefined) {
                  return;
                }
                void run(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {modelTier: next},
                  });
                });
              }}
            >
              {MODEL_TIER_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {TIER_LABELS[choice]}
                </option>
              ))}
            </select>
            <em className="settings-why">
              {status.tiers
                .map(
                  (tier) =>
                    `${tier.label}: ${formatBytes(tier.bytes)}, ` +
                    `${String(Math.round(tier.contextSize / 1024))}K context` +
                    `${tier.installed ? ', downloaded' : ''}`,
                )
                .join(' · ')}
            </em>
          </label>

          <label className="settings-field">
            <span>
              Temperature{' '}
              <strong className="settings-value">
                {(temperatureDraft ?? settings.temperature).toFixed(1)}
              </strong>
            </span>
            <em className="settings-why">
              How much it varies its wording. Low is literal and repeatable, high is
              more inventive and more likely to wander. 0.7 is the default; below
              0.3 a small model starts repeating itself.
            </em>
            <input
              className="settings-input"
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperatureDraft ?? settings.temperature}
              disabled={busy}
              aria-label="Temperature"
              onChange={(event) => {
                setTemperatureDraft(Number(event.target.value));
              }}
              onPointerUp={commitTemperature}
              onKeyUp={commitTemperature}
            />
          </label>

          <div className="settings-row">
            <button
              type="button"
              className="button button-quiet"
              disabled={busy || status.state === 'starting' || !status.modelPresent}
              onClick={() => {
                void run(async () => {
                  await window.marimo.call('localModel.start', {});
                });
              }}
            >
              {status.state === 'ready' ? 'Restart' : 'Start'}
            </button>
            <button
              type="button"
              className="button button-quiet"
              disabled={busy || status.state === 'off'}
              onClick={() => {
                void run(async () => {
                  await window.marimo.call('localModel.stop', {});
                });
              }}
            >
              Stop
            </button>
          </div>

          <>
            <h4 className="settings-group">What the app runs</h4>
            <p className="settings-muted">
              The engine and the file, and the exact command line it is given. Every
              path here is worth reading when something does not work: this is what a
              machine other than this one would have to do to run the same model.
            </p>
            <p className="settings-muted">
              Engine <code className="settings-tool">{status.enginePath}</code>
            </p>
            <p className="settings-muted">
              Weights <code className="settings-tool">{status.modelPath}</code>
            </p>
            <pre className="model-command">
              {status.command.join(' \\\n  ')}
            </pre>
            {status.log.length > 0 && (
              <>
                <h4 className="settings-group">What it last said</h4>
                <pre className="model-command">
                  {status.log.slice(-12).join('\n')}
                </pre>
              </>
            )}
          </>

          {/*
            The attribution, where somebody who cares can find it. Both halves are
            other people's work: an Apache-2.0 model and an MIT engine, and shipping
            them quietly would be taking the credit.
          */}
          <p className="settings-why">
            Qwen3.5-4B (Apache-2.0), quantized by unsloth; run by llama.cpp (MIT).
          </p>
        </>
      )}

      {problem !== null && <p className="settings-problem">{problem}</p>}
    </SettingsSection>
  );
}

/**
 * One line saying whether the model is up, and why not when it is not.
 *
 * The failure cases are listed rather than collapsed into "not ready", because
 * they are fixed in different places: a download that has not happened is a
 * button, and an engine that refused is a sentence from llama.cpp that names its
 * own cause.
 */
function ModelStatusLine({
  status,
}: {
  status: LocalModelStatus;
}): React.JSX.Element {
  /* The same dot the connector cards use, in the same three states. */
  const dot = (state: string): React.JSX.Element => (
    <span className="connector-dot" data-state={state} aria-hidden="true" />
  );

  if (!status.enginePresent) {
    return (
      <p className="settings-muted">
        {dot('off')} Not downloaded yet. The engine is about 32 MB and the model
        follows it.
      </p>
    );
  }
  if (!status.runnable) {
    return (
      <p className="settings-muted">
        {dot('error')} No usable graphics card was found.
      </p>
    );
  }
  if (!status.modelPresent) {
    return (
      <p className="settings-muted">
        {dot('off')} The {status.tierLabel} model is not downloaded yet.
      </p>
    );
  }

  switch (status.state) {
    case 'ready':
      return (
        <p className="settings-muted">
          {dot('online')} Ready, and answering on this machine.
        </p>
      );
    case 'starting':
      return (
        <p className="settings-muted">
          {dot('connecting')} Loading the model… The first question waits for this;
          later ones do not.
        </p>
      );
    case 'failed':
      return (
        <p className="settings-muted">
          {dot('error')} {status.detail ?? 'The model did not start.'}
        </p>
      );
    default:
      return (
        <p className="settings-muted">
          {dot('off')} Not running. It starts by itself when you ask something.
        </p>
      );
  }
}
