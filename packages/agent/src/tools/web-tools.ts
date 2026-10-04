/**
 * `http_fetch`: a GET-only fetch tool with a response-size cap, a timeout and
 * (by default) a refusal to touch loopback or private-network hosts.
 *
 * The tool argument is model-authored, so an unguarded fetch is a
 * server-side-request-forgery primitive: a prompt could aim it at
 * `http://127.0.0.1:8080/admin` or a cloud metadata endpoint. The host check
 * runs on every redirect hop, because checking only the first URL is trivially
 * bypassed.
 */
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

import {FunctionTool} from '@google/adk';
import {z} from 'zod';

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const PRIVATE_V4_PATTERNS = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // carrier-grade NAT
  /^127\./,
  /^169\.254\./, // link-local, includes cloud metadata endpoints
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.168\./,
  /^198\.1[89]\./,
  /^22[4-9]\./,
  /^23\d\./,
  /^24\d\./,
  /^25[0-5]\./,
];

export interface WebToolContext {
  allowPrivateNetworkFetch: boolean;
}

export function createHttpFetchTool(context: WebToolContext) {
  return new FunctionTool({
    name: 'http_fetch',
    description:
      'Fetch a web page or HTTP API over GET and return its text body, up to ' +
      '512 KiB. Use this to read documentation or an API response. Only ' +
      'http:// and https:// URLs are supported, and private or loopback ' +
      'addresses are refused.',
    parameters: z.object({
      url: z.string().describe('Absolute http:// or https:// URL to fetch.'),
    }),
    execute: async ({url}) => {
      let current: URL;
      try {
        current = new URL(url);
      } catch {
        return `"${url}" is not a valid absolute URL.`;
      }

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const problem = await checkUrl(
          current,
          context.allowPrivateNetworkFetch,
        );
        if (problem) {
          return problem;
        }

        const response = await fetchWithTimeout(current);
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            return `${current.toString()} returned ${response.status} with no Location header.`;
          }
          current = new URL(location, current);
          continue;
        }

        const contentType = response.headers.get('content-type') ?? 'unknown';
        const body = await readCapped(response);
        return [
          `${response.status} ${response.statusText} — ${current.toString()}`,
          `content-type: ${contentType}`,
          '',
          body,
        ].join('\n');
      }

      return `Too many redirects (more than ${MAX_REDIRECTS}) starting from ${url}.`;
    },
  });
}

async function checkUrl(
  url: URL,
  allowPrivateNetwork: boolean,
): Promise<string | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Only http:// and https:// URLs are supported, got "${url.protocol}".`;
  }
  if (allowPrivateNetwork) {
    return undefined;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return `Refusing to fetch "${hostname}": loopback and private addresses are blocked. Enable "Allow private-network fetches" in Settings to permit this.`;
  }

  let addresses: string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await lookup(hostname, {all: true});
      addresses = resolved.map((entry) => entry.address);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `Could not resolve "${hostname}": ${reason}`;
    }
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return `Refusing to fetch "${hostname}" (resolves to ${address}): loopback and private addresses are blocked. Enable "Allow private-network fetches" in Settings to permit this.`;
    }
  }
  return undefined;
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return PRIVATE_V4_PATTERNS.some((pattern) => pattern.test(address));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      return isPrivateAddress(normalized.slice('::ffff:'.length));
    }
    if (normalized === '::' || normalized === '::1') {
      return true;
    }
    return (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }
  // Anything unparseable is treated as unsafe.
  return true;
}

async function fetchWithTimeout(url: URL): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5',
        'user-agent': 'MarimoDesktop/0.1 (+local agent)',
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Request to ${url.toString()} failed: ${reason}`);
  }
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) {
    return '(empty body)';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      const remaining = MAX_BYTES - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', {fatal: false}).decode(merged);
  return truncated ? `${text}\n\n[truncated at ${MAX_BYTES} bytes]` : text;
}
