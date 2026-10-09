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
  SettingsPatch,
} from '@marimo/protocol';

import {
  COMPANION_ANSWER_LENGTHS,
  PROVIDER_IDS,
  PROVIDERS,
} from '@marimo/protocol';

import {Connectors} from './Connectors.js';
import {Memory} from './Memory.js';
import {ModelPicker} from './ModelPicker.js';

/**
 * Above this many models the field becomes a searchable picker.
 *
 * The native `<select>` is the better control for the handful a provider like
 * DeepSeek serves, so it stays. OpenRouter answers its `/models` with several
 * hundred, and a list that long is one you scroll rather than choose from — the
 * threshold is data, not a provider id, so any endpoint that turns out to be
 * this generous gets the same treatment.
 */
const SEARCHABLE_MODEL_THRESHOLD = 12;

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

        <ProviderSection
          onChange={() => {
            void load();
          }}
        />

        <Memory />

        <Connectors
          servers={loaded.settings.mcpServers}
          statuses={loaded.statuses}
          onChange={() => {
            void load();
          }}
        />

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
 * Which provider answers, how it is reached, and which of its models.
 *
 * One section because none of these stands alone: a model id is only meaningful
 * at one endpoint, the address is what makes a llama.cpp server on the network
 * reachable rather than only the one beside this app, and both are unusable
 * without the key that endpoint wants. They were two sections for a while — a
 * Provider card and a detached API key card — and the split was arbitrary: the
 * key belongs to the picker above it, and the model list could not be refreshed
 * without leaving the section it lives in.
 *
 * Two choices here are deliberate. The provider is a pick-list, because the ids
 * are the app's own and a mistyped one would leave the settings file naming a
 * provider nothing can resolve. The model is a pick-list for the same reason —
 * a mistyped model id is a 404 at the start of a turn, which reads as "the agent
 * is broken" rather than "that model does not exist" — and the stored value is
 * shown even when the list no longer carries it, because a model the provider
 * has stopped advertising may still work.
 *
 * "Fetch Models" is what replaces those placeholder names with what the endpoint
 * actually serves, and it is offered only once a key is on file: asking a
 * service that will answer 401 is a button whose only outcome is an error. A
 * provider that needs no key — a llama.cpp server beside the app — is asked
 * directly.
 *
 * Saving is immediate, like every other control here. The base URL is the one
 * exception in *when*: it waits for the box to lose focus, because saving per
 * keystroke would write a half-typed address to disk and offer it to the next
 * turn.
 */
