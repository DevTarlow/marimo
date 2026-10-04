/**
 * Gemini-only grounding.
 *
 * ADK's `GOOGLE_SEARCH` is a built-in: it does not run locally, it adds a
 * `googleSearch` entry to the model request. Attached to anything that is not a
 * Gemini model it throws — `Google search tool is not supported for model
 * <name>` — which would fail every turn, not just a search. This app's provider
 * is DeepSeek, so the gate below is what keeps that from ever happening, and is
 * the seam a future Gemini provider would plug into.
 */
import {GOOGLE_SEARCH} from '@google/adk';
import type {BaseTool} from '@google/adk';

const GEMINI_MODEL = /^gemini-/i;

export function supportsGoogleSearch(model: string): boolean {
  return GEMINI_MODEL.test(model.trim());
}

/** The built-in grounding tools this model can actually use. */
export function groundingTools(model: string): BaseTool[] {
  return supportsGoogleSearch(model) ? [GOOGLE_SEARCH] : [];
}
