/**
 * Settings.
 *
 * The screen that makes "every capability is something the user turns on" true
 * rather than a description of a state nobody can leave. Until this existed the
 * grants were a hardcoded default with no way to change them.
 *
 * It is drawn in two sizes, and which one is the user's answer rather than the
 * app's guess. **Simple** is what somebody who wants a companion sees: a name,
 * one choice about what it may do, and the model. **Power** is everything, down
 * to the temperature and the individual tool switches. The line between
 * them is *tuning versus repair* — a number to adjust lives in power, a switch
 * that fixes something the user is looking at stays where they are. Hiding the
 * escape hatch from the person hitting the problem is how a setting comes to look
 * like a bug.
 *
 * The tool list is drawn in two groups, and the grouping is the point. Twenty
 * checkboxes with no distinction between reading a file and running a shell
 * command is a list nobody can make a decision from — so the ones that merely
 * look are separated from the ones that can change something, and the second
 * group says what is at stake. That list is the power screen's; the simple screen
 * offers the same grants as three cards, which write the same profile field.
 *
 * Saving is immediate per switch rather than behind a Save button. Each toggle
 * is one independent fact, and a form that can be abandoned leaves the screen
 * disagreeing with the file.
 */
import {useEffect, useState} from 'react';

import type {
  AgentProfile,
  CapabilityPreset,
  CatalogTool,
  CompanionAnswerLength,
  ExperienceMode,
  McpStatus,
  ProfileCatalog,
  PublicSettings,
} from '@marimo/protocol';

import {
  COMMAND_IDS,
  COMMANDS,
  COMPANION_ANSWER_LENGTHS,
  DEFAULT_AGENT_IDENTITY,
} from '@marimo/protocol';

import {chosenPreset} from '../capabilities.js';
import {describe} from '../describe.js';
import {Connectors} from './Connectors.js';
import {Memory} from './Memory.js';
import {Model} from './Model.js';
import {SettingsSection} from './SettingsSection.js';

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

/**
 * The two sizes, in the words the person choosing between them is given.
 *
 * Written here rather than derived from the enum, for the reason the answer
 * lengths above are: the value is what the file is keyed by, and this is what
 * somebody flipping the switch is told they are getting.
 */
const EXPERIENCE_LABELS: Record<ExperienceMode, string> = {
  simple: 'Simple',
  power: 'Power user',
};

interface Loaded {
  settings: PublicSettings;
  catalog: ProfileCatalog;
  profile: AgentProfile | undefined;
  statuses: Record<string, McpStatus>;
  /** Whether the floating companion is on screen. */
  companionVisible: boolean;
}

