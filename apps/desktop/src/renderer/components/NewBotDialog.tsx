/**
 * Making a bot from Settings, with the same three doors as first run.
 *
 * The setup flow is not the only place a bot is made: somebody who skipped it,
 * or who wants a second one months later, arrives here. Reusing the starter
 * cards and the same draft keeps the two entry points from disagreeing about
 * what a Writer is or how a blank bot is seeded.
 */
import {useState} from 'react';

import type {AgentProfile, BotDraft, BotTemplate} from '@marimo/protocol';

import {describe} from '../describe.js';
import {BotTemplatePicker} from './BotTemplatePicker.js';

export function NewBotDialog({
  templates,
  delegationTool,
  builderTool,
  lead,
  onCreated,
  onStartBuilder,
  onClose,
}: {
  templates: readonly BotTemplate[];
  delegationTool?: string;
  builderTool?: string;
  /** The lead, for the delegate and draft grants this dialog writes. */
  lead: AgentProfile | undefined;
  /** Re-reads Settings after a bot exists. */
  onCreated: () => Promise<void>;
  /** Hands over to the builder conversation; the App closes Settings. */
  onStartBuilder: () => Promise<{ok: boolean; problem?: string}>;
  onClose: () => void;
}): React.JSX.Element {
  const [templateId, setTemplateId] = useState<string | undefined>(
    templates[0]?.id,
  );
  const [name, setName] = useState(templates[0]?.suggestedName ?? '');
  const [delegate, setDelegate] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const selected = templates.find((template) => template.id === templateId);
  const alreadyDelegates =
    delegationTool !== undefined &&
    (lead?.enabledTools.includes(delegationTool) ?? false);

  const make = async (draft: BotDraft): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await window.marimo.call('profiles.create', {draft});
      if (
        delegate &&
        delegationTool !== undefined &&
        lead !== undefined &&
        !lead.enabledTools.includes(delegationTool)
      ) {
        await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, delegationTool]},
        });
      }
      await onCreated();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  const startBuilder = async (): Promise<void> => {
    if (builderTool === undefined) {
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      if (lead !== undefined && !lead.enabledTools.includes(builderTool)) {
        await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, builderTool]},
        });
      }
      const started = await onStartBuilder();
      if (!started.ok) {
        setProblem(started.problem ?? 'Could not start the conversation.');
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="new-bot">
      <div className="new-bot-head">
        <span>New bot</span>
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={saving}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>

      <BotTemplatePicker
        templates={templates}
        selectedId={templateId}
        busy={saving}
        onSelect={(id) => {
          setTemplateId(id);
          const template = templates.find((entry) => entry.id === id);
          setName(template?.suggestedName ?? '');
        }}
      />

      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) {
            return;
          }
          const trimmed = name.trim();
          void make({
            ...(trimmed.length === 0 ? {} : {name: trimmed}),
            ...(templateId === undefined ? {} : {templateId}),
          });
        }}
      >
        <label className="settings-field">
          <span>Its name</span>
          <em className="settings-why">
            {selected === undefined
              ? 'Leave it blank for a generic bot; the store will name it.'
              : `The ${selected.label} starter fills in its Role, Persona and abilities.`}
          </em>
          <input
            className="settings-input"
            type="text"
            value={name}
            placeholder={selected?.suggestedName ?? 'Writer'}
            spellCheck={false}
            disabled={saving}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>

        {delegationTool !== undefined && (
          <label className="settings-check">
            <input
              type="checkbox"
              checked={alreadyDelegates || delegate}
              disabled={saving || alreadyDelegates}
              onChange={(event) => {
                setDelegate(event.target.checked);
              }}
            />
            <span>
              Let Marimo Bot hand work to it
              <em className="settings-why">
                {alreadyDelegates
                  ? 'Marimo Bot can already do this.'
                  : 'Without it, Marimo Bot can talk about this bot but cannot ask it to do anything.'}
              </em>
            </span>
          </label>
        )}

        {problem !== null && <p className="settings-problem">{problem}</p>}

        <div className="onboarding-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={saving}
          >
            {selected === undefined ? 'Make a blank bot' : `Make this ${selected.label}`}
          </button>
          {builderTool !== undefined && (
            <button
              type="button"
              className="button button-quiet"
              disabled={saving}
              onClick={() => {
                void startBuilder();
              }}
            >
              Ask Marimo to help
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
