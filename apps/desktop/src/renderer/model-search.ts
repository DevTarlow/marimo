/**
 * The two pure rules behind the model pickers: what a provider offers, and how
 * a search narrows it.
 *
 * Both answer for the provider they are *given*, and neither knows which
 * provider the app is currently pointed at. That is the whole of what was wrong
 * before: a model is a pair, an agent and a conversation can each name their
 * own, and a picker that listed whichever endpoint happened to be active showed
 * an empty list — or another service's names — for every choice that was not the
 * app's own.
 *
 * Filtering is a plain case-insensitive substring, with the endpoint's order
 * preserved. That order is the provider's own — OpenRouter returns its newest
 * first — and re-ranking by where the match lands would move the model the user
 * just saw at the top of the list. Matching is against the id because the id is
 * the only part of a provider's entry this app stores; a display name would be a
 * second thing to keep in step with what is saved.
 *
 * An empty query returns every model rather than none: the picker opens on the
 * full list, and "search" is a narrowing of it.
 */
import {fallbackModelsFor} from '@marimo/protocol';
import type {AvailableModels, ProviderId} from '@marimo/protocol';

/** What one picker should list, and where the list came from. */
export interface ModelChoices {
  /**
   * The names to offer, with the stored value first when the list has stopped
   * carrying it. A model the endpoint has stopped advertising may still answer,
   * and a trigger showing something other than what is stored is worse than one
   * showing a name nothing lists any more.
   */
  models: string[];
  /**
   * Whether the endpoint has actually been asked.
   *
   * False means `models` are the catalogue's placeholders — what this build
   * ships with — and a control that drew them without saying so would be
   * stating a guess as the provider's answer. It is also what tells a control it
   * cannot fill itself that there is something to go and fetch.
   */
  fetched: boolean;
}

/**
 * The models to offer for one provider, whatever the app is pointed at.
 *
 * `available` is the payload's per-provider record, so a provider that has never
 * been fetched presents as absent — see `AvailableModels` — and the catalogue's
 * names stand in until somebody asks it. That fallback is deliberately here
 * rather than in the settings store: a store that filled the gap could not tell
 * the reader which of the two it was handing back, and every picker would be
 * showing guesses as answers.
 */
export function modelChoicesFor(
  available: AvailableModels,
  provider: ProviderId,
  stored: string,
): ModelChoices {
  const reported = available[provider];
  const models =
    reported === undefined ? fallbackModelsFor(provider) : [...reported];
  return {
    models:
      stored.length > 0 && !models.includes(stored)
        ? [stored, ...models]
        : models,
    fetched: reported !== undefined,
  };
}

export function filterModels(
  models: readonly string[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...models];
  }
  return models.filter((model) => model.toLowerCase().includes(needle));
}
