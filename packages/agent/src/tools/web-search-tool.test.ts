import type {BaseTool, Context} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  createWebSearchTool,
  type WebSearchProvider,
  type WebSearchResult,
} from './web-search-tool.js';

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

function providerReturning(results: WebSearchResult[]): {
  provider: WebSearchProvider;
  calls: Array<{query: string; limit: number}>;
} {
  const calls: Array<{query: string; limit: number}> = [];
  return {
    calls,
    provider: {
      search: async (request) => {
        calls.push({query: request.query, limit: request.limit});
        return results;
      },
    },
  };
}

describe('web_search', () => {
  it('formats results with their URLs', async () => {
    const {provider} = providerReturning([
      {
        title: 'Marimo Bot docs',
        url: 'https://example.com/a',
        snippet: 'About marimo',
      },
      {title: 'Second', url: 'https://example.com/b', snippet: ''},
    ]);
    const output = await run(createWebSearchTool({provider}), {
      query: 'marimo',
    });
    expect(output).toContain('2 web results for "marimo"');
    expect(output).toContain('1. Marimo Bot docs');
    expect(output).toContain('https://example.com/a');
    expect(output).toContain('About marimo');
    expect(output).toContain('2. Second');
  });

  it('asks the provider for the requested number of results', async () => {
    const {provider, calls} = providerReturning([]);
    await run(createWebSearchTool({provider}), {query: 'x', maxResults: 3});
    expect(calls).toEqual([{query: 'x', limit: 3}]);
  });

  it('defaults to five results', async () => {
    const {provider, calls} = providerReturning([]);
    await run(createWebSearchTool({provider}), {query: 'x'});
    expect(calls[0]?.limit).toBe(5);
  });

  it('says so when there are no results', async () => {
    const {provider} = providerReturning([]);
    expect(await run(createWebSearchTool({provider}), {query: 'x'})).toContain(
      'No web results',
    );
  });

  it('reports a provider failure as text', async () => {
    const provider: WebSearchProvider = {
      search: async () => {
        throw new Error('engine unreachable');
      },
    };
    const output = await run(createWebSearchTool({provider}), {query: 'x'});
    expect(output).toBe('Web search failed: engine unreachable');
  });

  /*
   * Cut *and marked*. The old version of this test asserted only that the long
   * text was gone, which the silent cut satisfied — so it went on passing while
   * a snippet that stopped mid-sentence was handed to the model as though it
   * had ended there. Invariant 7 is that truncation is visible, and this is the
   * assertion that says so.
   */
  it('cuts a long snippet and says that it did', async () => {
    const {provider} = providerReturning([
      {title: 't', url: 'https://example.com', snippet: 'y'.repeat(900)},
    ]);
    const output = await run(createWebSearchTool({provider}), {query: 'x'});

    expect(output).not.toContain('y'.repeat(400));
    expect(output).toContain('[snippet cut]');
  });

  it('leaves a snippet that fits alone', async () => {
    const {provider} = providerReturning([
      {title: 't', url: 'https://example.com', snippet: 'a short one'},
    ]);
    const output = await run(createWebSearchTool({provider}), {query: 'x'});

    expect(output).toContain('a short one');
    expect(output).not.toContain('[snippet cut]');
  });
});
