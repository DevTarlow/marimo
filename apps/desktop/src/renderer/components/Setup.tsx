/**
 * The first run, as five steps and a bot.
 *
 * What a fresh install is missing is not one thing. It has no Space, so a bot
 * would have nothing to work in; it has no bot but the one it talks to, so a
 * person who came here to make one has to find the right card in Settings first;
 * and it has no provider, so nothing can answer at all. This screen is those
 * three facts in the order they are useful, and it is the reason the window
 * offers no message box yet — a box that cannot be answered is worse than no box.
 *
 * Five rules shape it:
 *
 * - **It writes as it goes.** Every step's controls write the moment they are
 *   used, exactly as Settings does, so quitting in the middle loses nothing and
 *   the app is in a described state rather than a half-applied form.
 * - **A bot exists before it is asked about.** The bot step creates the profile
 *   and the step after it edits what now exists, which is why backing out of
 *   that second step returns to the list of bots rather than to the form: a form
 *   there would make a second bot. The person's own words about being spoken to
 *   get that step because a field nobody opens a settings screen to find is a
 *   field that stays empty.
 * - **It reads what already exists.** A Space already loaded, bots already made,
 *   a delegate grant already given: the step says so and moves on rather than
 *   creating a second copy of anything. That is what makes an interrupted flow
 *   safe to reopen, and it is why nothing here needs a saved position.
 * - **The lead is put back.** `profiles.create` switches the active profile, so
 *   every bot made here is followed by a `select` back to Marimo. The person is
 *   talking to Marimo, and a window that reopened on a bot they made in a wizard
 *   would be a different app.
 * - **Skipping is a real answer.** Every step before the provider can be
 *   stepped over, and skipping all of them leaves a working app that simply has
 *   no bots yet — which is the state Settings is for.
 *
 * The provider step is its own component: it is half the code and all of the
 * caveats.
 */
import {useEffect, useState} from 'react';

import type {
  AgentProfile,
  CapabilityPreset,
  ProfileCatalog,
  PublicSettings,
} from '@marimo/protocol';

import {chosenPreset} from '../capabilities.js';
import {describe} from '../describe.js';
import type {AgentController} from '../hooks/useAgent.js';
import {SetupProvider} from './SetupProvider.js';

/**
 * The steps, in the order they are shown.
 *
 * Labels rather than a number out of five: "Model" says what is being decided,
 * and "step 3 of 5" says only how much is left.
 *
 * `voice` comes straight after a bot is made, and it is the step that owns the
 * profile field Settings calls "How to talk to me". It is the one thing about a
 * bot that is the *user's* text rather than the app's, so it is worth asking for
 * at the moment they are thinking about that bot rather than leaving it buried
 * in a settings screen they may never open.
 */
const STEPS = [
  {id: 'space', label: 'Space'},
  {id: 'bot', label: 'Your first bot'},
  {id: 'voice', label: 'How to talk to me'},
  {id: 'more', label: 'More bots'},
  {id: 'provider', label: 'Model'},
] as const;

type StepId = (typeof STEPS)[number]['id'];
type SetupScreen = 'welcome' | StepId;

/** What the bot form collects, and what the step that uses it hands over. */
interface BotDraft {
  name: string;
  tools: string[];
  delegate: boolean;
}

