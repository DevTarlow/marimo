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

import type {
  AgentProfile,
  CatalogTool,
  CompanionAnswerLength,
  McpStatus,
  ProfileCatalog,
  PublicSettings,
} from '@marimo/protocol';

import {COMPANION_ANSWER_LENGTHS, PROVIDERS} from '@marimo/protocol';

import {Connectors} from './Connectors.js';
import {Memory} from './Memory.js';

/**
 * The three lengths, in the words the user is choosing between.
 *
 * Written here rather than derived from the enum: the value is what the agent's
 * instruction is keyed by, and this is what the person picking one is told. The
 * sentences the model actually gets live beside the agent, in `pet-turn.ts` —
 * they are prompt text, and a pick-list labelled with prompt text would be
 * describing the implementation rather than the choice.
 */
const ANSWER_LENGTH_LABELS: Record<CompanionAnswerLength, string> = {
  brief: 'Brief — a few lines, the answer and nothing else',
  balanced: 'Balanced — as long as the question deserves',
  detailed: 'Detailed — the full answer here, not deferred to the window',
};

interface Loaded {
  settings: PublicSettings;
  catalog: ProfileCatalog;
  profile: AgentProfile | undefined;
  statuses: Record<string, McpStatus>;
  /** Whether the floating companion is on screen. */
  companionVisible: boolean;
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
      const statuses = await window.marimo.call('mcp.statuses', {});
      const companion = await window.marimo.call('companion.status', {});
      setLoaded({
        settings,
        catalog,
        profile,
        statuses,
        companionVisible: companion.visible,
      });
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
            Each agent has its own identity, its own abilities and its own
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
              <span>Identity</span>
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
          <h3>Desktop companion</h3>
          <p className="settings-muted">
            A moss ball that floats above your other windows with its own chat
            bar, so you can ask something without opening this one. It shares
            this conversation — anything you say to it is here too.
          </p>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={loaded.companionVisible}
              disabled={saving}
              onChange={(event) => {
                const visible = event.target.checked;
                void change(async () => {
                  await window.marimo.call('companion.setVisible', {visible});
                });
              }}
            />
            <span>
              Show the companion
              <em className="settings-why">
                Drag it by the moss to move it. Clicking through to whatever is
                behind works anywhere there is nothing to click.
              </em>
            </span>
          </label>

          <h4 className="settings-group">How it answers</h4>
          <p className="settings-muted">
            How long the answers are when you ask at the moss. This travels with
            the question rather than with the conversation, so asking here does
            not make the main window terse as well.
          </p>
          <select
            className="settings-input"
            value={loaded.settings.companion.answerLength}
            disabled={saving}
            aria-label="Answer length"
            onChange={(event) => {
              const answerLength = event.target.value as CompanionAnswerLength;
              void change(async () => {
                await window.marimo.call('settings.set', {
                  patch: {companion: {answerLength}},
                });
              });
            }}
          >
            {COMPANION_ANSWER_LENGTHS.map((length) => (
              <option key={length} value={length}>
                {ANSWER_LENGTH_LABELS[length]}
              </option>
            ))}
          </select>

          <h4 className="settings-group">How much it shows</h4>
          <label className="settings-field">
            <span>
              Messages above the moss
              <em className="settings-why">
                Older ones are always in the main window. Fewer keeps the pet to
                the answer that just arrived.
              </em>
            </span>
            <input
              className="settings-input"
              type="number"
              min={1}
              max={20}
              value={loaded.settings.companion.visibleMessages}
              disabled={saving}
              onChange={(event) => {
                const visibleMessages = Number(event.target.value);
                /*
                 * A field being cleared, or a keypress that would leave a 0 or a
                 * 40 in it, passes through values the schema refuses. Writing one
                 * would be a failed call and an error line under a spinner, so
                 * the field is allowed to disagree with the stored number for as
                 * long as it takes to type a good one — and the stored number is
                 * what is still in force.
                 */
                if (
                  !Number.isInteger(visibleMessages) ||
                  visibleMessages < 1 ||
                  visibleMessages > 20
                ) {
                  return;
                }
                void change(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {companion: {visibleMessages}},
                  });
                });
              }}
            />
          </label>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={loaded.settings.companion.alwaysOnTop}
              disabled={saving}
              onChange={(event) => {
                const alwaysOnTop = event.target.checked;
                void change(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {companion: {alwaysOnTop}},
                  });
                });
              }}
            />
            <span>
              Float above other windows
              <em className="settings-why">
                Turn this off while presenting or watching something full-screen,
                and the moss stops covering it. It can then go behind the window
                you are working in, so it may need moving back out.
              </em>
            </span>
          </label>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={loaded.settings.companion.clickThrough}
              disabled={saving}
              onChange={(event) => {
                const clickThrough = event.target.checked;
                void change(async () => {
                  await window.marimo.call('settings.set', {
                    patch: {companion: {clickThrough}},
                  });
                });
              }}
            />
            <span>
              Clicks pass through where there is nothing to click
              <em className="settings-why">
                On is what makes the moss sit on the desktop rather than in a box
                over it. Turn it off if the moss ever stops responding to the
                mouse — the window then keeps the mouse everywhere inside it,
                including the empty space around the moss.
              </em>
            </span>
          </label>
        </section>

        <Model />

        <Memory />

        <Connectors
          servers={loaded.settings.mcpServers}
          statuses={loaded.statuses}
          onChange={() => {
            void load();
          }}
        />

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

/**
 * Which model the active provider should answer with.
 *
 * A pick-list rather than a text box: the ids are the provider's own, and a
 * mistyped one is a 404 from the provider at the start of a turn — which reads
 * as "the agent is broken" rather than "that model does not exist". The stored
 * value is shown even when it is not in the list, because a model the provider
 * has stopped advertising may still work, and silently switching somebody off it
 * would be worse than an odd-looking list.
 */
function Model(): React.JSX.Element | null {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (): void => {
    void window.marimo
      .call('settings.get', {})
      .then(({settings: loaded}) => {
        setSettings(loaded);
      })
      .catch(() => undefined);
  };

  useEffect(load, []);

  if (settings === null) {
    return null;
  }

  const active = settings.providers.active;
  const current = settings.providers.configs[active].model;
  const options = settings.availableModels.includes(current)
    ? settings.availableModels
    : [current, ...settings.availableModels];

  return (
    <section className="settings-section">
      <h3>Model</h3>
      <p className="settings-muted">
        Which model {PROVIDERS[active].label} answers with. Cheaper models are
        fine for reading and summarising; harder questions want a bigger one.
      </p>
      <select
        className="settings-input"
        value={current}
        disabled={saving}
        aria-label="Model"
        onChange={(event) => {
          const model = event.target.value;
          setSaving(true);
          void window.marimo
            .call('settings.set', {
              patch: {providers: {configs: {[active]: {model}}}},
            })
            .then(load)
            .catch(() => undefined)
            .finally(() => {
              setSaving(false);
            });
        }}
      >
        {options.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </section>
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
