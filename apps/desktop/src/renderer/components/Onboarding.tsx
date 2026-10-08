/**
 * The first thing a new install should say.
 *
 * A fresh app with no key currently shows an ordinary chat, and the user finds
 * out something is missing only by typing and being refused. That refusal is
 * honest and it is in the right place — but it is the *second* thing they learn,
 * and the first should have been the question.
 *
 * So this sits where the conversation would be, asks for the one thing that is
 * needed, and gets out of the way. It does not take the window over: the message
 * box stays, Settings stays reachable, and somebody who wants to look around
 * before signing up for anything can.
 *
 * It does *not* name the active provider. The app runs against several of them,
 * and a welcome that says "a DeepSeek key" reads as though that were the only
 * model it takes, which is the wrong first impression to give someone who has
 * not opened Settings yet. So the message is "any model, add a key for the one
 * you are using", and where to get that key is still a link rather than a dead
 * end: a blank box with no way to fill it is worse than a generic one.
 */
import {useState} from 'react';

import {PROVIDERS} from '@marimo/protocol';
import type {ProviderId, PublicSettings} from '@marimo/protocol';

/** Where to get a key, per provider. Absent for the ones that need none. */
const KEY_PAGES: Partial<Record<ProviderId, string>> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  openrouter: 'https://openrouter.ai/keys',
  gemini: 'https://aistudio.google.com/apikey',
};

export function Onboarding({
  settings,
  onSaved,
  onOpenSettings,
}: {
  settings: PublicSettings;
  onSaved: () => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const provider = PROVIDERS[settings.providers.active];
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('settings.setApiKey', {apiKey: key});
      setKey('');
      onSaved();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
      <h2>Welcome to Marimo Agent</h2>

      {provider.requiresApiKey ? (
        <>
          <p className="onboarding-lead">
            Marimo Agent works with any model. Add a key for the one you are
            using, and it stays on this computer.
          </p>
          <div className="onboarding-row">
            <input
              className="onboarding-input"
              type="password"
              value={key}
              placeholder="Paste your API key"
              aria-label="API key"
              disabled={busy}
              onChange={(event) => {
                setKey(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && key.trim().length > 0) {
                  void save();
                }
              }}
            />
            <button
              type="button"
              className="button button-primary"
              disabled={busy || key.trim().length === 0}
              onClick={() => {
                void save();
              }}
            >
              Save
            </button>
          </div>
          {problem !== null && <p className="onboarding-problem">{problem}</p>}
          <p className="onboarding-note">
            No key yet?{' '}
            {KEY_PAGES[settings.providers.active] === undefined ? (
              <>You can add one later in Settings.</>
            ) : (
              <a
                href={KEY_PAGES[settings.providers.active]}
                target="_blank"
                rel="noreferrer noopener"
              >
                Get a key
              </a>
            )}{' '}
            — or{' '}
            <button type="button" className="onboarding-link" onClick={onOpenSettings}>
              choose a different provider
            </button>
            .
          </p>
        </>
      ) : (
        <>
          <p className="onboarding-lead">
            {provider.label} runs on your own machine and needs no key. Point it
            at your server in Settings when you are ready — until then, it will
            say it cannot reach it.
          </p>
          <button type="button" className="button button-primary" onClick={onOpenSettings}>
            Open Settings
          </button>
        </>
      )}

      <p className="onboarding-note onboarding-quiet">
        It can read files in the folder you choose and use whatever else you
        switch on. Anything that changes something asks you first.
      </p>
    </div>
  );
}

/** Electron wraps a rejected `invoke` in its own prefix, which is noise here. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}
