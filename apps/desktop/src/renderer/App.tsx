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
import {useEffect, useState} from 'react';

import {THEME_MODES} from '@marimo/protocol';
import type {AppInfo, PublicSettings, Theme, ThemeMode} from '@marimo/protocol';

import {Composer} from './components/Composer.js';
import {Onboarding} from './components/Onboarding.js';
import {Settings} from './components/Settings.js';
import {Transcript} from './components/Transcript.js';
import {WorkspaceRail} from './components/WorkspaceRail.js';
import {useAgent} from './hooks/useAgent.js';

import './styles/chat.css';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * The settings as the window needs them for the first-run question.
   *
   * Fetched here rather than inside `useAgent` because it is a fact about the
   * *pane*, not about the conversation: the agent is perfectly happy to hold a
   * conversation it cannot yet answer.
   */
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const agent = useAgent();

  const loadSettings = (): void => {
    void window.marimo
      .call('settings.get', {})
      .then(({settings: loaded}) => {
        setSettings(loaded);
      })
      .catch(() => {
        // A settings read that fails is already reported by Settings itself; an
        // error here would be a second one over the conversation.
      });
  };

  useEffect(() => {
    loadSettings();
  }, []);

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

  const busy = agent.busy;
  const disabled = agent.profile === undefined;

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
      />
    );
  }

  return (
    <div className="app">
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
            <h1 className="head-name">{agent.profile?.name ?? 'Marimo Agent'}</h1>
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
        ) : settings !== null && !settings.hasApiKey ? (
          /*
           * Asked before it is needed, rather than after. The refusal a turn
           * gives is honest and in the right place — but it is the *second*
           * thing a new user learns, and the first should have been the
           * question.
           */
          <Onboarding
            onOpenSettings={() => {
              setShowSettings(true);
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
          onSend={async (text) => await agent.send(text)}
          onStop={() => {
            void agent.stop();
          }}
        />
      </main>
    </div>
  );
}
