/**
 * Recall: the model that finds things by meaning, and what it has indexed.
 *
 * Off until somebody asks, and the button that asks names the size — a fresh
 * install downloading 310 MB because it felt like it is the failure Discord's
 * default exists to prevent. Everything below that switch is the answer to one of
 * two questions a user has: *is it working*, and *what has it read*.
 *
 * The card reads the status once when it opens and then subscribes to the four
 * recall events itself, rather than having the turn stream carry them up through
 * the app: this is the only thing in the window that draws them, and a download
 * that reported through the same channel as a conversation would be a progress bar
 * that appears in a chat.
 */
import {useCallback, useEffect, useState} from 'react';

import type {PublicSettings, RecallModelStatus, RecallPiece} from '@marimo/protocol';

import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

export function Recall({
  opened,
  onToggle,
  power,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /** Whether the power screen is showing, which draws the command line. */
  power: boolean;
}): React.JSX.Element {
  const [status, setStatus] = useState<RecallModelStatus | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [measured, loaded] = await Promise.all([
        window.marimo.call('recall.status', {}),
        window.marimo.call('settings.get', {}),
      ]);
      setStatus(measured);
      setSettings(loaded.settings);
      setProblem(null);
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The events, subscribed here. A download is the one thing in this app somebody
   * watches, and the card has to move while they watch it — including when the
   * download was started from somewhere else, which is why this is a subscription
   * rather than a state the button sets.
   */
  useEffect(() => {
    return window.marimo.onEvent((event) => {
      if (
        event.type === 'recall.progress' ||
        event.type === 'recall.installed' ||
        event.type === 'recall.failed' ||
        event.type === 'recall.indexed'
      ) {
        if (event.type === 'recall.failed') {
          setProblem(event.message);
        }
        void load();
      }
    });
  }, [load]);

  const set = async (patch: {
    enabled?: boolean;
    memory?: boolean;
    workspace?: boolean;
  }): Promise<void> => {
    setBusy(true);
    try {
      const {settings: saved} = await window.marimo.call('settings.set', {
        patch: {recall: patch},
      });
      setSettings(saved);
      await load();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const download = async (piece: RecallPiece): Promise<void> => {
    setBusy(true);
    try {
      await window.marimo.call('recall.install', {piece});
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const enabled = settings?.recall.enabled ?? false;
  const installed = status?.textPresent ?? false;
  const installing = status?.installing;
  const index = status?.index;

  return (
    <SettingsSection title="Recall" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        Finds things by what they mean rather than by the words they use: your
        folder, and the notes it keeps about you. It is what lets an answer to
        “why does the upload keep failing” find a passage about retries.
      </p>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => {
            void set({enabled: event.target.checked});
          }}
        />
        Remember and search by meaning
      </label>

      {problem !== null && <p className="settings-problem">{problem}</p>}

      {!enabled && (
        <p className="settings-muted">
          Off. Turning it on downloads {formatBytes(status?.sizeBytes.text ?? 0)} of
          model and runs it beside the one that answers questions — on the
          processor, so it does not compete for video memory.
        </p>
      )}

      {enabled && !installed && installing === undefined && (
        <>
          <p className="settings-muted">
            The model is not downloaded yet. It runs on the processor and needs
            about {formatBytes(status?.sizeBytes.text ?? 0)}.
          </p>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => {
              void download('text');
            }}
          >
            Download the recall model (
            {formatBytes(status?.sizeBytes.text ?? 0)})
          </button>
        </>
      )}

      {installing !== undefined && (
        <>
          <progress
            className="settings-progress"
            value={installing.receivedBytes}
            max={installing.totalBytes}
          />
          <p className="settings-muted">
            {installing.label}: {formatBytes(installing.receivedBytes)} of{' '}
            {formatBytes(installing.totalBytes)}
          </p>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              void window.marimo.call('recall.cancel', {});
            }}
          >
            Stop
          </button>
        </>
      )}

      {enabled && installed && (
        <>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings?.recall.workspace ?? true}
              disabled={busy}
              onChange={(event) => {
                void set({workspace: event.target.checked});
              }}
            />
            Index the folder this agent works in
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings?.recall.memory ?? true}
              disabled={busy}
              onChange={(event) => {
                void set({memory: event.target.checked});
              }}
            />
            Index what it remembers about you
          </label>

          <p className="settings-muted">
            {index === undefined || index.records === 0
              ? 'Nothing indexed in this folder yet. It is indexed the first time something is searched.'
              : `${String(index.records)} item(s) indexed — ${String(index.chunks)} from the folder and ${String(index.memory)} from memory.` +
                (index.changed > 0
                  ? ` ${String(index.changed)} file(s) have changed since.`
                  : '')}
          </p>

          <div className="settings-row">
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => {
                void window.marimo
                  .call('recall.reindex', {})
                  .then(() => load(), () => load());
              }}
            >
              Index now
            </button>
            <button
              type="button"
              className="button button-quiet button-small"
              disabled={busy}
              onClick={() => {
                void window.marimo
                  .call('recall.forget', {})
                  .then(() => load(), () => load());
              }}
            >
              Forget the index
            </button>
          </div>
          <p className="settings-muted">
            Forgetting removes what it has read. Your files and its notes are not
            touched.
          </p>
        </>
      )}

      {power && status !== null && (
        <details className="settings-detail">
          <summary>The engine</summary>
          <p className="settings-muted">
            {status.state}
            {status.detail === undefined ? '' : ` — ${status.detail}`}
          </p>
          <p className="settings-muted settings-path">
            {status.command.join(' ')}
          </p>
          {status.log.length > 0 && (
            <pre className="settings-log">{status.log.slice(-6).join('\n')}</pre>
          )}
        </details>
      )}
    </SettingsSection>
  );
}
