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
 * These are the expansions of the prompt names the model's libraries expose:
 * `SearchQuery` for the question, `Document` for the passage, and `CodeRetrieval`
 * for the question again when the folder is mostly code. Checked against Google's
 * developer guide for this model.
 *
 * Which query prompt is used is the user's setting rather than a guess made per
 * question, because there is nothing in a question to guess from: "why does the
 * upload keep failing" wants the same words whether the answer is in a comment or
 * a function. The document side is identical for both, so choosing differently
 * changes which questions are asked how and never touches an index.
 *
 * Media is the other half of that rule, and it lives in `client.ts` rather than
 * here: images, audio and video go in with no prefix at all.
 */
export const QUERY_PREFIX = 'task: search result | query:';

/**
 * The other query prompt, for a folder that is mostly code.
 *
 * The model's guide names this one `CodeRetrieval` and it scores better on code
 * corpora. Only the *query* side differs: both recipes put `title: … | text: …` on
 * the passage, so an index built under one prompt is searchable under the other
 * and switching costs nothing but the questions.
 */
export const CODE_QUERY_PREFIX = 'task: code retrieval | query:';

/** Which of the two a query is asked with. */
export type QueryKind = 'search' | 'code';

/**
 * A question, as the model wants to be asked one.
 *
 * Whitespace is collapsed and the ends trimmed before the prefix is added: a
 * query built from a file's lines carries newlines and indent, and a prefix in
 * front of a block of code is not the same input as a prefix in front of a
 * sentence — the model would be reading the shape of the text rather than the
 * question.
 */
export function queryText(query: string, kind: QueryKind = 'search'): string {
  const trimmed = query.trim().replaceAll(/\s+/gu, ' ');
  const prefix = kind === 'code' ? CODE_QUERY_PREFIX : QUERY_PREFIX;
  return `${prefix} ${trimmed}`;
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
