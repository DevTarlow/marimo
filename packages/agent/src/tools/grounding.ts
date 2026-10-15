/**
 * Gemini-only grounding.
 *
 * ADK's `GOOGLE_SEARCH` is a built-in: it does not run locally, it adds a
 * `googleSearch` entry to the model request. Attached to anything that is not a
 * Gemini model it throws — `Google search tool is not supported for model
 * <name>` — which would fail every turn, not just a search.
 *
 * The gate is the *provider* rather than the model id, and that is the whole
 * judgement in this file. A model whose name starts with `gemini-` is not
 * necessarily served by Google: OpenRouter routes to Google's models under names
 * like `google/gemini-3.1-pro`, and a llama.cpp server can be started with any
 * file name at all. Grounding is a property of the endpoint that implements it,
 * so the question is which provider answers — and the model id is only a label
 * inside it.
 */
import {GOOGLE_SEARCH} from '@google/adk';
import type {BaseTool} from '@google/adk';

import type {ProviderId} from '@marimo/protocol';

export function supportsGoogleSearch(provider: ProviderId): boolean {
  return provider === 'gemini';
}

/** The built-in grounding tools this provider can actually serve. */
export function groundingTools(provider: ProviderId): BaseTool[] {
  return supportsGoogleSearch(provider) ? [GOOGLE_SEARCH] : [];
}
