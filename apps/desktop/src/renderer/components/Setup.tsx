/**
 * The first run, as a model, a Space, a bot, its Persona, and more bots.
 *
 * What a fresh install is missing is not one thing. It has no provider, so
 * nothing can answer; no Space, so a bot would have nothing to work in; and no
 * bot but the one it talks to, so a person who came here to make one has to find
 * the right card in Settings first. The model is first because the guided path
 * needs something to think with, and the rest of the flow is offered after it.
 *
 * Six rules shape it:
 *
 * - **The model is the only required step.** Until a provider is chosen and
 *   readable the window offers no message box at all, and a wizard that asked for
 *   a Space and a bot first would be asking about work nothing can do. "Set this
 *   up later" closes the flow; the short card is where somebody comes back.
 * - **Three ways to make a bot.** A starter role, a step-by-step form, or a
 *   conversation with Marimo that ends in a review card. All three write the
 *   same draft to `profiles.create`, so the store and the prompt cannot tell
 *   which door somebody came through.
 * - **It writes as it goes.** Every step's controls write the moment they are
 *   used, exactly as Settings does, so quitting in the middle loses nothing and
 *   the app is in a described state rather than a half-applied form.
 * - **A bot exists before its Persona is asked about.** The bot step creates the
 *   profile and the step after it edits what now exists, which is why backing out
 *   of that second step returns to the list of bots rather than to the form: a
 *   form there would make a second bot.
 * - **It reads what already exists.** A Space already loaded, bots already made,
 *   a delegate grant already given: the step says so and moves on rather than
 *   creating a second copy of anything. That is what makes an interrupted flow
 *   safe to reopen, and it is why nothing here needs a saved position.
 * - **The lead is put back.** `profiles.create` switches the active profile, so
 *   every bot made here is followed by a `select` back to Marimo Bot. The person
 *   is talking to Marimo Bot, and a window that reopened on a bot they made in a
 *   wizard would be a different app.
 *
 * The provider step is its own component: it is half the code and all of the
 * caveats.
 */
import {useEffect, useState} from 'react';

import type {
  AgentProfile,
  BotDraft,
  BotTemplate,
  CapabilityPreset,
  ProfileCatalog,
  PublicSettings,
} from '@marimo/protocol';

import {chosenPreset} from '../capabilities.js';
import {describe} from '../describe.js';
import type {AgentController} from '../hooks/useAgent.js';
import {BotTemplatePicker} from './BotTemplatePicker.js';
import {PersonaForm} from './PersonaForm.js';
import {SetupProvider} from './SetupProvider.js';

/**
 * The steps, in the order they are shown.
 *
 * Labels rather than a number: "Model" says what is being decided, and "step 1
 * of 5" says only how much is left. The Persona step comes straight after a bot
 * is made, because it is about the bot the person is thinking about right now.
 */
const STEPS = [
  {id: 'provider', label: 'Model'},
  {id: 'space', label: 'Space'},
  {id: 'bot', label: 'Your first bot'},
  {id: 'persona', label: 'Persona'},
  {id: 'more', label: 'More bots'},
] as const;

type StepId = (typeof STEPS)[number]['id'];
type SetupScreen = 'welcome' | StepId;
type BotPath = 'template' | 'step' | null;

