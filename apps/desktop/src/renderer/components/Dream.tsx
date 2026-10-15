/**
 * Dream-RSI: the agent records its own search tree, and you can measure what
 * different settings would have done to it.
 *
 * The card is one switch and two numbers, and the two numbers are the whole
 * feature. Everything else about it — the recorder, the tree format, the replay —
 * is machinery with nothing worth turning, which is why this is the smallest card
 * in the power screen rather than the largest.
 *
 * Three decisions shape it.
 *
 * **Power only.** The exploration weight and the pruning threshold are numbers to
 * adjust, and this screen's own rule is that a number to adjust belongs in power
 * while a switch that fixes something stays where the user is. Somebody who never
 * opens this card is running the same agent they were before the feature existed.
 *
 * **The pruning warning is on the card, not in a tooltip.** Pruning is the one
 * setting here whose failure mode is invisible: an agent that has been stopped
 * from using a tool answers competently and wrongly, and nothing on screen says
 * so. A control whose damage cannot be seen afterwards has to say what it does
 * beforehand.
 *
 * **The card says where the logs are and how to replay them.** The replay is a
 * command, and a feature whose only payoff is a command nobody knows about is a
 * feature that writes files for no reason. The path is drawn as text rather than
 * linked, because the window is a renderer with no filesystem access and a link
 * that opened nothing would be worse than the string.
 */
import {useCallback, useEffect, useState} from 'react';

import {
  DEFAULT_DREAM_EXPLORATION_WEIGHT,
  DEFAULT_DREAM_PRUNING_THRESHOLD,
  DREAM_EXPLORATION_MAX,
  DREAM_EXPLORATION_MIN,
  DREAM_PRUNING_MAX,
  DREAM_PRUNING_MIN,
} from '@marimo/protocol';
import type {PublicSettings} from '@marimo/protocol';

import {describe} from '../describe.js';
import {SettingsSection} from './SettingsSection.js';

export function Dream({
  opened,
  onToggle,
  onChange,
}: {
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /** Told after a write landed, so the dialog re-reads the settings. */
  onChange: () => void;
}): React.JSX.Element {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The last write the recorder could not do, as the main process reports it.
   *
   * Separate from `problem` above, which is this card's own failures: this one is
   * a fact about the agent's turns, so it does not clear when the card manages to
   * read the settings — only when a write succeeds.
   */
  const [recording, setRecording] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const loaded = await window.marimo.call('settings.get', {});
      setSettings(loaded.settings);
      setRecording(loaded.settings.dreamProblem ?? null);
      setProblem(null);
    } catch (failure) {
      setProblem(describe(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Writes one field of the block, or says why it could not. */
  const set = async (patch: Partial<PublicSettings['dream']>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('settings.set', {patch: {dream: patch}});
      await load();
      onChange();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const dream = settings?.dream;
  const enabled = dream?.enabled ?? false;

  return (
    <SettingsSection title="Dream-RSI" opened={opened} onToggle={onToggle}>
      <p className="settings-muted">
        Records what the agent tried on each turn — which tools it called, with
        what arguments, and how each call turned out — as a tree of decisions.
        The trees stay on this machine, and a command replays them to show what
        different search settings would have done, without asking the model
        anything.
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
        Record the agent's search trees
      </label>

      {enabled && (
        <>
          <p className="settings-muted">
            This writes a file per conversation containing every tool call and
            the first part of every result. It is not sent anywhere, and turning
            this off stops it immediately — it does not delete what is already
            there.
          </p>

          <label className="settings-check settings-field">
            <span>
              Exploration weight
              <em>
                How much an untried tool is worth. 0 means the agent only repeats
                what has already worked; higher means it keeps trying new things.
                The default of {DEFAULT_DREAM_EXPLORATION_WEIGHT} leaves the
                first choice to the model.
              </em>
            </span>
            <input
              className="settings-input"
              type="number"
              min={DREAM_EXPLORATION_MIN}
              max={DREAM_EXPLORATION_MAX}
              step={0.5}
              value={dream?.explorationWeight ?? DEFAULT_DREAM_EXPLORATION_WEIGHT}
              disabled={busy}
              onChange={(event) => {
                const explorationWeight = Number(event.target.value);
                /*
                 * A field being cleared passes through values the schema
                 * refuses, and writing one would be a failed call under a
                 * spinner. Only a usable number is written; the box keeps
                 * showing what is stored until then.
                 */
                if (
                  Number.isFinite(explorationWeight) &&
                  explorationWeight >= DREAM_EXPLORATION_MIN &&
                  explorationWeight <= DREAM_EXPLORATION_MAX
                ) {
                  void set({explorationWeight});
                }
              }}
            />
          </label>

          <label className="settings-check settings-field">
            <span>
              Pruning threshold
              <em>
                A tool whose average result falls below this stops being offered
                to the model for the rest of the turn. {DREAM_PRUNING_MIN} turns
                pruning off, which is the default.
              </em>
            </span>
            <input
              className="settings-input"
              type="number"
              min={DREAM_PRUNING_MIN}
              max={DREAM_PRUNING_MAX}
              step={0.5}
              value={dream?.pruningThreshold ?? DEFAULT_DREAM_PRUNING_THRESHOLD}
              disabled={busy}
              onChange={(event) => {
                const pruningThreshold = Number(event.target.value);
                if (
                  Number.isFinite(pruningThreshold) &&
                  pruningThreshold >= DREAM_PRUNING_MIN &&
                  pruningThreshold <= DREAM_PRUNING_MAX
                ) {
                  void set({pruningThreshold});
                }
              }}
            />
          </label>

          {/*
            The warning belongs here rather than in the sentence above the
            field. Pruning is the one control on this screen whose damage is
            invisible after the fact — the agent answers from less than it could
            have, competently and wrongly — so what it costs has to be said
            before the number is typed rather than discovered later.
          */}
          <p className="settings-muted">
            <strong>Before you raise the threshold:</strong> a pruned tool is
            removed from what the model can see, so it cannot ask for it again
            that turn. Set too eagerly it will hide a tool the turn needed, and
            the answer will read as confident rather than incomplete. The default
            prunes nothing. Use the replay command below to measure a threshold
            against your own recorded turns before you rely on it.
          </p>
        </>
      )}

      {/*
        The command is drawn whether or not the switch is on, and that is the
        point rather than an oversight: turning the recording off stops new files
        and deletes nothing, so the trees already on disk are exactly what
        somebody who just turned it off wants to read. A payoff that disappears
        with the switch would leave them with files and no way to open them.
      */}
      <p className="settings-muted">
        Replay the recorded turns, offline and with no model running:
        <br />
        <code>pnpm replay:dream</code>
      </p>

      {enabled && recording !== null && (
        /*
         * A switch that is on while nothing is being written is the one state
         * this card must not misrepresent — the user turned it on to have a
         * record, and the record is not happening.
         */
        <div className="error" role="alert">
          <span>
            The last search tree could not be written: {recording}
          </span>
        </div>
      )}

      {problem !== null && <div className="error">{problem}</div>}
    </SettingsSection>
  );
}
