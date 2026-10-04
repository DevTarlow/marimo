/**
 * Memory tool tests, driven through the same `runAsync` path ADK uses.
 */
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';

import type {BaseTool, Context} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {MemoryStore} from '../memory/index.js';
import {
  createPruneMemoryTool,
  createReadMemoryTool,
  createUpdateMemoryTool,
} from './memory-tools.js';

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

describe('memory tools', () => {
  let workDir: string;
  let memory: MemoryStore;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-memtools-'));
    memory = new MemoryStore({workspaceRoot: workDir});
  });

  afterEach(async () => {
    await rm(workDir, {recursive: true, force: true});
  });

  it('says the memory is empty before anything is written', async () => {
    const output = await run(createReadMemoryTool({memory}), {});
    expect(output).toContain('memory.md is empty');
    expect(output).toContain(memory.file);
  });

  it('reads back what was written', async () => {
    await run(createUpdateMemoryTool({memory}), {
      section: 'Preferences',
      content: 'Prefers pnpm',
    });
    const output = await run(createReadMemoryTool({memory}), {});
    expect(output).toContain('- Prefers pnpm');
    expect(output).toContain('## Preferences');
  });

  it('writes a fact into the named section', async () => {
    const output = await run(createUpdateMemoryTool({memory}), {
      section: 'Project facts',
      content: 'Node 22',
    });
    expect(output).toContain('Updated');
    expect(await memory.read()).toBe('## Project facts\n- Node 22\n');
  });

  it('replaces a section when asked', async () => {
    await run(createUpdateMemoryTool({memory}), {
      section: 'Facts',
      content: 'old',
    });
    await run(createUpdateMemoryTool({memory}), {
      section: 'Facts',
      content: 'new',
      mode: 'replace',
    });
    expect(await memory.read()).toBe('## Facts\n- new\n');
  });

  it('prunes the document and keeps a backup', async () => {
    await run(createUpdateMemoryTool({memory}), {content: 'first'});
    const output = await run(createPruneMemoryTool({memory}), {
      content: '## Facts\n- first\n',
      reason: 'dedupe',
    });
    expect(output).toContain('Pruned');
    expect(output).toContain('dedupe');
    expect(await readFile(memory.file, 'utf8')).toBe('## Facts\n- first\n');
    expect(await readFile(`${memory.file}.bak`, 'utf8')).toContain('- first');
  });

  it('reports an oversized rewrite instead of throwing', async () => {
    const output = await run(createPruneMemoryTool({memory}), {
      content: 'x'.repeat(70 * 1024),
    });
    expect(output).toContain('Could not prune memory.md');
    expect(output).toContain('cap');
  });

  it('reports an unwritable location instead of throwing', async () => {
    // A directory where the memory file belongs cannot be read or written.
    await mkdir(memory.file, {recursive: true});
    const readOutput = await run(createReadMemoryTool({memory}), {});
    expect(readOutput).toContain('Could not read memory.md');
    const writeOutput = await run(createUpdateMemoryTool({memory}), {
      content: 'x',
    });
    expect(writeOutput).toContain('Could not update memory.md');
  });
});