export function Setup({
  settings,
  agent,
  onSettings,
  onStartBuilder,
  onClose,
}: {
  settings: PublicSettings;
  /** For the two things this screen does to the window: load a Space, file a chat. */
  agent: AgentController;
  /** Every write's own answer, so one copy of the settings is live. */
  onSettings: (next: PublicSettings) => void;
  /**
   * Hands the rest of the flow to Marimo. Answers a problem instead of throwing:
   * a refusal has to leave this screen up with a sentence on it.
   */
  onStartBuilder: () => Promise<{ok: boolean; problem?: string}>;
  /** Closes the flow, either because it finished or because the user deferred. */
  onClose: () => void;
}): React.JSX.Element {
  const [screen, setScreen] = useState<SetupScreen>('welcome');
  const [catalog, setCatalog] = useState<ProfileCatalog | null>(null);
  /**
   * The bot the flow is in the middle of, between making it and giving it a
   * Persona. Held as an id rather than as a draft because the profile exists
   * from the moment it is created: the step after this one edits a bot that is
   * already on the roster, so a reload in between loses nothing.
   */
  const [madeId, setMadeId] = useState<string | null>(null);
  const [path, setPath] = useState<BotPath>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<
    string | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * Once, on mount, and nothing is written by it: the presets, the starter
   * roles and the two tool names are the agent package's and the protocol's, and
   * this window reads them rather than spelling them out.
   */
  useEffect(() => {
    let cancelled = false;
    void window.marimo
      .call('profiles.catalog', {})
      .then((loaded) => {
        if (!cancelled) {
          setCatalog(loaded);
          setSelectedTemplateId(loaded.botTemplates[0]?.id);
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
   * The bot the Persona step is about. Read back out of the roster rather than
   * kept as a copy: `profiles.update` answers with the whole file, so the name
   * in that step's heading is the name the store holds.
   */
  const justMade =
    madeId === null
      ? undefined
      : settings.profiles.find((entry) => entry.id === madeId);
  const delegateTool = catalog?.delegationTool;
  const builderTool = catalog?.builderTool;
  const presets = catalog?.presets ?? [];
  const templates = catalog?.botTemplates ?? [];

  const go = (next: SetupScreen): void => {
    setProblem(null);
    setPath(null);
    setScreen(next);
  };

  /** Applies a profile-list answer to the one settings copy the window holds. */
  const applyProfiles = (next: {
    profiles: AgentProfile[];
    activeProfileId: string;
  }): void => {
    onSettings({
      ...settings,
      profiles: next.profiles,
      activeProfileId: next.activeProfileId,
    });
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
   * Makes one bot, then puts Marimo Bot back in charge.
   *
   * The `finally` is the point: `profiles.create` switches the active profile to
   * the new bot, so a refusal anywhere after it would otherwise leave the window
   * on a bot that was never finished being set up. Whoever failed, the person is
   * talking to Marimo Bot.
   */
  const makeBot = async (
    draft: BotDraft,
    delegate: boolean,
  ): Promise<AgentProfile | null> => {
    if (lead === undefined) {
      setProblem('This install has no bot to put back. Reopen the app.');
      return null;
    }
    setBusy(true);
    setProblem(null);
    let made: AgentProfile | null = null;
    try {
      const created = await window.marimo.call('profiles.create', {draft});
      made = created.created;
      if (
        delegate &&
        delegateTool !== undefined &&
        !lead.enabledTools.includes(delegateTool)
      ) {
        /*
         * Additive, like every other grant this app writes on somebody's
         * behalf: nothing the user already allowed is taken away, and the one
         * tool added is the one that makes the bots they just made reachable.
         */
        const updated = await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, delegateTool]},
        });
        applyProfiles(updated);
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      try {
        const back = await window.marimo.call('profiles.select', {
          profileId: lead.id,
        });
        applyProfiles(back);
      } catch (failure) {
        setProblem((current) => current ?? describe(failure));
      }
      setBusy(false);
    }
    return made;
  };

  /**
   * Making a bot leads to asking about its Persona, always.
   *
   * That is the one question about a bot the app cannot answer for the person,
   * and it is about the bot they have just named — so the step after this one is
   * about the profile that now exists rather than a draft still in a form.
   */
  const submitBot = async (
    draft: BotDraft,
    delegate: boolean,
  ): Promise<void> => {
    const made = await makeBot(draft, delegate);
    if (made !== null) {
      setMadeId(made.id);
      go('persona');
    }
  };

  /**
   * Writes the user's own words onto the bot just made.
   *
   * An empty box writes an empty Persona rather than being skipped: the starter
   * text was shown, so somebody who deleted it meant to. "Keep the starter text"
   * is the button that writes nothing.
   */
  const savePersona = async (text: string): Promise<void> => {
    if (madeId === null) {
      go('more');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const updated = await window.marimo.call('profiles.update', {
        profileId: madeId,
        patch: {persona: text},
      });
      applyProfiles(updated);
      go('more');
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hands the bot-making conversation to Marimo.
   *
   * The tool is granted first, additively, because an install that made its lead
   * before this feature existed has no `draft_bot` checkbox ticked. The grant is
   * written before the session starts so the runtime's own check passes; the App
   * closes this flow only after the session exists.
   */
  const startBuilder = async (): Promise<void> => {
    if (lead === undefined) {
      setProblem('This install has no bot to talk to. Reopen the app.');
      return;
    }
    if (builderTool === undefined) {
      setProblem(
        'This build cannot draft bots. Use one of the other two ways, or ' +
          'update the app.',
      );
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (!lead.enabledTools.includes(builderTool)) {
        const updated = await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, builderTool]},
        });
        applyProfiles(updated);
      }
      const started = await onStartBuilder();
      if (!started.ok) {
        setProblem(started.problem ?? 'Could not start the conversation.');
      }
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
            <h2>Welcome to Marimo Bot</h2>
            <p className="onboarding-lead">
              Marimo Bot is the bot you talk to, and it runs the ones you make.
              Each bot has a name, a Role it starts from, a Persona you write,
              and its own memory.
            </p>
            <p className="onboarding-note">
              Neither can answer yet. This app carries no model of its own, so
              the first step is choosing the service that provides one.
            </p>
            <p className="onboarding-note">
              Then a Space for it to work in, and a bot — from a starter role,
              built step by step, or talked through with Marimo. You can change
              all of it later in Settings.
            </p>
            <div className="onboarding-actions">
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  go('provider');
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

        {screen === 'provider' && (
          <SetupProvider
            settings={settings}
            onSettings={onSettings}
            onBack={() => {
              go('welcome');
            }}
            onNext={() => {
              go('space');
            }}
            onLater={onClose}
          />
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
              The markdown files in it are the Space&rsquo;s documents, which
              the Documents button above the chat lists and opens.
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
                  go('provider');
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
            {bots.length > 0 && (
              <p className="settings-muted">
                So far: {bots.map((bot) => bot.name).join(', ')}.
              </p>
            )}

            {path === null && (
              <>
                <p className="onboarding-lead">
                  A bot is for one kind of work. Give it a name and a starting
                  point; Marimo Bot hands it jobs that suit it, and you can add
                  it to any chat.
                </p>
                <div className="setup-path-cards">
                  <button
                    type="button"
                    className="setup-path-card"
                    disabled={busy}
                    onClick={() => {
                      setProblem(null);
                      setPath('template');
                    }}
                  >
                    <span className="setup-path-label">Start from a role</span>
                    <em className="setup-path-blurb">
                      Writer, Marketer, Researcher and more. It begins with a
                      Role and a Persona you can make yours.
                    </em>
                  </button>
                  <button
                    type="button"
                    className="setup-path-card"
                    disabled={busy}
                    onClick={() => {
                      setProblem(null);
                      setPath('step');
                    }}
                  >
                    <span className="setup-path-label">
                      Build it step by step
                    </span>
                    <em className="setup-path-blurb">
                      Choose a role or start blank, say what it may do, then
                      write its Persona.
                    </em>
                  </button>
                  <button
                    type="button"
                    className="setup-path-card"
                    disabled={busy || builderTool === undefined}
                    onClick={() => {
                      void startBuilder();
                    }}
                  >
                    <span className="setup-path-label">
                      Talk it through with Marimo
                    </span>
                    <em className="setup-path-blurb">
                      {builderTool === undefined
                        ? 'This build cannot draft bots.'
                        : 'Marimo asks a few questions, drafts the bot, and shows it to you before anything is made.'}
                    </em>
                  </button>
                </div>
              </>
            )}

            {path === 'template' && (
              <TemplateBotForm
                templates={templates}
                selectedId={selectedTemplateId}
                busy={busy}
                delegateTool={delegateTool}
                lead={lead}
                onSelect={setSelectedTemplateId}
                onSubmit={submitBot}
                onBack={() => {
                  setPath(null);
                }}
              />
            )}

            {path === 'step' && (
              <BotForm
                templates={templates}
                presets={presets}
                busy={busy}
                delegateTool={delegateTool}
                lead={lead}
                submitLabel="Make this bot"
                onSubmit={submitBot}
                onBack={() => {
                  setPath(null);
                }}
              />
            )}

            {path === null && (
              <div className="onboarding-actions">
                {/*
                  Two different exits, because this step is reached two ways.
                  With no bots yet it is the first one, and stepping over it is
                  a real answer — the app is perfectly usable with Marimo Bot
                  alone, and Settings is where a bot is made later. With bots
                  already on the roster the person came here from the list, so
                  there is one way out and it is back to that list.
                */}
                {bots.length === 0 ? (
                  <>
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={busy}
                      onClick={() => {
                        go('more');
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
            )}
          </div>
        )}

        {screen === 'persona' && (
          <div className="setup-body">
            <h2>Who should {justMade?.name ?? 'this bot'} be?</h2>
            <p className="onboarding-lead">
              Its Persona is the text that makes it yours: what it is for, how
              it should sound, and how you want to be spoken to. It is sent after
              the Role, so it wins wherever the two disagree.
            </p>
            <p className="onboarding-note">
              Every bot keeps its own, Marimo Bot included, and Settings is
              where you change any of them later.
            </p>
            <PersonaForm
              name={justMade?.name ?? 'this bot'}
              initial={justMade?.persona ?? ''}
              busy={busy}
              onSubmit={savePersona}
              onSkip={() => {
                go('more');
              }}
            />
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
                onClick={onClose}
              >
                That&rsquo;s enough for now
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
                    go('persona');
                  }}
                >
                  Back
                </button>
              )}
            </div>
          </div>
        )}

        {problem !== null && <p className="settings-problem">{problem}</p>}
      </div>
    </div>
  );
}

/**
 * The starter-role form: pick a card, name it, make it.
 *
 * The template decides the Role, the seeded Persona, the tools and the avatar;
 * the only thing this form asks for is the name and whether Marimo Bot may hand
 * it work. The Persona step after it is where the person changes the character,
 * because that is a decision about a bot that exists rather than a draft.
 */
function TemplateBotForm({
  templates,
  selectedId,
  busy,
  delegateTool,
  lead,
  onSelect,
  onSubmit,
  onBack,
}: {
  templates: readonly BotTemplate[];
  selectedId: string | undefined;
  busy: boolean;
  delegateTool: string | undefined;
  lead: AgentProfile | undefined;
  onSelect: (id: string | undefined) => void;
  onSubmit: (draft: BotDraft, delegate: boolean) => Promise<void>;
  onBack: () => void;
}): React.JSX.Element {
  const selected = templates.find((template) => template.id === selectedId);
  const [name, setName] = useState(selected?.suggestedName ?? '');
  const [delegate, setDelegate] = useState(true);
  const alreadyDelegates =
    delegateTool !== undefined &&
    (lead?.enabledTools.includes(delegateTool) ?? false);

  return (
    <>
      <p className="onboarding-lead">
        Pick the role closest to the job. It comes with a brief and a starting
        Persona, and both are yours to change.
      </p>
      <BotTemplatePicker
        templates={templates}
        selectedId={selectedId}
        busy={busy}
        allowCustom={false}
        onSelect={(id) => {
          onSelect(id);
          const template = templates.find((entry) => entry.id === id);
          if (template !== undefined) {
            setName(template.suggestedName);
          }
        }}
      />
      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed.length === 0 || busy || selected === undefined) {
            return;
          }
          void onSubmit({name: trimmed, templateId: selected.id}, delegate);
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
            placeholder={selected?.suggestedName ?? 'Writer'}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
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
              Let Marimo Bot hand work to your bots
              <em className="settings-why">
                {alreadyDelegates
                  ? 'Marimo Bot can already do this.'
                  : 'Without it, Marimo Bot can talk about your bots but cannot ask them to do anything.'}
              </em>
            </span>
          </label>
        )}
        <div className="onboarding-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || name.trim().length === 0 || selected === undefined}
          >
            Make this bot
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={onBack}
          >
            Back
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * The step-by-step bot: a role, a name, and what it may do.
 *
 * The Role comes from a starter card or from the generic bot contract; a custom
 * bot's job is written in its Persona on the next step, which is what keeps a
 * Role reset from erasing the person's description of the work.
 */
function BotForm({
  templates,
  presets,
  busy,
  delegateTool,
  lead,
  submitLabel,
  onSubmit,
  onBack,
}: {
  templates: readonly BotTemplate[];
  presets: readonly CapabilityPreset[];
  busy: boolean;
  /** Absent on a build whose tool set has no delegation, which hides the box. */
  delegateTool: string | undefined;
  lead: AgentProfile | undefined;
  submitLabel: string;
  onSubmit: (draft: BotDraft, delegate: boolean) => Promise<void>;
  onBack: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const selectedTemplate = templates.find(
    (template) => template.id === templateId,
  );
  /*
   * The recommended preset, which is also what `profiles.create` grants before
   * anything is chosen: the card the user sees lit is the state the bot is
   * actually in. A starter role replaces that with its own grant, which is
   * honest — a Writer's tools are not one of the three sizes.
   */
  const [tools, setTools] = useState<string[]>(
    () => presets.find((preset) => preset.recommended)?.tools ?? [],
  );
  const [delegate, setDelegate] = useState(true);
  const chosen = chosenPreset(presets, tools);

  const alreadyDelegates =
    delegateTool !== undefined &&
    (lead?.enabledTools.includes(delegateTool) ?? false);

  const chooseTemplate = (id: string | undefined): void => {
    setTemplateId(id);
    const template = templates.find((entry) => entry.id === id);
    if (template !== undefined) {
      setTools([...template.tools]);
      setName((current) =>
        current.trim().length === 0 ? template.suggestedName : current,
      );
      return;
    }
    /*
     * Back to scratch: the recommended grant, not the last template's. A Writer
     * that was switched to a custom bot and kept the Writer's tools would be a
     * bot whose Role and grant disagree.
     */
    setTools([...(presets.find((preset) => preset.recommended)?.tools ?? [])]);
  };

  return (
    <>
      <p className="onboarding-lead">
        Choose a role if one fits, or start from scratch. A custom bot&rsquo;s
        job is written in its Persona on the next step.
      </p>
      <BotTemplatePicker
        templates={templates}
        selectedId={templateId}
        busy={busy}
        onSelect={chooseTemplate}
      />
      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed.length === 0 || busy) {
            return;
          }
          void onSubmit(
            {
              name: trimmed,
              ...(templateId === undefined ? {} : {templateId}),
              tools,
            },
            delegate,
          );
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
            placeholder={selectedTemplate?.suggestedName ?? 'Writer'}
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
              Let Marimo Bot hand work to your bots
              <em className="settings-why">
                {alreadyDelegates
                  ? 'Marimo Bot can already do this.'
                  : 'Without it, Marimo Bot can talk about your bots but cannot ask them to do anything.'}
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
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={onBack}
          >
            Back
          </button>
        </div>
      </form>
    </>
  );
}
