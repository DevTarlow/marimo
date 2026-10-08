/**
 * The first thing a new install should say.
 *
 * A fresh app with no key currently shows an ordinary chat, and the user finds
 * out something is missing only by typing and being refused. That refusal is
 * honest and it is in the right place — but it is the *second* thing they learn,
 * and the first should have been the question.
 *
 * So this says what is missing and where to fix it, and gets out of the way. It
 * deliberately does not collect the key itself. Settings already owns picking a
 * provider, entering its key, choosing a model, pointing at a server and the
 * plain-text choice that comes with storing a secret; a second, smaller copy of
 * that form here would be two places to keep in step, and a key box that cannot
 * say which provider it belongs to. The screen explains, the panel does the
 * work.
 *
 * Nothing here decides whether a key exists. `hasApiKey` does, before this is
 * ever rendered: a stored key, or a provider that needs none, means the app
 * opens on a normal chat instead.
 */
export function Onboarding({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <div className="onboarding">
      <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
      <h2>Welcome to Marimo Agent</h2>

      <p className="onboarding-lead">
        Marimo Agent works with any model. Choose a provider and add its API key
        in Settings — the key stays on this computer.
      </p>
      <button
        type="button"
        className="button button-primary"
        onClick={onOpenSettings}
      >
        Open Settings
      </button>

      <p className="onboarding-note onboarding-quiet">
        It can read files in the folder you choose and use whatever else you
        switch on. Anything that changes something asks you first.
      </p>
    </div>
  );
}
