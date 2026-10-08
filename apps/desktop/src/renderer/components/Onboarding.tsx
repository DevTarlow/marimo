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
 * It names the active provider and lets the user switch, because a key on its
 * own does not say whose it is: "Paste your API key" is a question nobody can
 * answer without knowing which service is about to read it. Showing the picker
 * here also frames the choice as one of several — the point of the "any model"
 * lead — instead of leaving a newcomer to guess that DeepSeek is the only one.
 * And it says where the key comes from, because a blank box with no way to fill
 * it is a dead end.
 */
import {useState} from 'react';

import {PROVIDER_IDS, PROVIDERS} from '@marimo/protocol';
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

  /*
   * Switching provider from here is the same write Settings makes, and it has
   * to reload the settings afterwards: the key box below belongs to the
   * provider, so without the reload the user would choose one service and be
   * shown another one's field. A provider that needs no key makes `hasApiKey`
   * true on the way back, which is what takes this screen down and leaves the
   * chat — the same behaviour as choosing it in Settings.
   */
  const choose = async (id: ProviderId): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await window.marimo.call('settings.set', {
        patch: {providers: {active: id}},
      });
      /*
       * A part-typed key belonged to the provider that was selected when it was
       * typed. Leaving it in the box would offer it up to the next provider's
       * Save button, which is how the wrong secret gets stored under the wrong
       * name.
       */
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
            Marimo Agent works with any model. Pick a provider below and paste
            its key — the key stays on this computer.
          </p>
          <label className="onboarding-field">
            <span>Provider</span>
            <select
              className="onboarding-input"
              value={settings.providers.active}
              disabled={busy}
              onChange={(event) => {
                const next = PROVIDER_IDS.find(
                  (id) => id === event.target.value,
                );
                if (next !== undefined) {
                  void choose(next);
                }
              }}
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                </option>
              ))}
            </select>
          </label>
          <div className="onboarding-row">
            <input
              className="onboarding-input"
              type="password"
              value={key}
              placeholder={`Paste your ${provider.label} key`}
              aria-label={`${provider.label} API key`}
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
                Get a {provider.label} key
              </a>
            )}
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
