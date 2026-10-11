/**
 * What answers the questions.
 *
 * There is one model and the app carries it, so this card is not a choice — it is
 * *what is answering* and whether it is up. That is the whole of "it works when
 * you install it": no account, no key, no address, and nothing the user types
 * leaving the machine.
 *
 * The card is drawn at both sizes, and the difference is the point. Simple gets
 * what is answering and whether it is running. Power gets the temperature, the
 * Start and Stop buttons, and the engine's own paths, command line and last words
 * — every one of those is a number to tune or a failure to diagnose, and hiding a
 * diagnosis from the person who can act on it is worse than the noise of showing
 * it.
 *
 * Nothing here starts the engine. A read of the status is a read; starting is a
 * button, a question, or the app warming it after launch. A card that loaded a
 * gigabyte of weights because somebody opened Settings would be a card nobody
 * opens twice.
 */
import {useEffect, useState} from 'react';

import type {LocalModelStatus, PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

/** How often to look again while the engine is loading. */
const STARTING_POLL_MS = 500;

export function Model({
  opened,
  onToggle,
  power,
  onChange,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /** Whether the power screen is showing. */
  power: boolean;
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

  const load = async (): Promise<void> => {
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
  };

  useEffect(() => {
    void load();
  }, []);

  /*
   * A load in progress is the one state worth watching, because it is the only
   * one that changes on its own. Every other state is changed by something the
   * user did, and every one of those re-reads afterwards.
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
  }, [status?.state]);

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

  if (settings === null) {
    return (
      <SettingsSection title="Model" opened={opened} onToggle={onToggle}>
        <p className="settings-muted">{problem ?? 'Reading…'}</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Model" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        The model this app comes with. It runs on this computer, so nothing you
        type leaves it — and there is no account, no key and no address to set
        up.
      </p>

      <ModelStatusLine status={status} />

      {power && (
        <>
          <h4 className="settings-group">How it answers</h4>
          <label className="settings-field">
            <span>
              Temperature{' '}
              <strong className="settings-value">
                {(temperatureDraft ?? settings.temperature).toFixed(1)}
              </strong>
            </span>
            <em className="settings-why">
              How much it varies its wording. Low is literal and repeatable, high
              is more inventive and more likely to wander. 0.7 is the default;
              below 0.3 a small model starts repeating itself.
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
              disabled={busy || status?.state === 'starting'}
              onClick={() => {
                void run(async () => {
                  await window.marimo.call('localModel.start', {});
                });
              }}
            >
              {status?.state === 'ready' ? 'Restart' : 'Start'}
            </button>
            <button
              type="button"
              className="button button-quiet"
              disabled={busy || status?.state === 'off'}
              onClick={() => {
                void run(async () => {
                  await window.marimo.call('localModel.stop', {});
                });
              }}
            >
              Stop
            </button>
          </div>

          {status !== null && (
            <>
              <h4 className="settings-group">What the app runs</h4>
              <p className="settings-muted">
                The engine and the file, and the exact command line it is given.
                Every path here is worth reading when something does not work:
                this is what a machine other than this one would have to do to
                run the same model.
              </p>
              <p className="settings-muted">
                Engine{' '}
                <code className="settings-tool">{status.enginePath}</code>
              </p>
              <p className="settings-muted">
                Weights{' '}
                <code className="settings-tool">{status.modelPath}</code>
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
          )}

          {/*
            The attribution, where somebody who cares can find it. Both halves
            are other people's work: an Apache-2.0 model and an MIT engine, and
            shipping them quietly would be taking the credit.
          */}
          <p className="settings-why">
            Qwen3-1.7B (Apache-2.0), quantized by unsloth; run by llama.cpp
            (MIT).
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
 * they are fixed in different places: a file that is not where the app looks is
 * a path the user can act on, and an engine that refused is a sentence from
 * llama.cpp that names its own cause.
 */
function ModelStatusLine({
  status,
}: {
  status: LocalModelStatus | null;
}): React.JSX.Element {
  if (status === null) {
    return <p className="settings-muted">Checking the model…</p>;
  }

  /* The same dot the connector cards use, in the same three states. */
  const dot = (state: string): React.JSX.Element => (
    <span className="connector-dot" data-state={state} aria-hidden="true" />
  );

  if (!status.enginePresent) {
    return (
      <p className="settings-muted">
        {dot('error')} The model engine is not installed on this machine. It
        should be at <code className="settings-tool">{status.enginePath}</code>.
      </p>
    );
  }
  if (!status.modelPresent) {
    return (
      <p className="settings-muted">
        {dot('error')} The model file is not installed. It should be at{' '}
        <code className="settings-tool">{status.modelPath}</code>.
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
          {dot('connecting')} Loading the model… The first question waits for
          this; later ones do not.
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
