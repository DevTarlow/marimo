/**
 * What answers the questions.
 *
 * The card that makes the app work before anybody configures anything: a fresh
 * install has this model, it needs no account, no key and no address, and
 * nothing the user types leaves the machine. Every other provider is a choice
 * somebody makes deliberately — usually because they have an account and want
 * better answers than 1.7B can give — and that choice lives in the power screen
 * with the address and the key it needs.
 *
 * The card is drawn at both sizes, and the difference is the point. Simple gets
 * *what is answering* and one way out. Power gets the file, the context window,
 * the thinking switch, the engine's own command line and the last thing it said,
 * because every one of those is a number to tune or a failure to diagnose — and
 * hiding a diagnosis from the person who can act on it is worse than the noise
 * of showing it.
 *
 * Nothing here starts the engine. A read of the status is a read; starting is a
 * button, or a question, or the app warming it after launch. A card that loaded
 * a gigabyte of weights because somebody opened Settings would be a card nobody
 * opens twice.
 */
import {useEffect, useState} from 'react';

import {PROVIDERS} from '@marimo/protocol';
import type {LocalModelStatus, PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

/** How often to look again while the engine is loading. */
const STARTING_POLL_MS = 500;

export function Model({
  opened,
  onToggle,
  power,
  onChooseService,
  onChange,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /** Whether the power screen is showing. */
  power: boolean;
  /** Turns on the power screen and opens the Provider card, from simple mode. */
  onChooseService: () => void;
  /** Told after a write, so the rest of the dialog re-reads what changed. */
  onChange?: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  /** Writes the dragged context window, and only when it moved. */
  const commitContextSize = (): void => {
    void run(async () => {
      await window.marimo.call('settings.set', {
        patch: {localModel: {contextSize: settings?.localModel.contextSize}},
      });
    });
  };

  if (settings === null) {
    return (
      <SettingsSection title="Model" opened={opened} onToggle={onToggle}>
        <p className="settings-muted">{problem ?? 'Reading…'}</p>
      </SettingsSection>
    );
  }

  const active = settings.providers.active;
  const descriptor = PROVIDERS[active];
  const managed = active === 'builtin';
  const config = settings.providers.configs[active];

  return (
    <SettingsSection title="Model" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        {managed
          ? 'The model this app comes with. It runs on this computer, so ' +
            'nothing you type leaves it — and there is no account and no key to ' +
            'set up.'
          : `${descriptor?.label ?? active} answers your questions, over the ` +
            'internet and with the key you gave it.'}
      </p>

      {managed ? (
        <ModelStatusLine status={status} />
      ) : (
        <p className="settings-muted">
          Model <code className="settings-tool">{config.model}</code> at{' '}
          <code className="settings-tool">{config.baseUrl}</code>.
        </p>
      )}

      {power && managed && (
        <>
          <h4 className="settings-group">How it runs</h4>
          <label className="settings-field">
            <span>
              Model file
              <em className="settings-why">
                Leave this empty to use the copy that came with the app. Point
                it at a <code>.gguf</code> of your own to run something else — a
                bigger model, a different quantization, or one you already had.
              </em>
            </span>
            <input
              className="settings-input"
              type="text"
              spellCheck={false}
              aria-label="Model file"
              value={settings.localModel.ggufPath}
              disabled={busy}
              onChange={(event) => {
                const ggufPath = event.target.value;
                setSettings({
                  ...settings,
                  localModel: {...settings.localModel, ggufPath},
                });
              }}
              onBlur={() => {
                void run(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {
                      localModel: {ggufPath: settings.localModel.ggufPath},
                    },
                  });
                });
              }}
            />
          </label>

          <label className="settings-field">
            <span>
              Context window{' '}
              <strong className="settings-value">
                {settings.localModel.contextSize.toLocaleString()} tokens
              </strong>
              <em className="settings-why">
                How much of the conversation the model can hold at once. Larger
                answers more of a long chat and costs memory that grows with
                every message; the model itself was trained for far more than
                this.
              </em>
            </span>
            <input
              className="settings-input"
              type="range"
              min={2048}
              max={32768}
              step={2048}
              disabled={busy}
              aria-label="Context window"
              value={settings.localModel.contextSize}
              onChange={(event) => {
                const contextSize = Number(event.target.value);
                setSettings({
                  ...settings,
                  localModel: {...settings.localModel, contextSize},
                });
              }}
              onPointerUp={commitContextSize}
              onKeyUp={commitContextSize}
            />
          </label>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.localModel.thinking}
              disabled={busy}
              onChange={(event) => {
                const thinking = event.target.checked;
                void run(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {localModel: {thinking}},
                  });
                });
              }}
            />
            <span>
              Let it think before answering
              <em className="settings-why">
                Slower and sometimes better on a hard question; it makes every
                easy one take seconds longer. Off is what most questions want.
              </em>
            </span>
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

      {!power && (
        <div className="settings-row">
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={onChooseService}
          >
            Use a service I have an account with
          </button>
        </div>
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
        <code className="settings-tool">{status.modelPath}</code> — or point the
        field below at a <code>.gguf</code> you already have.
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
