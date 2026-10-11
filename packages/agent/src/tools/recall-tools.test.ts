/**
 * The recall tool, driven through the same `runAsync` path ADK uses.
 *
 * What is asserted here is mostly about what the model is *told*, because the
 * failure this tool can have is not a crash: it is a result list that reads as
 * complete. A search that found four things out of forty, or skipped the folder
 * because only memory was indexed, is a model that answers confidently from a
 * sample — and nothing about the answer looks wrong.
 */
import type {BaseTool, Context} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {RECALL_SCOPES, createRecallTool} from './recall-tools.js';
import type {RecallAnswer, RecallLookup, RecallRequest} from './recall-tools.js';

async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({
    args,
    toolContext: undefined as unknown as Context,
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/** A stand-in service that records what it was asked and answers with what it was given. */
function fakeLookup(options: {
  scopes?: readonly ('folder' | 'memory')[];
  answer?: Partial<RecallAnswer>;
  failure?: Error;
} = {}): {lookup: RecallLookup; asked: RecallRequest[]} {
  const asked: RecallRequest[] = [];
  return {
    asked,
    lookup: {
      scopes: () => options.scopes ?? ['folder', 'memory'],
      search: async (request) => {
        asked.push(request);
        if (options.failure !== undefined) {
          throw options.failure;
        }
        return {
          hits: [],
          searched: ['folder', 'memory'],
          notes: [],
          ...options.answer,
        };
      },
    },
  };
}

describe('createRecallTool', () => {
  /*
   * A capability with no corpus behind it is a promise the model would make and
   * break, which is the rule every conditional tool in this package follows. The
   * app decides by supplying a service; a service that has nothing indexed
   * answers with no scopes, and gets no tool.
   */
  it('is not built at all when there is nothing to search', () => {
    expect(createRecallTool({recall: fakeLookup({scopes: []}).lookup})).toBeUndefined();
  });

  it('is built when any corpus exists', () => {
    expect(
      createRecallTool({recall: fakeLookup({scopes: ['memory']}).lookup}),
    ).toBeDefined();
  });

  /*
   * The scope enum comes from the service, so the model cannot ask for a corpus
   * this install does not have — the failure being a tool call that returns
   * "nothing found" about a folder full of the answer.
   */
  it('offers only the scopes the service has', () => {
    const tool = createRecallTool({recall: fakeLookup({scopes: ['memory']}).lookup});
    /*
     * The declaration rather than the zod schema, because the declaration is what
     * the provider is handed and the model actually sees — and the schema is
     * private, which is the library telling a caller to check the contract.
     */
    const declaration = JSON.stringify(tool?._getDeclaration());

    expect(declaration).toContain('memory');
    expect(declaration).not.toContain('folder');
  });

  it('passes the question through and forwards an explicit scope', async () => {
    const {lookup, asked} = fakeLookup();
    await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'why does the upload keep failing',
      scope: 'memory',
      limit: 4,
    });

    expect(asked[0]).toEqual({
      query: 'why does the upload keep failing',
      scopes: ['memory'],
      limit: 4,
    });
  });

  it('names the file, the lines and the score for a folder hit', async () => {
    const {lookup} = fakeLookup({
      answer: {
        hits: [
          {
            kind: 'text',
            path: 'src/net/retry.ts',
            startLine: 41,
            endLine: 58,
            preview: 'export function withRetry() {',
            score: 0.7923,
            text: 'export function withRetry(fn, opts) {\n  return fn();\n}',
            stale: false,
          },
        ],
      },
    });

    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'retry',
    });

    expect(output).toContain('src/net/retry.ts:41-58');
    expect(output).toContain('(0.79)');
    expect(output).toContain('  export function withRetry(fn, opts) {');
    expect(output).toContain('1 result for "retry"');
  });

  /* A memory bullet has no lines: what locates it is the section it lives in. */
  it('names the memory section for a memory hit', async () => {
    const {lookup} = fakeLookup({
      answer: {
        hits: [
          {
            kind: 'memory',
            path: '',
            section: 'Preferences and tone',
            preview: 'prefers tabs',
            score: 0.66,
            text: 'the user prefers tabs over spaces',
            stale: false,
          },
        ],
      },
    });

    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'what does the user prefer',
    });

    expect(output).toContain('memory "Preferences and tone"');
    expect(output).toContain('the user prefers tabs over spaces');
  });

  /*
   * The one case where a hit must not carry text. Quoting a copy of a file that
   * has since changed is a wrong answer stated confidently, and the model can
   * read the file itself in one call — so it is told to.
   */
  it('sends the model to read a hit that has changed', async () => {
    const {lookup} = fakeLookup({
      answer: {
        hits: [
          {
            kind: 'text',
            path: 'src/retry.ts',
            startLine: 1,
            endLine: 3,
            preview: 'export function withRetry() {',
            score: 0.5,
            text: '',
            stale: true,
          },
        ],
      },
    });

    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'retry',
    });

    expect(output).toContain('changed since it was indexed');
    expect(output).toContain('read_file');
    expect(output).not.toContain('export function withRetry() {\n');
  });

  it('says how much was not searched, when there was somewhere else to look', async () => {
    const {lookup} = fakeLookup({
      scopes: ['folder', 'memory'],
      answer: {searched: ['folder'], hits: []},
    });

    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'retry',
      scope: 'folder',
    });

    expect(output).toContain('only the folder was searched');
  });

  /*
   * With one corpus there is nowhere else to look, and a note saying so would
   * send the model after a folder this install does not have.
   */
  it('does not mention another corpus when there is only one', async () => {
    const {lookup} = fakeLookup({
      scopes: ['memory'],
      answer: {searched: ['memory'], hits: []},
    });

    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'retry',
    });

    expect(output).not.toContain('only memory was searched');
  });

  it('passes the service’s own notes through, beside its own', async () => {
    const {lookup} = fakeLookup({
      answer: {
        notes: ['The folder is large enough that indexing happens in slices, and 40 file(s) are not indexed yet.'],
        hits: [
          {
            kind: 'text',
            path: 'a.ts',
            startLine: 1,
            endLine: 1,
            preview: 'const a = 1;',
            score: 0.4,
            text: 'const a = 1;',
            stale: false,
          },
        ],
      },
    });

    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'a',
    });

    expect(output).toContain('not indexed yet');
    expect(output).toContain('[');
  });

  it('says nothing was found rather than answering with an empty list', async () => {
    const {lookup} = fakeLookup();
    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'nothing matches this',
    });

    expect(output).toContain('Nothing found for "nothing matches this"');
  });

  /*
   * A failed recall is a sentence rather than a thrown turn: the model can fall
   * back to the literal search or read the file it already suspects, and either
   * beats a turn that ended with a stack trace.
   */
  it('turns a failure into something the model can react to', async () => {
    const {lookup} = fakeLookup({failure: new Error('the recall model is not running')});
    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'retry',
    });

    expect(output).toContain('Recall failed: the recall model is not running');
  });

  /*
   * The size cap, and the sentence that stops it being a lie. A long hit must not
   * be able to fill the answer and leave later hits implied but absent.
   */
  it('cuts a long answer at its cap and says so', async () => {
    const long = 'x'.repeat(3_000);
    const {lookup} = fakeLookup({
      answer: {
        /*
         * Ten, not six: each hit is itself capped at 1,200 characters, so it takes
         * more than a handful to reach the answer's own cap — which is the point of
         * having both, and why this is the number a reader would have to work out.
         */
        hits: Array.from({length: 10}, (_, index) => ({
          kind: 'text' as const,
          path: `file${String(index)}.ts`,
          startLine: 1,
          endLine: 2,
          preview: 'x',
          score: 0.5,
          text: long,
          stale: false,
        })),
      },
    });

    const output = await run(createRecallTool({recall: lookup}) as BaseTool, {
      query: 'x',
    });

    expect(output.length).toBeLessThan(9_000);
    expect(output).toContain('cut at its size cap');
  });

  it('describes itself as meaning-based, and names its sibling', () => {
    const tool = createRecallTool({recall: fakeLookup().lookup});
    expect(tool?.description).toContain('mean');
    expect(tool?.description).toContain('search_knowledge_base');
  });

  it('names its scopes in the order the service declares them', () => {
    expect(RECALL_SCOPES).toEqual(['folder', 'memory', 'conversation', 'media']);
  });
});