export function Setup({
  settings,
  agent,
  onSettings,
  onClose,
}: {
  settings: PublicSettings;
  /** For the two things this screen does to the window: load a Space, file a chat. */
  agent: AgentController;
  /** Every write's own answer, so one copy of the settings is live. */
  onSettings: (next: PublicSettings) => void;
  /** Closes the flow, either because it finished or because the user deferred. */
  onClose: () => void;
}): React.JSX.Element {
  const [screen, setScreen] = useState<SetupScreen>('welcome');
  const [catalog, setCatalog] = useState<ProfileCatalog | null>(null);
  /**
   * The bot the flow is in the middle of, between making it and giving it a
   * voice. Held as an id rather than as a draft because the profile exists from
   * the moment it is created: the step after this one edits a bot that is
   * already on the roster, so a reload in between loses nothing.
   */
  const [madeId, setMadeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * Once, on mount, and nothing is written by it: the presets and the delegate
   * tool's name are the agent package's, and this window reads them rather than
   * spelling them out.
   */
  useEffect(() => {
    let cancelled = false;
    void window.marimo
      .call('profiles.catalog', {})
      .then((loaded) => {
        if (!cancelled) {
          setCatalog(loaded);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setProblem(describe(failure));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The lead is the first profile in the document, which is what `freshFile`
   * created at install. Read from position rather than from an id kept anywhere,
   * because deleting the lead promotes the next profile and that rule is already
   * how the agent package seeds identities.
   */
  const lead: AgentProfile | undefined = settings.profiles[0];
  const bots = settings.profiles.slice(1);
  /*
   * The bot the voice step is about. Read back out of the roster rather than
   * kept as a copy: `profiles.update` answers with the whole file, so the name
   * in that step's heading is the name the store holds.
   */
  const justMade =
    madeId === null
      ? undefined
      : settings.profiles.find((entry) => entry.id === madeId);
  const delegateTool = catalog?.delegationTool;
  const presets = catalog?.presets ?? [];

  const go = (next: SetupScreen): void => {
    setProblem(null);
    setScreen(next);
  };

  /** Loads a Space, and files the untouched starter chat into it. */
  const loadSpace = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const added = await agent.loadWorkspace();
      if (!added) {
        // A closed picker is an answer, not a failure.
        return;
      }
      /*
       * The chat this window opened on was created before any Space existed, so
       * it is unfiled — and a first run that loaded a folder and left the chat
       * under "Other chats" beside an empty Space is the confusing half of the
       * two. Only an empty, unfiled chat is moved: a conversation with something
       * in it stays where it was started.
       */
      const session = agent.sessions.find(
        (entry) => entry.id === agent.sessionId,
      );
      if (
        session === undefined ||
        session.workspaceId !== undefined ||
        agent.messages.length > 0
      ) {
        return;
      }
      const {activeWorkspaceId} = await window.marimo.call(
        'workspaces.list',
        {},
      );
      if (activeWorkspaceId !== null) {
        await agent.moveSession(session.id, activeWorkspaceId);
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Makes one bot, then puts Marimo back in charge.
   *
   * The `finally` is the point: `profiles.create` switches the active profile to
   * the new bot, so a refusal anywhere after it would otherwise leave the window
   * on a bot that was never finished being set up. Whoever failed, the person is
   * talking to Marimo.
   */
  const makeBot = async (draft: BotDraft): Promise<string | null> => {
    if (lead === undefined) {
      setProblem('This install has no bot to put back. Reopen the app.');
      return null;
    }
    setBusy(true);
    setProblem(null);
    let made: string | null = null;
    try {
      const created = await window.marimo.call('profiles.create', {
        name: draft.name,
      });
      await window.marimo.call('profiles.update', {
        profileId: created.activeProfileId,
        patch: {enabledTools: draft.tools},
      });
      if (
        draft.delegate &&
        delegateTool !== undefined &&
        !lead.enabledTools.includes(delegateTool)
      ) {
        /*
         * Additive, like every other grant this app writes on somebody's
         * behalf: nothing the user already allowed is taken away, and the one
         * tool added is the one that makes the bots they just made reachable.
         */
        await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, delegateTool]},
        });
      }
      made = created.activeProfileId;
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      try {
        const back = await window.marimo.call('profiles.select', {
          profileId: lead.id,
        });
        onSettings({
          ...settings,
          profiles: back.profiles,
          activeProfileId: back.activeProfileId,
        });
      } catch (failure) {
        setProblem((current) => current ?? describe(failure));
      }
      setBusy(false);
    }
    return made;
  };

  /**
   * Making a bot leads to asking how it should talk, always.
   *
   * That is the one question about a bot the app cannot answer for the person,
   * and it is about the bot they have just named — so the step after this one is
   * about the profile that now exists rather than a draft still in a form.
   */
  const submitBot = async (draft: BotDraft): Promise<void> => {
    const made = await makeBot(draft);
    if (made !== null) {
      setMadeId(made);
      go('voice');
    }
  };

  /**
   * Writes the user's own words onto the bot just made.
   *
   * An empty box writes nothing rather than clearing: the bot was created
   * seconds ago, so there is nothing there to clear, and "no words of their own"
   * is the state `preferences` is absent for. The prompt builder reads both the
   * same way, which is why leaving it empty is a real answer rather than a
   * half-finished one.
   */
  const saveVoice = async (text: string): Promise<void> => {
    const preferences = text.trim();
    if (madeId === null || preferences.length === 0) {
      go('more');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const updated = await window.marimo.call('profiles.update', {
        profileId: madeId,
        patch: {preferences},
      });
      onSettings({
        ...settings,
        profiles: updated.profiles,
        activeProfileId: updated.activeProfileId,
      });
      go('more');
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const space = agent.workspaces.find(
    (entry) => entry.id === agent.activeWorkspaceId,
  );

  return (
    <div className="onboarding setup">
      <div className="setup-inner">
        {screen !== 'welcome' && (
          <ol className="setup-steps" aria-label="Setup steps">
            {STEPS.map((entry) => (
              <li
                key={entry.id}
                className="setup-step"
                aria-current={entry.id === screen ? 'step' : undefined}
              >
                {entry.label}
              </li>
            ))}
          </ol>
        )}

        {screen === 'welcome' && (
          <div className="setup-body">
            <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
            <h2>Welcome to Marimo</h2>
            <p className="onboarding-lead">
              Marimo is the bot you talk to, and it runs the ones you make. Each
              bot has a name, its own instructions and its own memory, and
              Marimo hands it work.
            </p>
            <p className="onboarding-note">
              Neither can answer yet. This app carries no model of its own, so
              the last step is choosing the service that provides one.
            </p>
            <p className="onboarding-note">
              A Space for it to work in, a bot to give work to, then the model.
              You can change all of it later in Settings.
            </p>
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  go('space');
                }}
              >
                Get started
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  onClose();
                }}
              >
                Skip setup
              </button>
            </div>
          </div>
        )}

        {screen === 'space' && (
          <div className="setup-body">
            <h2>Where should it work?</h2>
            <p className="onboarding-lead">
              A Space is a folder on your computer. Bots can read and write
              there and nowhere else, and every chat remembers the Space it
              started in.
            </p>
            <p className="onboarding-note">
              The markdown files in it are the Space's documents, which the
              Documents button above the chat lists and opens.
            </p>
            {space !== undefined && (
              <p className="settings-muted">
                You already have <strong>{space.name}</strong> loaded, at{' '}
                <code>{space.path}</code>.
              </p>
            )}
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => {
                  if (space === undefined) {
                    void loadSpace();
                    return;
                  }
                  go('bot');
                }}
              >
                {space === undefined ? 'Choose a folder…' : 'Continue'}
              </button>
              {space !== undefined && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => {
                    void loadSpace();
                  }}
                >
                  Choose another folder…
                </button>
              )}
              {space === undefined && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => {
                    go('bot');
                  }}
                >
                  Later
                </button>
              )}
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  go('welcome');
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {screen === 'bot' && (
          <div className="setup-body">
            <h2>{bots.length > 0 ? 'Another bot' : 'Your first bot'}</h2>
            <p className="onboarding-lead">
              A bot is for one kind of work. Give it a name and say what it may
              do; Marimo hands it jobs that suit it, and you can add it to any
              chat.
            </p>
            {bots.length > 0 && (
              <p className="settings-muted">
                So far: {bots.map((bot) => bot.name).join(', ')}.
              </p>
            )}
            <BotForm
              presets={presets}
              busy={busy}
              delegateTool={delegateTool}
              lead={lead}
              submitLabel="Make this bot"
              onSubmit={submitBot}
            />
            <div className="onboarding-actions">
              {/*
                Two different exits, because this step is reached two ways. With
                no bots yet it is the first one, and stepping over it is a real
                answer — the app is perfectly usable with Marimo alone, and
                Settings is where a bot is made later. With bots already on the
                roster the person came here from the list, so there is one way
                out and it is back to that list.
              */}
              {bots.length === 0 ? (
                <>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() => {
                      go('provider');
                    }}
                  >
                    Skip the bot for now
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() => {
                      go('space');
                    }}
                  >
                    Back
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => {
                    go('more');
                  }}
                >
                  Never mind
                </button>
              )}
            </div>
          </div>
        )}

        {screen === 'voice' && (
          <div className="setup-body">
            <h2>How should {justMade?.name ?? 'this bot'} talk to you?</h2>
            <p className="onboarding-lead">
              How you want to be spoken to, in your own words. It applies to
              every conversation you have with {justMade?.name ?? 'this bot'},
              and it is read after everything the app tells it about itself, so
              it wins wherever the two disagree.
            </p>
            <p className="onboarding-note">
              Things like what to call you, how long an answer should be, or
              that you would rather hear when it is unsure. Every bot keeps its
              own, Marimo included, and Settings is where you change any of them
              later.
            </p>
            <VoiceForm busy={busy} onSubmit={saveVoice} />
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  go('more');
                }}
              >
                Skip this
              </button>
            </div>
          </div>
        )}

        {screen === 'more' && (
          <div className="setup-body">
            <h2>Any more bots?</h2>
            <p className="onboarding-lead">
              Each bot keeps its own memory and its own conversations, which is
              why drafting and research can be two bots.
            </p>
            {bots.length > 0 && (
              <p className="settings-muted">
                So far: {bots.map((bot) => bot.name).join(', ')}.
              </p>
            )}
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => {
                  go('bot');
                }}
              >
                Add another bot
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  go('provider');
                }}
              >
                That's enough for now
              </button>
              {/*
                Back to the bot that was just made rather than to the form: the
                profile exists, and a form would make a second one.
              */}
              {justMade !== undefined && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => {
                    go('voice');
                  }}
                >
                  Back
                </button>
              )}
            </div>
          </div>
        )}

        {screen === 'provider' && (
          <SetupProvider
            settings={settings}
            onSettings={onSettings}
            onBack={() => {
              go('more');
            }}
            onDone={onClose}
          />
        )}

        {problem !== null && <p className="settings-problem">{problem}</p>}
      </div>
    </div>
  );
}

