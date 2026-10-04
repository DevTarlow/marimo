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

import type {AppInfo, Theme} from '@marimo/protocol';

import {Composer} from './components/Composer.js';
import {SessionRail} from './components/SessionRail.js';
import {Transcript} from './components/Transcript.js';
import {useAgent} from './hooks/useAgent.js';

import './styles/chat.css';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [preview, setPreview] = useState<Theme | null>(null);
  const agent = useAgent();

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

  const theme: Theme = preview ?? info?.theme ?? 'dark';
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  const busy = agent.live?.running === true;
  const disabled = agent.profile === undefined;

  return (
    <div className="app">
      <SessionRail
        sessions={agent.sessions}
        activeId={agent.sessionId}
        onOpen={(id) => {
          void agent.open(id);
        }}
        onNew={() => {
          void agent.newSession();
        }}
        disabled={disabled}
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
          </div>
          <div className="head-theme">
            {(['light', 'dark'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="theme-button"
                aria-pressed={theme === value}
                onClick={() => {
                  setPreview(value);
                }}
              >
                {value}
              </button>
            ))}
          </div>
        </header>

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
        ) : (
          <Transcript
            messages={agent.messages}
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
          onSend={(text) => {
            void agent.send(text);
          }}
          onStop={() => {
            void agent.stop();
          }}
        />
      </main>
    </div>
  );
}