export function Settings({
  onClose,
  onExperienceModeChange,
}: {
  onClose: () => void;
  /**
   * Told which size the dialog is now drawn at.
   *
   * The density of the whole window follows this value, and the window is not
   * this component — so without saying so, flipping the switch would re-space
   * everything only when the dialog was closed. A setting whose entire effect is
   * visible on the screen you are looking at cannot wait for that.
   */
  onExperienceModeChange?: (mode: ExperienceMode) => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The fields being edited. Committed on blur, not on every letter.
   *
   * `preferences` is a string here and optional on the profile, because a text
   * box has no way to show "absent" and `''` is what an empty one means.
   */
  const [draft, setDraft] = useState<{
    name: string;
    identity: string;
    preferences: string;
  } | null>(null);
  /**
   * The sections the user has opened, by title.
   *
   * Here rather than inside each panel because the file stores the list whole:
   * one write carries every open section, and a panel writing only its own name
   * would fold all the others. `null` until the file has been read, so an empty
   * list — every section folded — is never confused with not having looked yet.
   */
  const [openSections, setOpenSections] = useState<string[] | null>(null);

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
          : {
              name: profile.name,
              identity: profile.identity,
              preferences: profile.preferences ?? '',
            },
      );
      /*
       * Seeded once. Every later read is the reload that follows a write, and
       * that write came from the list already on screen — taking the file's copy
       * instead would be taking the same list back, or throwing away the fold
       * somebody just made if the write was slower than the read.
       */
      setOpenSections((current) => current ?? settings.expandedSections);
    } catch (failure) {
      setProblem(describe(failure));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Runs a change, and says so when it fails rather than pretending. */
  const change = async (
    work: () => Promise<unknown>,
    /**
     * Runs after the write landed and before the redraw.
     *
     * For the one change whose effect is *outside* this dialog — the size switch,
     * which re-spaces the window behind it. Deliberately not called on a refusal:
     * a failed write that had already resized everything would be the screen
     * agreeing with a file that says otherwise.
     */
    after?: () => void,
  ): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      await work();
      after?.();
      await load();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Opens or folds one section, and stores the fact.
   *
   * The only control on this screen drawn before it is written. Every other
   * switch here is a fact about how the agent behaves; this is a fact about
   * where somebody is looking, and a panel that spent a round trip deciding
   * whether to close would feel like it had missed the click. A refused write
   * puts the list back where it was, so the dialog never disagrees with the
   * file about what is open.
   *
   * Deliberately not the `saving` flag the other writes set: that flag disables
   * every switch on the screen, and a fold changes none of them. Raising it here
   * greyed out the whole dialog — including the section being opened — for the
   * duration of a write about where a panel sits.
   */
  const fold = (title: string, expanded: boolean): void => {
    const before = openSections ?? [];
    const after = expanded
      ? [...new Set([...before, title])]
      : before.filter((name) => name !== title);
    setOpenSections(after);
    setProblem(null);
    void window.marimo
      .call('settings.set', {patch: {expandedSections: after}})
      .then(() => load())
      .catch((failure) => {
        setOpenSections(before);
        setProblem(describe(failure));
      });
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
    writeTools(profile.id, [...enabled]);
  };

  /** Writes a grant, whoever asked for it — a switch or one of the cards. */
  const writeTools = (profileId: string, enabledTools: string[]): void => {
    void change(async () => {
      await window.marimo.call('profiles.update', {
        profileId,
        patch: {enabledTools},
      });
    });
  };

  const setExperienceMode = (mode: ExperienceMode): void => {
    if (mode === loaded?.settings.experienceMode) {
      return;
    }
    void change(
      async () => {
        await window.marimo.call('settings.set', {
          patch: {experienceMode: mode},
        });
      },
      () => {
        onExperienceModeChange?.(mode);
      },
    );
  };

  if (loaded === null) {
    return (
      <div className="settings">
        <div className="settings-inner">
          <p className="settings-muted">
            {problem ?? 'Reading your settings…'}
          </p>
          <button
            type="button"
            className="button button-quiet"
            onClick={onClose}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  const granted = new Set(loaded.profile?.enabledTools ?? []);
  const opened = new Set(openSections ?? []);
  /*
   * Which size this screen is drawn at, read from the file rather than held
   * here: it is the user's answer about the app, and the window behind this
   * dialog is drawing itself from the same value.
   */
  const power = loaded.settings.experienceMode === 'power';
  /*
   * Reset would be a no-op only when the box already shows the default *and*
   * that is what is stored. A box showing the default it has not saved yet is a
   * change waiting to happen, and the button is how it gets saved.
   */
  const identityAtDefault =
    draft?.identity === DEFAULT_AGENT_IDENTITY &&
    loaded.profile?.identity === DEFAULT_AGENT_IDENTITY;
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
          <button
            type="button"
            className="button button-quiet"
            onClick={onClose}
          >
            Back to chat
          </button>
        </header>

        {problem !== null && (
          <div className="error" role="alert">
            <span>{problem}</span>
          </div>
        )}

        {/*
          The switch that decides which of the cards below exist. First, and
          outside the folding list, because a control hidden inside a panel it
          also governs is one nobody finds.
        */}
        <div className="settings-mode">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={power}
              disabled={saving}
              onChange={(event) => {
                setExperienceMode(event.target.checked ? 'power' : 'simple');
              }}
            />
            <span>
              {EXPERIENCE_LABELS.power} mode
              <em className="settings-why">
                {power
                  ? 'Everything is on this page: which service answers, where it is reached, which of its models, and every single thing the agent is allowed to do. Turn it off for the everyday settings.'
                  : 'The everyday settings, with the tuning left out. Turn this on to choose a service and a model of your own, to connect tools from elsewhere, and to see every ability as its own switch.'}
              </em>
            </span>
          </label>
        </div>

        <SettingsSection title="Your agents" opened={opened} onToggle={fold}>
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
                  entry.id === loaded.settings.activeProfileId
                    ? 'true'
                    : undefined
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
        </SettingsSection>

        {draft !== null && loaded.profile !== undefined && (
          <SettingsSection title="What it is" opened={opened} onToggle={fold}>
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
            {/*
             * The identity is tuning, so it lives in the power screen. It is a
             * paragraph of instruction addressed to a model, and the app's own
             * text is a good answer for somebody who has not thought about
             * prompts at all.
             *
             * "How to talk to me" below is the opposite, and stays in both: it
             * is the user's own voice, and correcting a name or asking not to be
             * flattered should not require turning on an advanced mode.
             */}
            {power && (
              /*
               * Not a `<label>` any more, because it now holds a button: a click
               * anywhere inside a label focuses its control, so the reset below
               * would have been a click on the text box. The name is carried by
               * `aria-label` instead, which is how the other fields that are not
               * wrapped in a label do it.
               */
              <div className="settings-field">
                <span>Identity</span>
                <em className="settings-why">
                  Who this agent is and how it should behave. Written as an
                  instruction to it, and sent at the start of every
                  conversation.
                </em>
                <textarea
                  className="settings-input settings-identity"
                  rows={6}
                  aria-label="Identity"
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
                <div className="settings-row">
                  {/*
                   * Saved in the click rather than left to a blur: the blur fires
                   * first when the button takes focus, and would write whatever
                   * the box held *before* the reset. The store serialises the
                   * two, so the default is what lands.
                   */}
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={saving || identityAtDefault}
                    onClick={() => {
                      setDraft({...draft, identity: DEFAULT_AGENT_IDENTITY});
                      void change(async () => {
                        await window.marimo.call('profiles.update', {
                          profileId: loaded.profile?.id ?? '',
                          patch: {identity: DEFAULT_AGENT_IDENTITY},
                        });
                      });
                    }}
                  >
                    Reset to default
                  </button>
                </div>
              </div>
            )}
            {/*
             * The user's own words, in their own field. Kept out of the identity
             * above deliberately: Reset restores the app's text, and it must not
             * be able to restore over something the app never wrote.
             */}
            <div className="settings-field">
              <span>How to talk to me</span>
              <em className="settings-why">
                Your own standing instructions. Sent after the identity, so it
                wins wherever the two disagree about how you want to be spoken
                to.
              </em>
              <textarea
                className="settings-input settings-preferences"
                rows={3}
                aria-label="How to talk to me"
                placeholder="Call me Tarlow. Tell me when you are unsure rather than guessing."
                value={draft.preferences}
                disabled={saving}
                onChange={(event) => {
                  setDraft({...draft, preferences: event.target.value});
                }}
                onBlur={() => {
                  const stored = loaded.profile?.preferences ?? '';
                  if (draft.preferences === stored) {
                    return;
                  }
                  const preferences = draft.preferences;
                  void change(async () => {
                    await window.marimo.call('profiles.update', {
                      profileId: loaded.profile?.id ?? '',
                      patch: {preferences},
                    });
                  });
                }}
              />
              {draft.preferences.trim().length > 0 && (
                <div className="settings-row">
                  {/*
                   * Clear, not "Reset to default": the default here is nothing,
                   * and a button that offered to restore the app's wording into a
                   * box the app did not write would be offering to invent it.
                   */}
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={saving}
                    onClick={() => {
                      setDraft({...draft, preferences: ''});
                      void change(async () => {
                        await window.marimo.call('profiles.update', {
                          profileId: loaded.profile?.id ?? '',
                          patch: {preferences: ''},
                        });
                      });
                    }}
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </SettingsSection>
        )}

        {/*
          What the agent may do, drawn as three cards or as thirty switches.
          
          Both write the same profile field, and the card that is lit is worked
          out from it rather than stored beside it — so ticking a box in the power
          screen and coming back to the simple one cannot show a choice the profile
          does not hold.
        */}
        {power ? (
          <SettingsSection
            title={`What ${loaded.profile?.name ?? 'this agent'} can do`}
            opened={opened}
            onToggle={fold}
          >
            <p className="settings-muted">
              A tool that is switched off is not offered to the model at all —
              it is not a suggestion it might ignore.
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
          </SettingsSection>
        ) : (
          <SettingsSection
            title={`What ${loaded.profile?.name ?? 'this agent'} can do`}
            opened={opened}
            onToggle={fold}
          >
            <CapabilityChoices
              presets={loaded.catalog.presets}
              granted={granted}
              disabled={saving}
              onChoose={(tools) => {
                const profile = loaded.profile;
                if (profile !== undefined) {
                  writeTools(profile.id, tools);
                }
              }}
            />
          </SettingsSection>
        )}

        <SettingsSection
          title="Desktop companion"
          opened={opened}
          onToggle={fold}
        >
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

          {/*
            A number to tune, so it is power-only. The two switches below are
            not: they are what somebody reaches for when the moss covers a
            film or stops answering the mouse, and a repair hidden behind an
            advanced mode is a repair nobody finds.
          */}
          {power && (
            <>
              <h4 className="settings-group">How much it shows</h4>
              <label className="settings-field">
                <span>
                  Messages above the moss
                  <em className="settings-why">
                    Older ones are always in the main window. Fewer keeps the
                    pet to the answer that just arrived.
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
            </>
          )}

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
                Turn this off while presenting or watching something
                full-screen, and the moss stops covering it. It can then go
                behind the window you are working in, so it may need moving back
                out.
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
                On is what makes the moss sit on the desktop rather than in a
                box over it. Turn it off if the moss ever stops responding to
                the mouse — the window then keeps the mouse everywhere inside
                it, including the empty space around the moss.
              </em>
            </span>
          </label>
        </SettingsSection>

        {/*
          Commands act on the conversation itself rather than being said in it,
          which is why they are not a tool: a tool is something the model decides
          to use, and this is something the user decides to run. The list is the
          protocol's catalogue, so a command added there appears here, in the
          composer's menu, and nowhere else needs to know about it.
        */}
        {power && (
          <SettingsSection title="Commands" opened={opened} onToggle={fold}>
            <p className="settings-muted">
              Commands run against a conversation from the composer&rsquo;s +
              menu. They are off the model&rsquo;s list entirely when switched
              off here, rather than merely discouraged.
            </p>
            {COMMAND_IDS.map((id) => (
              <label className="settings-check" key={id}>
                <input
                  type="checkbox"
                  checked={!loaded.settings.disabledCommands.includes(id)}
                  disabled={saving}
                  onChange={(event) => {
                    const on = event.target.checked;
                    const next = COMMAND_IDS.filter((candidate) =>
                      candidate === id
                        ? !on
                        : loaded.settings.disabledCommands.includes(candidate),
                    );
                    void change(async () => {
                      await window.marimo.call('settings.set', {
                        patch: {disabledCommands: next},
                      });
                    });
                  }}
                />
                <span>
                  {COMMANDS[id].label}
                  <em className="settings-why">{COMMANDS[id].blurb}</em>
                </span>
              </label>
            ))}
          </SettingsSection>
        )}

        {/*
          What answers, in both sizes.

          Simple gets the whole story — the model runs here, nothing to sign up
          for, and whether it is up. Power gets the temperature, the command line
          and the engine's own log, because every one of those is a number to
          tune or a failure to diagnose.
        */}
        <Model
          opened={opened}
          onToggle={fold}
          power={power}
          onChange={() => {
            void load();
          }}
        />

        <Memory opened={opened} onToggle={fold} />

        {power && (
          <Connectors
            servers={loaded.settings.mcpServers}
            statuses={loaded.statuses}
            opened={opened}
            onToggle={fold}
            onChange={() => {
              void load();
            }}
          />
        )}
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

/**
 * The same grants as three cards, for somebody who has never seen a tool list.
 *
 * The cards come from the catalogue rather than from a list here, so a tool
 * renamed in the agent package cannot leave a card promising something that no
 * longer exists — and a card the install cannot honour has already had the
 * missing names taken out of it before it arrived.
 *
 * Which one is lit is worked out from the grant, never stored. That is what makes
 * the two screens one setting: tick a box in the power list, come back here, and
 * the card has gone dark because the profile no longer holds exactly that set.
 * The line under the cards says so rather than leaving the user to wonder why
 * none of them is lit.
 */
function CapabilityChoices({
  presets,
  granted,
  disabled,
  onChoose,
}: {
  presets: readonly CapabilityPreset[];
  granted: ReadonlySet<string>;
  disabled: boolean;
  onChoose: (tools: string[]) => void;
}): React.JSX.Element {
  const chosen = chosenPreset(presets, [...granted]);

  return (
    <>
      <p className="settings-muted">
        Everything here is something you chose, and anything that changes a file
        asks you before it does.
      </p>

      <div className="capability-cards">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="capability-card"
            aria-pressed={chosen?.id === preset.id}
            disabled={disabled}
            onClick={() => {
              onChoose(preset.tools);
            }}
          >
            <span className="capability-label">
              {preset.label}
              {/*
                A real space before the tag. Flexbox drops a whitespace-only text
                node from the layout, but `textContent` keeps it — and without it
                a screen reader reads this card as "computerRecommended".
              */}
              {preset.recommended && (
                <>
                  {' '}
                  <em className="capability-tag">Recommended</em>
                </>
              )}
            </span>
            <em className="capability-blurb">{preset.blurb}</em>
          </button>
        ))}
      </div>

      {chosen === undefined && (
        <p className="settings-muted">
          {granted.size === 0
            ? 'This agent is not allowed to do anything at all yet — not even ' +
              'read a file. Choosing one of the three above is how you change ' +
              'that.'
            : 'This agent has a set of abilities put together in Power user ' +
              'mode. Choosing one of the three above replaces it with that one.'}
        </p>
      )}
    </>
  );
}