/**
 * The one question a bot is asked before it exists.
 *
 * Three fields and no more, because everything else about a bot is written by
 * using it: its instructions are the app's seed until somebody edits them in
 * Settings, and which Space it works in follows the rail unless it is pinned
 * there. What cannot wait is its name, what it may do, and whether Marimo is
 * allowed to hand it anything.
 */
function BotForm({
  presets,
  busy,
  delegateTool,
  lead,
  submitLabel,
  onSubmit,
}: {
  presets: readonly CapabilityPreset[];
  busy: boolean;
  /** Absent on a build whose tool set has no delegation, which hides the box. */
  delegateTool: string | undefined;
  lead: AgentProfile | undefined;
  submitLabel: string;
  onSubmit: (draft: BotDraft) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState('');
  /*
   * The recommended preset, which is also what `profiles.create` grants before
   * anything is chosen: the card the user sees lit is the state the bot is
   * actually in.
   */
  const [tools, setTools] = useState<string[]>(
    () => presets.find((preset) => preset.recommended)?.tools ?? [],
  );
  const [delegate, setDelegate] = useState(true);
  /* The same comparison Settings lights its cards with, so the two agree. */
  const chosen = chosenPreset(presets, tools);

  const alreadyDelegates =
    delegateTool !== undefined &&
    (lead?.enabledTools.includes(delegateTool) ?? false);

  return (
    <form
      className="setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed.length === 0 || busy) {
          return;
        }
        void onSubmit({name: trimmed, tools, delegate});
      }}
    >
      <label className="settings-field">
        <span>Its name</span>
        <em className="settings-why">
          Name it after the work. You can rename it later.
        </em>
        <input
          className="settings-input"
          type="text"
          value={name}
          placeholder="Writer"
          autoFocus
          spellCheck={false}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>

      <span className="setup-label">What should it be able to do?</span>
      <div className="capability-cards">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="capability-card"
            aria-pressed={chosen?.id === preset.id}
            disabled={busy}
            onClick={() => {
              setTools([...preset.tools]);
            }}
          >
            <span className="capability-label">
              {preset.label}
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

      {delegateTool !== undefined && (
        <label className="settings-check">
          <input
            type="checkbox"
            checked={alreadyDelegates || delegate}
            disabled={busy || alreadyDelegates}
            onChange={(event) => {
              setDelegate(event.target.checked);
            }}
          />
          <span>
            Let Marimo hand work to your bots
            <em className="settings-why">
              {alreadyDelegates
                ? 'Marimo can already do this.'
                : 'Without it, Marimo can talk about your bots but cannot ask them to do anything.'}
            </em>
          </span>
        </label>
      )}

      <div className="onboarding-actions">
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || name.trim().length === 0}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * The one field about a bot that belongs to the person rather than to the app.
 *
 * The same value Settings calls "How to talk to me", asked for here because this
 * is the moment somebody is thinking about the bot at all: it is their own text,
 * it is sent after everything the app says about who the bot is, and a field
 * nobody opens a settings screen to find is a field that stays empty. The
 * placeholder is Settings' own, so the two are one answer to what belongs in it.
 *
 * Written on submit rather than on blur: the step is a decision, and the button
 * is what says the decision was made.
 */
function VoiceForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  /** Saves the words, or advances if there are none. */
  onSubmit: (text: string) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState('');

  return (
    <form
      className="setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) {
          void onSubmit(text);
        }
      }}
    >
      <label className="settings-field">
        <span>How to talk to me</span>
        <em className="settings-why">
          Your words rather than the app's. Leaving it empty is fine.
        </em>
        <textarea
          className="settings-input settings-preferences"
          rows={4}
          aria-label="How to talk to me"
          placeholder="Call me Tarlow. Tell me when you are unsure rather than guessing."
          autoFocus
          value={text}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>

      <div className="onboarding-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          Save and continue
        </button>
      </div>
    </form>
  );
}
