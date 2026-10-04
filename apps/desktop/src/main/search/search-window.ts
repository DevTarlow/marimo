/**
 * Web search through a hidden `BrowserWindow`.
 *
 * A plain `fetch` cannot search the web any more: DuckDuckGo answers a scripted
 * challenge (HTTP 202) and Mojeek answers 403, so a keyless search needs a real
 * browser engine. Electron already ships one, so this opens an offscreen window,
 * lets the page render, extracts the results, and closes it again — no extra
 * dependency, no API key, and no second process.
 *
 * Isolation: a non-persistent session partition (nothing survives the window and
 * nothing is shared with the app's own session, let alone the user's Chrome
 * profile), sandbox on, no preload, permission requests denied, and navigation
 * restricted to the engine's own origin. The page can talk to the engine; it
 * cannot redirect the window anywhere else.
 *
 * Searches are serialized, and the window is destroyed in `finally`, so a
 * timeout, a crash, or a quit cannot leave a stray renderer behind.
 */
import {BrowserWindow, session as electronSession} from 'electron';

import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@marimo/agent';

import {EXTRACT_RESULTS_SCRIPT, normalizeExtraction} from './parse.js';

const DEFAULT_ENGINE_URL = 'https://duckduckgo.com/';
const DEFAULT_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 250;
const PARTITION = 'marimo-search';

export interface BrowserSearchProviderOptions {
  engineUrl?: string;
  timeoutMs?: number;
}

export class BrowserSearchProvider implements WebSearchProvider {
  private readonly engine: URL;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private active: BrowserWindow | undefined;
  private disposed = false;

  constructor(options: BrowserSearchProviderOptions = {}) {
    this.engine = new URL(options.engineUrl ?? DEFAULT_ENGINE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const run = this.queue.then(
      () => this.runSearch(request),
      () => this.runSearch(request),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Destroys any live search window and refuses further searches. */
  dispose(): void {
    this.disposed = true;
    const window = this.active;
    this.active = undefined;
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
  }

  private async runSearch(
    request: WebSearchRequest,
  ): Promise<WebSearchResult[]> {
    if (this.disposed) {
      throw new Error('web search is shutting down');
    }

    const window = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.active = window;

    const engineOrigin = this.engine.origin;
    const destroy = (): void => {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    };
    const onAbort = (): void => destroy();
    request.signal?.addEventListener('abort', onAbort, {once: true});
    hardenSession();

    try {
      window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
      window.webContents.on('will-navigate', (event, url) => {
        if (!isSameOrigin(url, engineOrigin)) {
          event.preventDefault();
        }
      });

      await window.loadURL(
        `${this.engine.origin}${this.engine.pathname}?q=${encodeURIComponent(request.query)}`,
      );

      const deadline = Date.now() + this.timeoutMs;
      for (;;) {
        if (window.isDestroyed()) {
          throw new Error('the search window closed before results arrived');
        }
        const raw: unknown = await window.webContents
          .executeJavaScript(EXTRACT_RESULTS_SCRIPT, true)
          .catch(() => undefined);
        const {results, blocked} = normalizeExtraction(raw, request.limit);
        if (results.length > 0) {
          return results;
        }
        if (blocked) {
          throw new Error(
            'the search engine served an anti-bot challenge instead of results',
          );
        }
        if (Date.now() >= deadline) {
          // Nothing matched, and the page is not a challenge page: an honest
          // empty result rather than a failure.
          return [];
        }
        await delay(POLL_INTERVAL_MS, request.signal);
      }
    } catch (error) {
      if (request.signal?.aborted) {
        throw new Error('web search timed out');
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      destroy();
      if (this.active === window) {
        this.active = undefined;
      }
    }
  }
}

let sessionHardened = false;

/**
 * Locks down the shared `marimo-search` partition once: no permissions, and a
 * plain Chrome user agent, because Electron's own UA is one of the things
 * anti-bot pages look for.
 */
function hardenSession(): void {
  if (sessionHardened) {
    return;
  }
  sessionHardened = true;
  const searchSession = electronSession.fromPartition(PARTITION);
  searchSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    },
  );
  searchSession.setUserAgent(
    searchSession
      .getUserAgent()
      .replace(/\sElectron\/[\d.]+/, '')
      .replace(/\sMarimo Desktop\/[\d.]+/, ''),
  );
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('web search aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}
