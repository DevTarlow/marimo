/**
 * Filtering a provider's model list for the searchable picker.
 *
 * A plain case-insensitive substring, with the endpoint's order preserved.
 * That order is the provider's own — OpenRouter returns its newest first — and
 * re-ranking by where the match lands would move the model the user just saw at
 * the top of the list. Matching is against the id because the id is the only
 * part of a provider's entry this app stores; a display name would be a second
 * thing to keep in step with what is saved.
 *
 * An empty query returns every model rather than none: the picker opens on the
 * full list, and "search" is a narrowing of it.
 */
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
