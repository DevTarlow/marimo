/**
 * `recall`: find things by what they mean, across the folder and memory.
 *
 * The sibling of `search_knowledge_base`, and the difference is the question the
 * model is holding. That one takes a literal string and answers "where does this
 * appear"; this one takes a description and answers "what is about this" — which
 * is the only kind of question that works when the caller does not know the words
 * the answer uses. The two are offered together on purpose: a model that knows the
 * identifier should search for it, and one that knows only what it wants should
 * recall it.
 *
 * What this file is careful about is *honesty of coverage*. A recall that finds
 * four things when the folder holds forty is not a failure, but a model that reads
 * it as "the folder holds four things" is. So every answer carries what was
 * searched, how much was not, and whether the index is behind — in the same
 * register as `[stopped at the result cap]`, which exists for the same reason.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

/** The corpora recall can search. The literals are the contract. */
export const RECALL_SCOPES = ['folder', 'memory'] as const;
export type RecallScope = (typeof RECALL_SCOPES)[number];

/**
 * One thing that was found.
 *
 * `text` is the source's own text as of the read that verified it, so a hit can
 * be quoted without a second tool call. `stale` says the opposite: the file has
 * changed since it was indexed, the text is deliberately empty, and the model is
 * told to go and read it rather than being handed something that is no longer
 * there.
 */
export interface RecallHit {
  kind: 'text' | 'memory';
  /** Relative to the folder being searched; `''` for a memory bullet. */
  path: string;
  startLine?: number;
  endLine?: number;
  /** For a memory bullet, the section it lives under. */
  section?: string;
  /** One line of the text, for a list that has to be readable. */
  preview: string;
  /** Cosine similarity, higher is nearer. Not comparable across modalities. */
  score: number;
  text: string;
  stale: boolean;
}

export interface RecallAnswer {
  hits: RecallHit[];
  /** What was actually searched, which may be less than what was asked for. */
  searched: readonly string[];
  /** Sentences the model should see: a cap reached, a file unreadable, a stale index. */
  notes: readonly string[];
}

export interface RecallRequest {
  query: string;
  scopes?: readonly RecallScope[];
  limit?: number;
}

/**
 * What the tool needs from whatever can answer a recall.
 *
 * An interface rather than the implementation, for the reason every other
 * service here is one: `@marimo/agent` must not import a package that spawns
 * processes, and the app that owns the engine supplies this on the way in.
 */
export interface RecallLookup {
  /** The corpora available right now — absent ones are not offered to the model. */
  scopes(): readonly RecallScope[];
  search(request: RecallRequest): Promise<RecallAnswer>;
}

export interface RecallToolContext {
  recall: RecallLookup;
}

/** How many hits the model gets when it does not say. */
const DEFAULT_HITS = 8;
/** The most it can ask for, matching what the service will do. */
const MAX_HITS = 12;
/** The whole answer is capped: a result list is not a file read. */
const MAX_OUTPUT_CHARS = 8 * 1024;
/** How much of one hit's text is shown, so one long chunk cannot fill the answer. */
const MAX_HIT_CHARS = 1_200;

/**
 * The tool, or `undefined` when there is nothing to search.
 *
 * `undefined` rather than a tool that answers "nothing available": a capability
 * with no corpus behind it is a promise the model would make and break, which is
 * the rule every conditional tool in this package follows. The scope enum is built
 * from what exists, so a model cannot ask for a corpus the service would refuse.
 */
