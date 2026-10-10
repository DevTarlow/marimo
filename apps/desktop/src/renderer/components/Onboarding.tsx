/**
 * The first thing a new install should say.
 *
 * It used to be a screen that asked for an API key, which was the honest answer
 * when every provider was somebody else's service. It is not any more: the app
 * carries a model, so a fresh install can answer the first question without an
 * account, a key or an address — and a welcome screen that asked for one anyway
 * would be the app describing a requirement it does not have.
 *
 * So this says what is ready, and gets out of the way. What it is *gated* on is
 * `providerReady` rather than `hasApiKey`: the built-in model needs no
 * credential, and what can stop it working is a file that is not where the app
 * looked — a different problem, fixed in a different place, and the reason the
 * readiness answer carries a sentence with it.
 *
 * Nothing here decides whether the app can answer. The main process does, before
 * this is ever rendered: a working provider means the app opens on a normal chat.
 */
export function Onboarding({
  problem,
  onOpenSettings,
}: {
  /** Why it cannot answer yet, in the words of whoever knew. */
  problem: string;
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <div className="onboarding">
      <img className="onboarding-mark" src="./marimo-logo.png" alt="" />
      <h2>Welcome to Marimo Agent</h2>

      <p className="onboarding-lead">
        Something is not ready yet — the agent has nothing to think with until
        it is.
      </p>
      <p className="onboarding-note">{problem}</p>

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
