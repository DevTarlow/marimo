/**
 * Settings.
 *
 * The screen that makes "every capability is something the user turns on" true
 * rather than a description of a state nobody can leave. Until this existed the
 * grants were a hardcoded default with no way to change them.
 *
 * The tool list is drawn in two groups, and the grouping is the point. Twenty
 * checkboxes with no distinction between reading a file and running a shell
 * command is a list nobody can make a decision from — so the ones that merely
 * look are separated from the ones that can change something, and the second
 * group says what is at stake.
 *
 * Saving is immediate per switch rather than behind a Save button. Each toggle
 * is one independent fact, and a form that can be abandoned leaves the screen
 * disagreeing with the file.
 */
import {useEffect, useState} from 'react';

import type {AgentProfile, CatalogTool, ProfileCatalog, PublicSettings} from '@marimo/protocol';

interface Loaded {
  settings: PublicSettings;
  catalog: ProfileCatalog;
  profile: AgentProfile | undefined;
}

export function Settings({onClose}: {onClose: () => void}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  /** The name and identity being edited. Committed on blur, not on every letter. */
  const [draft, setDraft] = useState<{name: string; identity: string} | null>(
    null,
  );

  const load = async (): Promise<void> => {
    try {
      const {settings} = await window.marimo.call('settings.get', {});
      const {profiles} = await window.marimo.call('profiles.list', {});
      const profile = profiles.find(
        (entry) => entry.id === settings.activeProfileId,
      );
      const catalog = await window.marimo.call('profiles.catalog', {});
      setLoaded({settings, catalog, profile});
      setDraft(
        profile === undefined
          ? null
          : {name: profile.name, identity: profile.identity},
      );
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Runs a change, and says so when it fails rather than pretending. */
  const change = async (work: () => Promise<unknown>): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await work();
      await load();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (tool: CatalogTool, on: boolean): void => {
    const profile = loaded?.profile;
    if (profile === undefined) {
      return;
    }
    const enabled = new Set(profile.enabledTools);
    if (on) {
      enabled.add(tool.name);
    } else {
      enabled.delete(tool.name);
    }
    void change(async () => {
      await window.marimo.call('profiles.update', {
        profileId: profile.id,
        patch: {enabledTools: [...enabled]},
      });
    });
  };

  if (loaded === null) {
    return (
      <div className="settings">
        <div className="settings-inner">
          <p className="settings-muted">
            {problem ?? 'Reading your settings…'}
          </p>
          <button type="button" className="button button-quiet" onClick={onClose}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const granted = new Set(loaded.profile?.enabledTools ?? []);
  /*
   * Grouped by the grant itself, which is the one fact about a tool that cannot
   * be out of date — it is the same value the switch is drawn from. An earlier
   * version grouped by a hand-written "looking" or "acting" classification, and
   * that list had already drifted from the tools it described.
   */
  const onByDefault = loaded.catalog.tools.filter((tool) => tool.byDefault);
  const offByDefault = loaded.catalog.tools.filter((tool) => !tool.byDefault);

  return (
    <div className="settings">
      <div className="settings-inner">
        <header className="settings-head">
          <h2>Settings</h2>
          <button type="button" className="button button-quiet" onClick={onClose}>
            Back to chat
          </button>
        </header>

        {problem !== null && (
          <div className="error" role="alert">
            <span>{problem}</span>
          </div>
        )}

        <section className="settings-section">
          <h3>Your agents</h3>
          <p className="settings-muted">
            Each agent has its own instructions, its own abilities and its own
            conversations. Making a second one is how you keep two jobs from
            sharing one memory.
          </p>
          <div className="settings-agents">
            {loaded.settings.profiles.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="settings-agent"
                aria-current={
                  entry.id === loaded.settings.activeProfileId ? 'true' : undefined
                }
                disabled={saving}
                onClick={() => {
                  void change(async () => {
                    await window.marimo.call('profiles.select', {
                      profileId: entry.id,
                    });
                  });
                }}
              >
                {entry.name}
              </button>
            ))}
            <button
              type="button"
              className="settings-agent settings-agent-new"
              disabled={saving}
              onClick={() => {
                void change(async () => {
                  await window.marimo.call('profiles.create', {});
                });
              }}
            >
              + New agent
            </button>
          </div>
        </section>

        {draft !== null && loaded.profile !== undefined && (
          <section className="settings-section">
            <h3>What it is</h3>
            <label className="settings-field">
              <span>Name</span>
              <input
                className="settings-input"
                value={draft.name}
                disabled={saving}
                onChange={(event) => {
                  setDraft({...draft, name: event.target.value});
                }}
                onBlur={() => {
                  const name = draft.name.trim();
                  if (name.length === 0 || name === loaded.profile?.name) {
                    // Put back rather than saved: an agent with no name is one
                    // nobody can pick out of the list, and the field is the only
                    // place that says so.
                    setDraft({...draft, name: loaded.profile?.name ?? ''});
                    return;
                  }
                  void change(async () => {
                    await window.marimo.call('profiles.update', {
                      profileId: loaded.profile?.id ?? '',
                      patch: {name},
                    });
                  });
                }}
              />
            </label>
            <label className="settings-field">
              <span>Instructions</span>
              <em className="settings-why">
                Who this agent is and how it should behave. Written as an
                instruction to it, and sent at the start of every conversation.
              </em>
              <textarea
                className="settings-input settings-identity"
                rows={6}
                value={draft.identity}
                disabled={saving}
                onChange={(event) => {
                  setDraft({...draft, identity: event.target.value});
                }}
                onBlur={() => {
                  if (draft.identity === loaded.profile?.identity) {
                    return;
                  }
                  const identity = draft.identity;
                  void change(async () => {
                    await window.marimo.call('profiles.update', {
                      profileId: loaded.profile?.id ?? '',
                      patch: {identity},
                    });
                  });
                }}
              />
            </label>
          </section>
        )}

        <section className="settings-section">
          <h3>What {loaded.profile?.name ?? 'this agent'} can do</h3>
          <p className="settings-muted">
            A tool that is switched off is not offered to the model at all — it is
            not a suggestion it might ignore.
          </p>

          <h4 className="settings-group">On to begin with</h4>
          {onByDefault.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              on={granted.has(tool.name)}
              disabled={saving}
              onChange={toggle}
            />
          ))}

          <h4 className="settings-group">Off until you turn it on</h4>
          {offByDefault.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              on={granted.has(tool.name)}
              disabled={saving}
              onChange={toggle}
            />
          ))}
        </section>

        <section className="settings-section">
          <h3>API key</h3>
          <p className="settings-muted">
            {loaded.settings.hasApiKey
              ? 'A key is stored for this provider.'
              : 'No key yet — the agent cannot answer until there is one.'}
          </p>
          <div className="settings-row">
            <input
              className="settings-input"
              type="password"
              value={apiKey}
              placeholder="Paste a key"
              aria-label="API key"
              onChange={(event) => {
                setApiKey(event.target.value);
              }}
            />
            <button
              type="button"
              className="button button-primary"
              disabled={saving || apiKey.trim().length === 0}
              onClick={() => {
                const value = apiKey;
                void change(async () => {
                  await window.marimo.call('settings.setApiKey', {apiKey: value});
                  setApiKey('');
                });
              }}
            >
              Save key
            </button>
          </div>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={loaded.settings.allowPlaintextApiKey}
              disabled={saving}
              onChange={(event) => {
                const on = event.target.checked;
                void change(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {allowPlaintextApiKey: on},
                  });
                });
              }}
            />
            <span>
              Store secrets as plain text
              <em className="settings-why">
                {loaded.settings.encryptionAvailable
                  ? 'Your key will be readable by anything that can read the file. ' +
                    'Needed only if you want scheduled jobs to run while the app is ' +
                    'closed — the background runner has no keychain to unlock it. ' +
                    'Re-save the key after changing this.'
                  : 'This machine has no keychain, so a key cannot be encrypted ' +
                    'either way. Turning this on is what lets scheduled jobs run ' +
                    'while the app is closed.'}
              </em>
            </span>
          </label>
        </section>

        <section className="settings-section">
          <h3>Where it works</h3>
          <p className="settings-muted">
            <code>{loaded.settings.defaultWorkspace}</code>
          </p>
        </section>
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  on,
  disabled,
  onChange,
}: {
  tool: CatalogTool;
  on: boolean;
  disabled: boolean;
  onChange: (tool: CatalogTool, on: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(event) => {
          onChange(tool, event.target.checked);
        }}
      />
      <span>
        <code className="settings-tool">{tool.name}</code>
        <em className="settings-why">{tool.blurb}</em>
      </span>
    </label>
  );
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}
