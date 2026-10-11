/**
 * The task prefixes this model was trained with, and why they are not optional.
 *
 * EmbeddingGemma 2 is trained with a short instruction in front of the text that
 * says what kind of task the vector is for. Retrieval is an *asymmetric* task:
 * a question and the passage that answers it are not the same kind of text, and
 * the model expects a different prefix on each side. The published recipe is
 *
 *   query    task: search result | query: {the question}
 *   document title: {title} | text: {the content}
 *
 * and the one thing worth knowing about it is that **nothing enforces it**. The
 * server tokenizes whatever string it is handed, returns a perfectly good vector
 * of the right width, and the quality loss is a few points of recall that nobody
 * can see — there is no error, no warning, and no way to tell from a result list
 * that the prefixes were forgotten. So they are applied here, once, in one place,
 * and every caller that builds a string to embed goes through these two
 * functions.
 *
 * Verified against the pinned build rather than taken from the model card: the
 * same sentence with and without its prefix returns vectors at cosine 0.9057,
 * which is close enough to be plausible and far enough to matter. `title: none`
 * is what the card specifies for a document with no title, and it is used for a
 * file whose path is the only name it has.
 *
 * These are the expansions of the two prompt names the model's libraries expose,
 * `SearchQuery` for the question and `Document` for the passage, checked against
 * Google's developer guide for this model. That guide also names a `CodeRetrieval`
 * query prompt, `task: code retrieval | query: {query}`, which scores better on
 * code-only corpora and is deliberately not used here: the folder this app indexes
 * holds prose and code together, the prompt is chosen per *question* rather than
 * per document, and picking between two prompts by guessing at the question would
 * be a silent coin toss that nobody could see in a result list. The document side
 * is identical either way, so adding it later is a change to `queryText` alone and
 * touches no index.
 *
 * Media is the other half of that rule, and it lives in `client.ts` rather than
 * here: images, audio and video go in with no prefix at all.
 */
export const QUERY_PREFIX = 'task: search result | query:';

/**
 * A question, as the model wants to be asked one.
 *
 * Whitespace is collapsed and the ends trimmed before the prefix is added: a
 * query built from a file's lines carries newlines and indent, and a prefix in
 * front of a block of code is not the same input as a prefix in front of a
 * sentence — the model would be reading the shape of the text rather than the
 * question.
 */
export function queryText(query: string): string {
  const trimmed = query.trim().replaceAll(/\s+/gu, ' ');
  return `${QUERY_PREFIX} ${trimmed}`;
}

/**
 * A chunk of a document, with whatever title it has.
 *
 * The title is not decoration: the model was trained to read `title: X | text:
 * Y` pairs, and a chunk of source code with the file it came from in front of it
 * embeds differently from the same code alone. A caller with no title passes an
 * empty string and gets `title: none`, which is the recipe's own answer for it.
 */
export function documentText(title: string, content: string): string {
  const name = title.trim().replaceAll(/\s+/gu, ' ');
  return `title: ${name.length === 0 ? 'none' : name} | text: ${content}`;
}
