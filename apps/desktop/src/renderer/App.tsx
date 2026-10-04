/**
 * The window, for now a shell.
 *
 * This is the placeholder that proves the pieces are connected: the preload
 * bridge answers, the main process can name the install, and both token blocks
 * render. The conversation surface, the rail and the capability panels replace
 * the body of this file — the calls it makes and the theme it sets are the parts
 * meant to survive.
 */
import {useEffect, useState} from 'react';

import type {AppInfo, Theme} from '@marimo/protocol';

import './styles/shell.css';

type Load =
  | {state: 'loading'}
  | {state: 'ready'; info: AppInfo}
  | {state: 'failed'; reason: string};

/**
 * An error from `ipcRenderer.invoke` arrives wrapped in Electron's own prefix,
 * which is noise in a message a person reads.
 */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/u, '');
}

export function App(): React.JSX.Element {
  const [load, setLoad] = useState<Load>({state: 'loading'});
  /**
   * A preview-only override.
   *
   * Both token blocks need looking at while the UI is being built, and the real
   * preference is a settings write that lands with Settings. Until then this
   * flips the attribute in place, so `system` and the resolved answer stay
   * visible in the panel below.
   */
  const [preview, setPreview] = useState<Theme | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await window.marimo.call('app.info', {});
        if (!cancelled) {
          setLoad({state: 'ready', info});
        }
      } catch (error) {
        if (!cancelled) {
          setLoad({state: 'failed', reason: describeError(error)});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved: Theme =
    preview ?? (load.state === 'ready' ? load.info.theme : 'dark');

  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);

  return (
    <div className="shell">
      <header className="shell-head">
        <img className="shell-mark" src="./marimo-logo.png" alt="" />
        <div>
          <h1 className="shell-title">Marimo Agent</h1>
          <p className="shell-sub">
            {load.state === 'ready'
              ? `v${load.info.version} · Electron ${load.info.electron}`
              : 'Starting…'}
          </p>
        </div>
        <div className="shell-theme">
          {(['light', 'dark'] as const).map((theme) => (
            <button
              key={theme}
              type="button"
              className="shell-theme-btn"
              aria-pressed={resolved === theme}
              onClick={() => {
                setPreview(theme);
              }}
            >
              {theme}
            </button>
          ))}
        </div>
      </header>

      <main className="shell-body">
        {load.state === 'loading' && <p className="shell-note">Reading the install…</p>}

        {load.state === 'failed' && (
          <div className="shell-error" role="alert">
            <strong>The window could not reach the app.</strong>
            <p>{load.reason}</p>
          </div>
        )}

        {load.state === 'ready' && (
          <>
            <div className="shell-card">
              <h2>This is the shell</h2>
              <p>
                The bridge answers and the theme system works. The conversation
                surface, the agent rail and the capability panels replace this
                panel next.
              </p>
            </div>

            <dl className="shell-facts">
              <div>
                <dt>Product</dt>
                <dd>{load.info.name}</dd>
              </div>
              <div>
                <dt>Platform</dt>
                <dd>{load.info.platform}</dd>
              </div>
              <div>
                <dt>Chrome</dt>
                <dd>{load.info.chrome}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd>{load.info.node}</dd>
              </div>
              <div className="shell-facts-wide">
                <dt>User data</dt>
                <dd>
                  <code>{load.info.userData}</code>
                </dd>
              </div>
              <div className="shell-facts-wide">
                <dt>Secrets</dt>
                <dd>
                  {load.info.secretsEncrypted
                    ? 'Encrypted with the OS keychain.'
                    : 'No keychain available — running jobs while the app is closed will need the plain-text opt-in.'}
                </dd>
              </div>
              <div className="shell-facts-wide">
                <dt>Theme</dt>
                <dd>
                  <code>{load.info.themeMode}</code> → <code>{load.info.theme}</code>
                  {preview !== null && ' (previewing the other one)'}
                </dd>
              </div>
            </dl>
          </>
        )}
      </main>
    </div>
  );
}
