/**
 * The first thing a new install should say.
 *
 * It used to be a screen that asked for an API key, and then one that downloaded
 * the model the app ran itself. Neither is right now: the app carries no model
 * and runs no engine, so what a fresh install is missing is a *provider* — an
 * address, a key and a model id — and that is set in one place, which is why
 * this only names the problem and opens it.
 *
 * The sentence is the main process's, not a rewrite of it here. A refusal
 * arrives as `modelProblem` because the failures have nothing in common — no
 * key, a key that cannot be decrypted, a provider this build does not know —
 * and a screen that said "not ready" for all of them would be a dead end for
 * each. The process that looked is the only one that knows which it is.
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
      <h2>Welcome to Marimo</h2>

      <p className="onboarding-lead">
        The bot has nothing to think with until it is pointed at a model.
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
        It can read files in the space you choose and use whatever else you
        switch on. Anything that changes something asks you first.
      </p>
    </div>
  );
}
