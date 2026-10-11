/**
 * The window.
 *
 * A rail of conversations, the conversation, and the composer. The shape is
 * deliberately the familiar one: an assistant you talk to is not a place to
 * invent a layout, and every departure from the shape people already know is a
 * thing they have to learn before they can ask a question.
 *
 * The theme switch is a preview for now — the preference is a settings write
 * that lands with Settings — but the tokens underneath it are the real ones, so
 * what it previews is what will ship.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import {COMMAND_IDS, COMMANDS, THEME_MODES} from '@marimo/protocol';
import type {
  AppInfo,
  ExperienceMode,
  PublicSettings,
  Theme,
  ThemeMode,
} from '@marimo/protocol';

import {Composer} from './components/Composer.js';
import {Onboarding} from './components/Onboarding.js';
import {RecallIntro} from './components/RecallIntro.js';
import {Search} from './components/Search.js';
import {Settings} from './components/Settings.js';
import {Transcript} from './components/Transcript.js';
import {WorkspaceRail} from './components/WorkspaceRail.js';
import {useAgent} from './hooks/useAgent.js';
import {recallOfferOnRead} from './recall-offer.js';

import './styles/chat.css';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [searching, setSearching] = useState(false);
  /**
   * Whether the recall offer is up.
   *
   * Shown at the one moment somebody is watching a download finish, and only
   * then: this is not a nag kept in a store, it is the second half of the first
   * run. A later launch — or a user who answered it — finds the switch in
   * Settings, where every other capability lives.
   */
  const [recallIntro, setRecallIntro] = useState(false);
  /**
   * The settings as the window needs them for the first-run question.
   *
   * Fetched here rather than inside `useAgent` because it is a fact about the
   * *pane*, not about the conversation: the agent is perfectly happy to hold a
   * conversation it cannot yet answer.
   */
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const agent = useAgent();

  /*
   * Stable, because an effect below depends on it: a function rebuilt on every
   * render would re-run that effect on every render, and this one writes state.
   */
  const loadSettings = useCallback((): void => {
    void window.marimo
      .call('settings.get', {})
      .then(({settings: loaded}) => {
        setSettings(loaded);
      })
      .catch(() => {
        // A settings read that fails is already reported by Settings itself; an
        // error here would be a second one over the conversation.
      });
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await window.marimo.call('app.info', {});
        if (!cancelled) {
          setInfo(value);
        }
      } catch {
        // The agent surface reports its own failures; a missing version line is
        // not worth a second error on screen.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The tray's Settings command. Written as an effect keyed on a counter rather
   * than handled inside the event listener, because the listener is registered
   * once and `setShowSettings` from inside it would be a second source of truth
   * about what the window is showing.
   */
  useEffect(() => {
    if (agent.openSettings > 0) {
      setShowSettings(true);
    }
  }, [agent.openSettings]);

  /*
   * `Ctrl/Cmd+K`, on the window rather than globally.
   *
   * An OS-wide hotkey works from any application, which is a decision about
   * somebody's whole desktop rather than about this app — and it is the kind of
   * thing that is far easier to add later than to explain away.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearching((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  /*
   * What the colours actually are.
   *
   * `system` is resolved against what the OS reported, so a machine that
   * switches to dark at sunset takes the window with it — which is the whole
   * point of the preference not being a boolean.
   */
  const theme: Theme =
    agent.themeMode === 'system' ? (info?.theme ?? 'dark') : agent.themeMode;
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  /** Writes the preference. The event that comes back is what moves the switch. */
  const setThemeMode = (mode: ThemeMode): void => {
    void window.marimo
      .call('settings.set', {patch: {appearance: {theme: mode}}})
      .catch(() => undefined);
  };

  /*
   * Which size the app is drawn at.
   *
   * `simple` is the everyday screen and gets the roomy one; `power` keeps the
   * density this app has always had, so somebody who turns the switch on to find
   * a setting does not also find everything moved. Set on `<html>` beside
   * `data-theme`, and only on this window: the companion is a fixed 340×460
   * bubble whose layout is measured in its own test.
   *
   * Flipped from Settings rather than from here, which is why the dialog hands
   * the new value back: the mode is a fact about this window, and the window is
   * not the dialog.
   */
  const experienceMode: ExperienceMode = settings?.experienceMode ?? 'simple';
  useEffect(() => {
    document.documentElement.dataset['density'] =
      experienceMode === 'simple' ? 'comfortable' : 'compact';
  }, [experienceMode]);

  const busy = agent.busy;
  const disabled = agent.profile === undefined;

  /*
   * A finished download is a fact the gate is derived from — `modelReady` comes
   * from the main process, which has just seen the files appear — so the payload is
   * re-read rather than the window assuming the download did what it said.
   */
  useEffect(() => {
    loadSettings();
  }, [agent.modelRevision, loadSettings]);

  /*
   * The transition, not the state. `settings.modelReady` is true on every launch
   * for anybody who has used the app, and offering recall to somebody who is
   * already using it would be the nag this is shaped to avoid — so the offer
   * belongs to the moment it goes from false to true, which is a download
   * finishing.
   *
   * What `wasReady` may not record is the `false` a payload that has not arrived
   * yet produces, or every launch looks like that transition. It is written only
   * once there is a payload to have an opinion about, and the decision itself is
   * in `recall-offer.ts` where it can be tested.
   */
  const modelReady = settings?.modelReady ?? false;
  const wasReady = useRef<boolean | null>(null);
  useEffect(() => {
    const read = recallOfferOnRead({
      loaded: settings !== null,
      wasReady: wasReady.current,
      modelReady,
      enabled: settings?.recall.enabled ?? false,
      introSeen: settings?.recall.introSeen ?? false,
    });
    if (read.offer) {
      setRecallIntro(true);
    }
    wasReady.current = read.remember;
  }, [modelReady, settings]);

  /*
   * The commands the `+` menu offers: the catalogue filtered by what the user
   * has switched off. Drawn from the protocol constant rather than from a list
   * here, so the menu and the Settings switches cannot describe different sets.
   */
  const disabledCommands = settings?.disabledCommands ?? [];
  const commands = COMMAND_IDS.filter(
    (id) => !disabledCommands.includes(id),
  ).map((id) => ({id, ...COMMANDS[id]}));

  /*
   * It stays up until the user answers *it*, rather than disappearing the moment
   * the setting flips: pressing "Turn on Recall" starts a 310 MB download, and
   * dropping somebody into the app mid-download would leave them with no sign it
   * is happening. The screen's own buttons close it.
   */
  if (recallIntro && settings !== null) {
    return (
      <RecallIntro
        onDone={() => {
          setRecallIntro(false);
          /*
           * Answering it, either way, is what makes it once. The write is not
           * awaited and its failure is not reported: the worst outcome is the
           * card being offered again after a later model download, and an error
           * over the conversation about a flag the user never asked to see would
           * be worse than that.
           */
          void window.marimo
            .call('settings.set', {patch: {recall: {introSeen: true}}})
            .then(({settings: saved}) => {
              setSettings(saved);
            })
            .catch(() => undefined);
        }}
      />
    );
  }

  if (showSettings) {
    return (
      <Settings
        onClose={() => {
          setShowSettings(false);
          /*
           * The pane is re-read on the way back. A grant changed in Settings is
           * not visible in the conversation, and coming back to a window built
           * from settings that no longer apply is how a change looks like it did
           * not take.
           */
          void agent.reload();
          loadSettings();
        }}
        modelProgress={agent.modelProgress}
        modelRevision={agent.modelRevision}
        onExperienceModeChange={(mode) => {
          /*
           * The density is this window's, and the switch is in the dialog, so
           * the new value comes back rather than being read again: the redraw
           * has to happen on the flip, not when the dialog closes — a screen
           * that re-spaces itself two clicks later reads as a bug.
           */
          setSettings((current) =>
            current === null ? current : {...current, experienceMode: mode},
          );
        }}
      />
    );
  }

  return (
    <div className="app">
      <Search
        open={searching}
        onClose={() => {
          setSearching(false);
        }}
      />
      <WorkspaceRail
        workspaces={agent.workspaces}
        sessions={agent.sessions}
        activeSessionId={agent.sessionId}
        activeWorkspaceId={agent.activeWorkspaceId}
        disabled={disabled}
        onOpenSession={(id) => {
          void agent.open(id);
        }}
        onNewSession={(workspaceId) => {
          void agent.newSession(workspaceId);
        }}
        onSelectWorkspace={(workspaceId) => {
          void agent.selectWorkspace(workspaceId);
        }}
        onLoadWorkspace={() => {
          void agent.loadWorkspace();
        }}
        onRenameWorkspace={(workspaceId, name) => {
          void agent.renameWorkspace(workspaceId, name);
        }}
        onRemoveWorkspace={(workspaceId) => {
          void agent.removeWorkspace(workspaceId);
        }}
        onOpenWorkspace={(workspaceId) => {
          void agent.openWorkspace(workspaceId);
        }}
        onMoveSession={(sessionId, workspaceId) => {
          void agent.moveSession(sessionId, workspaceId);
        }}
        onRenameSession={(sessionId, title) => {
          void agent.renameSession(sessionId, title);
        }}
        onDeleteSession={(sessionId) => {
          void agent.removeSession(sessionId);
        }}
      />

      <main className="main">
        <header className="head">
          <img className="head-mark" src="./marimo-logo.png" alt="" />
          <div className="head-who">
            <h1 className="head-name">
              {agent.profile?.name ?? 'Marimo Agent'}
            </h1>
            {info !== null && (
              <p className="head-sub">
                {info.name} v{info.version}
              </p>
            )}
            {/*
              Where this conversation works, moved out of Settings and onto the
              surface it is about. It is the open chat's folder rather than the
              current one: a conversation remembers the folder it was started in,
              and the two differ the moment another folder is picked.
            */}
            {agent.activeFolder !== null && (
              <p className="head-sub head-workspace" title={agent.activeFolder}>
                {agent.activeFolder}
              </p>
            )}
          </div>
          <button
            type="button"
            className="button button-quiet button-small"
            title="Search your folder and memory (Ctrl+K)"
            onClick={() => {
              setSearching(true);
            }}
          >
            Search
          </button>
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={() => {
              setShowSettings(true);
            }}
          >
            Settings
          </button>
          <div className="head-theme" role="group" aria-label="Theme">
            {THEME_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className="theme-button"
                /* Pressed means "this is the preference", not "this is the
                   colour" — with `system` chosen, neither Light nor Dark is
                   pressed even though one of them is what you are looking at. */
                aria-pressed={agent.themeMode === mode}
                onClick={() => {
                  setThemeMode(mode);
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </header>

        {info?.warning !== undefined && (
          /*
           * Shown, not dismissible, and not styled as a failure: the app works
           * and one thing will not. A user who closes it has lost the only
           * explanation they would ever get for a job that never fires.
           */
          <div className="warning" role="status">
            <span>{info.warning}</span>
          </div>
        )}

        {agent.error !== null && (
          <div className="error" role="alert">
            <span>{agent.error}</span>
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={agent.dismissError}
            >
              Dismiss
            </button>
          </div>
        )}

        {!agent.ready ? (
          <p className="loading">Starting…</p>
        ) : settings !== null && !settings.modelReady ? (
          /*
           * Asked before it is needed, rather than after. The refusal a turn
           * gives is honest and in the right place — but it is the *second*
           * thing a new user learns, and the first should have been the reason.
           *
           * What can stop this install answering is the weights or the engine not
           * being where the app looked, or an engine that refused to start, and
           * the sentence saying which is written by the process that looked.
           */
          <Onboarding
            problem={
              settings.modelProblem ??
              'The app has no way to answer yet. Settings will say what is missing.'
            }
            progress={agent.modelProgress}
            revision={agent.modelRevision}
            onOpenSettings={() => {
              setShowSettings(true);
            }}
            /*
             * A download that has started changes what the gate should say, and
             * the gate reads the settings payload — so the payload is re-read
             * rather than the screen guessing at what the download did.
             */
            onChanged={() => {
              loadSettings();
            }}
          />
        ) : (
          <Transcript
            messages={agent.messages}
            outbox={agent.outbox}
            live={agent.live}
            pending={agent.pending}
            onDecide={(callId, confirmed) => {
              void agent.decide(callId, confirmed);
            }}
            busy={busy}
          />
        )}

        <Composer
          busy={busy}
          disabled={disabled || !agent.ready}
          /*
           * Asked for by conversation, not by folder: the main process judges
           * every picked file against the folder *this* conversation works in —
           * the same one its turn's file tools are confined to — so a file the
           * window would happily attach is one the agent can actually read.
           */
          onPickFiles={async () => {
            const profile = agent.profile;
            const sessionId = agent.sessionId;
            if (profile === undefined || sessionId === null) {
              throw new Error(
                'There is no conversation open to attach a file to.',
              );
            }
            const {files, skipped} = await window.marimo.call('files.pick', {
              profileId: profile.id,
              sessionId,
            });
            return {files, skipped};
          }}
          commands={commands}
          onRunCommand={async (id) => {
            const profile = agent.profile;
            const sessionId = agent.sessionId;
            if (profile === undefined || sessionId === null) {
              throw new Error('There is no conversation open to act on.');
            }
            switch (id) {
              case 'compact': {
                const result = await window.marimo.call('sessions.compact', {
                  profileId: profile.id,
                  sessionId,
                });
                /*
                 * Re-read before answering, so the note and the card appear
                 * together: the card *is* the news, and a sentence saying the
                 * conversation was compacted over a transcript that still shows
                 * the old messages is a window contradicting itself.
                 */
                await agent.refresh();
                return result.compacted ? null : (result.reason ?? null);
              }
            }
          }}
          onSend={async (text) => await agent.send(text)}
          onStop={() => {
            void agent.stop();
          }}
        />
      </main>
    </div>
  );
}
