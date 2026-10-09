/**
 * What a provider says it serves.
 *
 * Every backend the app offers exposes the OpenAI-compatible `GET /models`
 * shape — an object with a `data` array whose entries carry an `id` — so one
 * reader covers all of them, and the provider only decides the address and the
 * credential. This is the call behind the "Fetch Models" button: the catalogue's
 * `fallbackModels` are placeholders, and this is what replaces them with names
 * the endpoint actually answers to.
 *
 * A body that carries no usable id is an error rather than an empty list.
 * "The endpoint answered and offers nothing" and "the endpoint answered with
 * something this code did not understand" are different problems, and a silent
 * empty list would leave the picker showing only the stored model with no hint
 * that the refresh failed.
 */
import {PROVIDERS} from '@marimo/protocol';
import type {ProviderId} from '@marimo/protocol';

export interface ProviderModelsOptions {
  provider: ProviderId;
  /**
   * Sent as `Authorization: Bearer …` when it is not empty. A local server
   * usually takes no key, and an empty `Bearer ` would be a claim about a
   * credential that is not there.
   */
  apiKey: string;
  /** Defaults to the provider's catalogue address. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Raised when the endpoint cannot be reached, refuses, or answers unusably. */
export class ProviderModelsError extends Error {
  /** The HTTP status, when there was a response at all. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderModelsError';
    this.status = status;
  }
}

/**
 * A list request is a quick round trip, not a turn: a slow answer means the
 * address is wrong or the server is not up, and waiting two minutes for that is
 * a button that looks broken.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchProviderModels(
  options: ProviderModelsOptions,
): Promise<string[]> {
  const descriptor = PROVIDERS[options.provider];
  // The transport strips trailing slashes for the same reason: `baseUrl` is a
  // directory, and a second slash before `models` is a different path.
  const baseUrl = (
    options.baseUrl ?? descriptor.defaultBaseUrl
  ).replace(/\/+$/, '');

  const headers: Record<string, string> = {Accept: 'application/json'};
  if (options.apiKey.length > 0) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (failure) {
    throw new ProviderModelsError(
      `Could not reach ${descriptor.label} at ${baseUrl}: ${describe(failure)}`,
    );
  }

  if (!response.ok) {
    throw new ProviderModelsError(
      `${descriptor.label} answered ${String(response.status)} for its model ` +
        `list: ${await readErrorBody(response)}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderModelsError(
      `${descriptor.label} did not answer with JSON.`,
    );
  }

  const models = modelIdsIn(payload);
  if (models.length === 0) {
    throw new ProviderModelsError(
      `${descriptor.label} answered but listed no models. Check its address ` +
        'and key.',
    );
  }
  return models;
}

/**
 * The ids out of either shape seen in the wild: OpenAI's `{data: [{id}]}` and
 * the older `{models: [...]}` some local servers still answer with.
 *
 * Order is left as the endpoint sent it. A provider that puts its newest models
 * first is saying something the picker should keep, and sorting three hundred
 * OpenRouter ids would throw that away.
 */
function modelIdsIn(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const entries = Array.isArray(record['data'])
    ? record['data']
    : Array.isArray(record['models'])
      ? record['models']
      : [];

  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      ids.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      const id = (entry as Record<string, unknown>)['id'];
      if (typeof id === 'string') {
        ids.push(id);
      }
    }
  }

  return [
    ...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length === 0
      ? response.statusText || 'no response body'
      : text.slice(0, 300);
  } catch {
    return response.statusText || 'unreadable response body';
  }
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