function ProviderSection({
  onChange,
}: {
  onChange?: () => void;
}): React.JSX.Element | null {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [apiKey, setApiKey] = useState('');
  /** What is in the base URL box, or null while it shows what is stored. */
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);
  /** What went wrong, shown in this section rather than only in the banner. */
  const [problem, setProblem] = useState<string | null>(null);
  /** What a good fetch found, so the button's effect is visible. */
  const [note, setNote] = useState<string | null>(null);

  const load = (): void => {
    void window.marimo
      .call('settings.get', {})
      .then(({settings: loaded}) => {
        setSettings(loaded);
        setBaseUrlDraft(null);
      })
      .catch(() => undefined);
  };

  useEffect(load, []);

  if (settings === null) {
    return null;
  }

  const active = settings.providers.active;
  const descriptor = PROVIDERS[active];
  const config = settings.providers.configs[active];
  const models = settings.availableModels.includes(config.model)
    ? settings.availableModels
    : [config.model, ...settings.availableModels];
  const baseUrl = baseUrlDraft ?? config.baseUrl;
  const keyStored = settings.providerKeys[active];

  const save = (patch: SettingsPatch): void => {
    setSaving(true);
    setProblem(null);
    setNote(null);
    void window.marimo
      .call('settings.set', {patch})
      .then(() => {
        load();
        /*
         * The rest of the dialog is redrawn too. A provider change is a fact the
         * other cards can act on, and a copy of the settings that still names the
         * old one is how a change looks like it did not take.
         */
        onChange?.();
      })
      .catch((failure) => {
        setProblem(describe(failure));
        // Put the box back rather than leaving a refused address in it.
        setBaseUrlDraft(null);
      })
      .finally(() => {
        setSaving(false);
      });
  };

  /** Writes the key for this section's provider and reloads what is stored. */
  const saveKey = (): void => {
    const value = apiKey;
    setSaving(true);
    setProblem(null);
    setNote(null);
    void window.marimo
      .call('settings.setApiKey', {apiKey: value})
      .then(() => {
        setApiKey('');
        load();
        onChange?.();
      })
      .catch((failure) => {
        setProblem(describe(failure));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  /**
   * Asks the endpoint what it serves and redraws the list from the answer.
   *
   * A base URL still sitting in the box has not been written yet — that field
   * saves on blur — while the fetch reads the stored address. Committing the
   * draft first is what stops this from asking the address the user just
   * replaced, which would look like the button ignored the edit.
   */
  const fetchModels = (): void => {
    setFetching(true);
    setProblem(null);
    setNote(null);
    void (async () => {
      try {
        const draft = baseUrlDraft?.trim() ?? '';
        if (draft.length > 0 && draft !== config.baseUrl) {
          await window.marimo.call('settings.set', {
            patch: {providers: {configs: {[active]: {baseUrl: draft}}}},
          });
          setBaseUrlDraft(null);
        }

        const {settings: refreshed} = await window.marimo.call(
          'models.fetch',
          {},
        );
        setSettings(refreshed);
        setNote(
          `${PROVIDERS[refreshed.providers.active].label} returned ` +
            `${String(refreshed.availableModels.length)} model(s).`,
        );
        onChange?.();
      } catch (failure) {
        setProblem(describe(failure));
      } finally {
        setFetching(false);
      }
    })();
  };

  const canFetch =
    !fetching && !saving && (!descriptor.requiresApiKey || keyStored);

  const chooseModel = (model: string): void => {
    save({providers: {configs: {[active]: {model}}}});
  };

  return (
    <section className="settings-section">
      <h3>Provider</h3>
      <p className="settings-muted">
        Which service answers, how the app reaches it, and which of its models.
        Every provider keeps its own address, model and key, so trying one and
        coming back does not cost you the setup of the other.
      </p>

      <label className="settings-field">
        <span>Provider</span>
        <em className="settings-why">{descriptor.blurb}</em>
        <select
          className="settings-input"
          value={active}
          disabled={saving}
          onChange={(event) => {
            const next = PROVIDER_IDS.find((id) => id === event.target.value);
            if (next === undefined) {
              return;
            }
            save({providers: {active: next}});
          }}
        >
          {PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {PROVIDERS[id].label}
            </option>
          ))}
        </select>
      </label>

      <div className="settings-field">
        <span>API key</span>
        <p className="settings-muted">
          {keyStored
            ? `A key for ${descriptor.label} is stored. It is kept on this machine and never sent back to this window.`
            : descriptor.requiresApiKey
              ? `No ${descriptor.label} key yet — the agent cannot answer, and its models cannot be fetched, until there is one.`
              : `${descriptor.label} needs no key. Anything pasted here is sent as one.`}
        </p>
        <div className="settings-row">
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            placeholder={descriptor.keyPlaceholder}
            aria-label={`${descriptor.label} API key`}
            disabled={saving}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
          />
          <button
            type="button"
            className="button button-primary"
            disabled={saving || apiKey.trim().length === 0}
            onClick={saveKey}
          >
            Save key
          </button>
        </div>
        <p className="settings-muted">{descriptor.keyHelp}</p>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.allowPlaintextApiKey}
            disabled={saving}
            onChange={(event) => {
              save({allowPlaintextApiKey: event.target.checked});
            }}
          />
          <span>
            Store secrets as plain text
            <em className="settings-why">
              {settings.encryptionAvailable
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
      </div>

      <label className="settings-field">
        <span>Base URL</span>
        <em className="settings-why">
          Where requests for {descriptor.label} go. The usual address is{' '}
          <code>{descriptor.defaultBaseUrl}</code>; change it to point at a
          server of your own.
        </em>
        <input
          className="settings-input"
          type="text"
          value={baseUrl}
          disabled={saving}
          spellCheck={false}
          onChange={(event) => {
            setBaseUrlDraft(event.target.value);
          }}
          onBlur={() => {
            const next = baseUrl.trim();
            // An empty box is not an address: fall back to what is stored rather
            // than writing a value the schema refuses and the user cannot see.
            if (next.length === 0 || next === config.baseUrl) {
              setBaseUrlDraft(null);
              return;
            }
            save({providers: {configs: {[active]: {baseUrl: next}}}});
          }}
        />
      </label>

      <div className="settings-field">
        <span>Model</span>
        <em className="settings-why">
          Cheaper models are fine for reading and summarising; harder questions
          want a bigger one.
        </em>
        <div className="settings-row">
          {models.length > SEARCHABLE_MODEL_THRESHOLD ? (
            <ModelPicker
              models={models}
              value={config.model}
              disabled={saving || fetching}
              onChange={chooseModel}
            />
          ) : (
            <select
              className="settings-input"
              aria-label="Model"
              value={config.model}
              disabled={saving || fetching}
              onChange={(event) => {
                chooseModel(event.target.value);
              }}
            >
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="button button-quiet"
            disabled={!canFetch}
            title={
              descriptor.requiresApiKey && !keyStored
                ? `Save a ${descriptor.label} key first`
                : undefined
            }
            onClick={fetchModels}
          >
            {fetching ? 'Fetching…' : 'Fetch Models'}
          </button>
        </div>
        {note !== null && <p className="settings-muted">{note}</p>}
        {problem !== null && <p className="settings-problem">{problem}</p>}
      </div>
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
