/**
 * The `marimo-asset://` scheme, which serves the one kind of picture the app
 * keeps for the user.
 *
 * An uploaded bot icon lives in the user-data directory. The renderer is
 * sandboxed and, in development, served from `http://localhost`, so it cannot
 * read a `file://` URL — and handing it one would also mean handing it a path it
 * could use for anything else. A scheme of the app's own is what lets the same
 * image arrive in a browser window and in a packaged one, through a handler that
 * decides exactly which files exist for it.
 *
 * The URL's shape is `marimo-asset://bot/<profile id>.png?v=<version>`. The
 * version is ignored by this handler; it is there so a replacement is a different
 * URL and no cache has to be told to forget the old one.
 */
import {readFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';

import {protocol, session} from 'electron';

import {ASSET_SCHEME} from '@marimo/protocol';
import {avatarFileName} from '@marimo/runtime';

/**
 * Registers the scheme, and **must be called before Electron's `app` is ready**.
 *
 * Electron reads a scheme's privileges once, while it builds the URL request
 * factory inside the ready sequence. A call after that is a warning nobody reads
 * and a scheme that stays non-standard.
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
      },
    },
  ]);
}

/**
 * The profile id a `marimo-asset://bot/...` URL names, or undefined.
 *
 * The decoded id may not contain a path separator. The app's own ids are UUIDs
 * and never do; a hand-edited URL that tries to reach another file is refused
 * here rather than relied on to be sanitised one step later.
 */
export function botAvatarProfileIdFromUrl(url: string): string | undefined {
  // Refused before the URL parser normalises a `..` away: the answer would be a
  // different name that happens to resolve inside the directory, not the one
  // that was asked for.
  if (url.includes('..')) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== 'bot') {
    return undefined;
  }
  const encoded = parsed.pathname.replace(/^\//u, '');
  if (!encoded.endsWith('.png')) {
    return undefined;
  }
  let id: string;
  try {
    id = decodeURIComponent(encoded.slice(0, -'.png'.length));
  } catch {
    return undefined;
  }
  if (id.length === 0 || id.includes('/') || id.includes('\\')) {
    return undefined;
  }
  return id;
}

let installed = false;

/**
 * Installs the one handler for the scheme, after the app is ready.
 *
 * A module-level guard because Electron refuses a second handler on one scheme;
 * the app calls this once at boot, and the guard means a test or a future second
 * caller cannot turn that into a startup warning.
 */
export function installAssetHandler(avatarsDir: string): void {
  if (installed) {
    return;
  }
  installed = true;
  const root = resolve(avatarsDir);

  session.defaultSession.protocol.handle(ASSET_SCHEME, async (request) => {
    const profileId = botAvatarProfileIdFromUrl(request.url);
    if (profileId === undefined) {
      return refuse(404, 'That is not an image this app serves.');
    }
    const file = resolve(join(root, avatarFileName(profileId)));
    /*
     * The second check, against the resolved path. `avatarFileName` is already
     * one segment, and this asserts the boundary rather than trusting that the
     * helper is still one segment after a later change.
     */
    if (!file.startsWith(`${root}${sep}`)) {
      return refuse(403, 'That image is not one this app keeps.');
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      return refuse(404, 'That image is not there.');
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        // The URL carries the version, so a replacement is a new request.
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {'content-type': 'text/plain; charset=utf-8'},
  });
}
