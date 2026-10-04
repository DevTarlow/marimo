/**
 * "Keep jobs running when the app is closed."
 *
 * The one switch that makes the background service real for a user, and the one
 * with a prerequisite worth stating plainly: the runner has no keychain, so an
 * encrypted key is one it cannot read. A service switched on over an encrypted
 * key does not fail loudly — it runs every minute, refuses for want of a key,
 * records that against the job, and does it again, with nobody watching. So the
 * reason is shown *before* the switch, not as an error afterwards.
 *
 * The failures are shown verbatim. Installing a timer is the one thing this app
 * does that reaches outside its own files, and when a step is refused the message
 * from `systemctl` or `launchctl` is the only thing that says which — along with
 * the command, so it can be finished by hand.
 */
import {useEffect, useState} from 'react';

import type {ServiceStatus} from '@marimo/protocol';

interface Change {
  installed: boolean;
  notes: string[];
  failures: Array<{what: string; detail: string}>;
}

export function KeepRunning(): React.JSX.Element | null {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Change | null>(null);

  const load = async (): Promise<void> => {
    try {
      setStatus(await window.marimo.call('service.status', {}));
    } catch {
      // The window is still usable without this row; a failed status read is not
      // worth an error banner over the conversation.
      setStatus(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (status === null) {
    return null;
  }

  const change = async (enable: boolean): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await window.marimo.call(
        enable ? 'service.enable' : 'service.disable',
        {},
      );
      setProblem(result);
      await load();
    } catch (failure) {
      setProblem({
        installed: status.installed,
        notes: [],
        failures: [
          {
            what: enable ? 'turn it on' : 'turn it off',
            detail: failure instanceof Error ? failure.message : String(failure),
          },
        ],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="keep-running">
      <label className="keep-head">
        <input
          type="checkbox"
          checked={status.installed}
          disabled={busy}
          onChange={(event) => {
            void change(event.target.checked);
          }}
        />
        <span>Keep jobs running when the app is closed</span>
      </label>

      {!status.keysReadable && (
        /*
         * Said before the switch, not after. The alternative is a user turning
         * this on, seeing nothing wrong, and finding out from a job that quietly
         * failed every hour overnight.
         */
        <p className="keep-note keep-warning">
          Your API key is encrypted, and the background runner has no keychain to
          read it with. Turn on &ldquo;Store secrets as plain text&rdquo; in
          Settings first, or every background run will stop at the key.
        </p>
      )}

      {status.installed && status.definitionPath.length > 0 && (
        <p className="keep-note">
          Set up at <code>{status.definitionPath}</code>
        </p>
      )}

      {problem?.failures.map((failure) => (
        <p className="keep-note keep-error" key={failure.what}>
          {failure.what}: {failure.detail}
        </p>
      ))}

      {problem !== null && problem.failures.length === 0 && problem.notes.length > 0 && (
        <p className="keep-note">
          {problem.installed ? 'On' : 'Off'} — with a caveat: {problem.notes[0]}
        </p>
      )}
    </div>
  );
}
