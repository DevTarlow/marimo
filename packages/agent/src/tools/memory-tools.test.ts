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

  /*
   * The correction path, through the tool the model actually calls. The result
   * has to say the old bullet went, because the model cannot see the file and
   * otherwise has no evidence its correction landed.
   */
  it('supersedes the bullet a correction names', async () => {
    await run(createUpdateMemoryTool({memory}), {
      section: 'Preferences and tone',
      content: 'Always use npm',
    });
    const output = await run(createUpdateMemoryTool({memory}), {
      section: 'Preferences and tone',
      content: 'Always use pnpm',
      replaces: 'Always use npm',
    });

    expect(output).toContain('Replaced');
    const text = await memory.read();
    expect(text).toContain('- Always use pnpm');
    expect(text).not.toContain('- Always use npm');
  });

  /*
   * A silent no-op is the failure worth designing against: the model would
   * report having fixed the memory while both versions sat there.
   */
  it('says when a correction matched nothing', async () => {
    await run(createUpdateMemoryTool({memory}), {
      section: 'Preferences and tone',
      content: 'Always use npm',
    });
    const output = await run(createUpdateMemoryTool({memory}), {
      section: 'Preferences and tone',
      content: 'Always use pnpm',
      replaces: 'Prefers tabs',
    });

    expect(output).toContain('no old bullet was removed');
    expect(output).toContain('read_memory');
    // And the old bullet is still there, which is what the message warns about.
    expect(await memory.read()).toContain('- Always use npm');
  });

  it('refuses an ambiguous correction and explains why', async () => {
    await run(createUpdateMemoryTool({memory}), {
      section: 'Environment and conventions',
      content: 'Runs the app with pnpm\nRuns the tests with vitest',
    });
    const output = await run(createUpdateMemoryTool({memory}), {
      section: 'Environment and conventions',
      content: 'Runs everything with bun',
      replaces: 'Runs the',
    });

    expect(output).toContain('2 bullets');
    expect(output).toContain('none was removed');
    expect(await memory.read()).toContain('- Runs the app with pnpm');
  });

  it('keeps a correction inside its own section', async () => {
    await run(createUpdateMemoryTool({memory}), {
      section: 'Boundaries',
      content: 'Never push',
    });
    await run(createUpdateMemoryTool({memory}), {
      section: 'Notes',
      content: 'Never push',
      replaces: 'Never push',
    });
    // The same words in another layer are another fact, so nothing was removed
    // from Notes for the copy in Boundaries to disappear.
    expect(await memory.read()).toBe(
      '## Boundaries\n- Never push\n\n## Notes\n- Never push\n',
    );
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
