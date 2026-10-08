/**
 * Memory tool tests, driven through the same `runAsync` path ADK uses.
 */
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {BaseTool, Context} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {MEMORY_SOFT_LIMIT_BYTES, MemoryStore} from '../memory/index.js';
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

  /*
   * A file of an exact byte size, written where the store will read it. The
   * tools count bytes off the real file, so the fixture has to be a real one
   * rather than a string handed to a pure function.
   */
  async function writeMemoryOfBytes(bytes: number): Promise<void> {
    await mkdir(join(workDir, '.marimo', 'default'), {recursive: true});
    await writeFile(
      memory.file,
      `${'- '.padEnd(bytes, 'x')}\n`.slice(0, bytes),
    );
  }

  describe('the soft size limit', () => {
    it('says nothing about a small memory on read', async () => {
      await run(createUpdateMemoryTool({memory}), {content: 'one small fact'});
      const output = await run(createReadMemoryTool({memory}), {});
      expect(output).not.toContain('soft limit');
      expect(output).not.toContain('prune_memory');
    });

    it('says nothing exactly at the limit, and warns one byte over', async () => {
      await writeMemoryOfBytes(MEMORY_SOFT_LIMIT_BYTES);
      const atLimit = await run(createReadMemoryTool({memory}), {});
      expect(atLimit).toContain(`${MEMORY_SOFT_LIMIT_BYTES} bytes`);
      expect(atLimit).not.toContain('soft limit');

      await writeMemoryOfBytes(MEMORY_SOFT_LIMIT_BYTES + 1);
      const overLimit = await run(createReadMemoryTool({memory}), {});
      expect(overLimit).toContain('soft limit');
      expect(overLimit).toContain('prune_memory');
    });

    /*
     * The setting the user moves in the dialog is what these tools warn at. This
     * is the test that stops that being a number the window draws and the agent
     * never uses: the same file is under the raised limit and over the default.
     */
    it('warns at the limit the store was moved to', async () => {
      await writeMemoryOfBytes(MEMORY_SOFT_LIMIT_BYTES + 1);
      expect(await run(createReadMemoryTool({memory}), {})).toContain(
        'soft limit',
      );

      const moved = MEMORY_SOFT_LIMIT_BYTES * 2;
      memory.setSoftLimitBytes(moved);
      const raised = await run(createReadMemoryTool({memory}), {});
      expect(raised).not.toContain('soft limit');

      memory.setSoftLimitBytes(moved / 2);
      const lowered = await run(createUpdateMemoryTool({memory}), {
        content: 'one more fact',
      });
      expect(lowered).toContain('soft limit');
      expect(lowered).toContain(String(moved / 2));
    });

    it('can be built with a limit rather than moved to one', async () => {
      await writeMemoryOfBytes(MEMORY_SOFT_LIMIT_BYTES + 1);
      const roomy = new MemoryStore({
        workspaceRoot: workDir,
        softLimitBytes: MEMORY_SOFT_LIMIT_BYTES * 4,
      });
      expect(
        await run(createReadMemoryTool({memory: roomy}), {}),
      ).not.toContain('soft limit');
    });

    it('warns on a write once it crosses the line', async () => {
      const under = await run(createUpdateMemoryTool({memory}), {
        content: 'x'.repeat(100),
      });
      expect(under).not.toContain('soft limit');

      /*
       * Distinct lines, because a single bullet is capped at MAX_ENTRY_CHARS and
       * a repeated one is dropped as a duplicate — neither would reach the
       * limit this test is about.
       */
      const over = await run(createUpdateMemoryTool({memory}), {
        content: Array.from(
          {length: 5},
          (_value, index) => `y${String(index)}${'y'.repeat(1_900)}`,
        ).join('\n'),
      });
      expect(over).toContain('soft limit');
      expect(over).toContain('prune_memory');
      // The write still happened: the warning is a cue, not a refusal.
      expect(await memory.read()).toContain('- y0yyy');
    });

    it('stops warning after a prune brings the file back under', async () => {
      await writeMemoryOfBytes(MEMORY_SOFT_LIMIT_BYTES * 2);
      expect(await run(createReadMemoryTool({memory}), {})).toContain(
        'soft limit',
      );

      await run(createPruneMemoryTool({memory}), {
        content: '- one fact\n',
        reason: 'too big',
      });
      const after = await run(createReadMemoryTool({memory}), {});
      expect(after).not.toContain('soft limit');
    });
  });
});