export function createRecallTool(context: RecallToolContext) {
  const available = context.recall.scopes();
  if (available.length === 0) {
    return undefined;
  }
  const scopes = RECALL_SCOPES.filter((scope) => available.includes(scope));

  return new FunctionTool({
    name: 'recall',
    description:
      'Find things by what they mean rather than by matching words: files in ' +
      'the workspace, and your own long-term memory. Use it when you know what ' +
      'you are looking for but not the words the answer uses, or when a question ' +
      'is about something the user told you earlier. Unlike search_knowledge_base ' +
      'this matches on meaning, so it can find a passage about retries from the ' +
      'question "why does the upload keep failing". Results carry their own text; ' +
      'a result marked as changed has to be read with read_file instead.',
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          'What you are looking for, as a question or a description. A sentence ' +
            'works; an identifier works less well here than in search_knowledge_base.',
        ),
      scope: z
        /*
         * The cast is the price of a dynamic enum: zod wants a tuple type and the
         * tuple depends on what this install has indexed, which is the point —
         * a model must not be able to ask for a corpus the service would answer
         * "nothing" about.
         */
        .enum(scopes as unknown as [string, ...string[]])
        .optional()
        .describe(
          `Where to look: ${scopes
            .map((scope) => `"${scope}"`)
            .join(' or ')}. Omit to search everything available.`,
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_HITS)
        .optional()
        .describe(`How many results. Defaults to ${DEFAULT_HITS}.`),
    }),
    execute: async ({query, scope, limit}) => {
      let answer: RecallAnswer;
      try {
        answer = await context.recall.search({
          query,
          ...(scope === undefined ? {} : {scopes: [scope as RecallScope]}),
          ...(limit === undefined ? {} : {limit}),
        });
      } catch (error) {
        /*
         * A failed recall is text rather than a thrown turn: the model can try
         * the literal search, or read the file it already suspects, and a tool
         * that ends the turn is a worse answer than one that says what happened.
         */
        return `Recall failed: ${describeError(error)}`;
      }

      return render(query, answer, scopes);
    },
  });
}

/**
 * The answer, as the model reads it.
 *
 * The shape is the one `search_knowledge_base` established — a header that counts,
 * then `path:lines` — with two additions that exist because a hit carries its
 * text: a score, and a memory hit's section instead of a line range. Scores are
 * printed because a model that can see 0.79 beside 0.31 knows how much to trust
 * the list; they are *not* a threshold, because the right floor is not a number
 * anybody can pick for every question.
 */
function render(
  query: string,
  answer: RecallAnswer,
  scopes: readonly RecallScope[],
): string {
  const where =
    answer.searched.length > 0
      ? ` in ${answer.searched.join(' and ')}`
      : '';
  /*
   * The notes are built before the two ways out, because the empty one needs them
   * most. "Nothing found for X in the folder" on a question about the user, when
   * memory was never searched, is a model concluding that the user has no
   * preference recorded — and a note is the only thing that says otherwise.
   */
  const notes = [...answer.notes];
  if (answer.searched.length === 1 && scopes.length > 1) {
    notes.push(
      `only ${answer.searched[0] === 'folder' ? 'the folder' : 'memory'} was searched`,
    );
  }

  if (answer.hits.length === 0) {
    const suffix = notes.length > 0 ? `\n[${notes.join('; ')}]` : '';
    return `Nothing found for "${query}"${where}.${suffix}`;
  }

  const lines: string[] = [];
  let length = 0;
  let shown = 0;
  let cut = false;

  for (const hit of answer.hits) {
    const where =
      hit.kind === 'memory'
        ? `memory "${hit.section ?? ''}"`
        : `${hit.path}:${String(hit.startLine ?? 1)}-${String(hit.endLine ?? 1)}`;
    const head = `${where} (${hit.score.toFixed(2)})`;
    const body = hit.stale
      ? '  [changed since it was indexed — read it with read_file to see the current text]'
      : indent(hit.text.slice(0, MAX_HIT_CHARS));
    const block = `${head}\n${body}`;

    if (length + block.length > MAX_OUTPUT_CHARS) {
      cut = true;
      break;
    }
    lines.push(block);
    length += block.length + 1;
    shown += 1;
  }

  const count = `${String(answer.hits.length)} result${
    answer.hits.length === 1 ? '' : 's'
  }`;
  const header = `${count} for "${query}"${where}`;
  if (cut || shown < answer.hits.length) {
    notes.push('the answer was cut at its size cap; narrow the question for the rest');
  }
  const suffix = notes.length > 0 ? `\n[${notes.join('; ')}]` : '';
  return `${header}\n\n${lines.join('\n\n')}${suffix}`;
}

/** Every line of a hit, indented so the header stands out from its text. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
