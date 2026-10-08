/**
 * Memory store tests.
 *
 * The merge logic is pure, so most of this runs without touching disk; the
 * persistence half is checked against a real temporary workspace because the
 * atomic-write and backup behaviour is the part worth proving.
 */
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  AGENT_DATA_DIR,
  DEFAULT_PROFILE_ID,
  MAX_ENTRY_CHARS,
  MAX_MEMORY_BYTES,
  MAX_PROMPT_CHARS,
  MemoryStore,
  MemoryTooLargeError,
  applyUpdate,
  applyUpdateWithReport,
  resolveAgentDataDir,
  resolveMemoryFile,
  splitMemory,
} from './memory-store.js';

describe('memory paths', () => {
  it('keeps memory in an app-owned folder inside the workspace', () => {
    expect(resolveMemoryFile('/work/project')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID, 'memory.md'),
    );
  });

  it('gives each profile its own folder', () => {
    expect(resolveAgentDataDir('/work/project', 'research')).toBe(
      join('/work/project', AGENT_DATA_DIR, 'research'),
    );
    expect(resolveMemoryFile('/work/project', 'research')).not.toBe(
      resolveMemoryFile('/work/project'),
    );
  });

  it('refuses a profile id that is not a single path segment', () => {
    expect(resolveAgentDataDir('/work/project', '../../etc')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID),
    );
    expect(resolveAgentDataDir('/work/project', '..')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID),
    );
    expect(resolveAgentDataDir('/work/project', '')).toBe(
      join('/work/project', AGENT_DATA_DIR, DEFAULT_PROFILE_ID),
    );
  });
});

describe('applyUpdate', () => {
  it('creates the section when the document is empty', () => {
    expect(
      applyUpdate('', {section: 'Preferences', content: 'Prefers pnpm'}),
    ).toBe('## Preferences\n- Prefers pnpm\n');
  });

  it('appends a bullet to an existing section', () => {
    const current = '# Marimo memory\n\n## Preferences\n- Prefers pnpm\n';
    const next = applyUpdate(current, {
      section: 'Preferences',
      content: 'Uses a dark theme',
    });
    expect(next).toBe(
      '# Marimo memory\n\n## Preferences\n- Prefers pnpm\n- Uses a dark theme\n',
    );
  });

  it('drops a duplicate bullet instead of repeating it', () => {
    const current = '## Preferences\n- Prefers pnpm\n';
    expect(
      applyUpdate(current, {section: 'Preferences', content: 'prefers pnpm'}),
    ).toBe('## Preferences\n- Prefers pnpm\n');
  });

  it('creates a section that does not exist yet, keeping the others', () => {
    const current = '# Marimo\n\n## Preferences\n- Prefers pnpm\n';
    const next = applyUpdate(current, {
      section: 'Environment',
      content: 'Node 22\n- pnpm 11',
    });
    expect(next).toBe(
      '# Marimo\n\n## Preferences\n- Prefers pnpm\n\n## Environment\n- Node 22\n- pnpm 11\n',
    );
  });

  it('replaces a section body in place', () => {
    const current = '## A\n- one\n- two\n\n## B\n- keep\n';
    const next = applyUpdate(current, {
      section: 'A',
      content: 'three',
      mode: 'replace',
    });
    expect(next).toBe('## A\n- three\n\n## B\n- keep\n');
  });

  it('matches a section heading case-insensitively', () => {
    const next = applyUpdate('## preferences\n- a\n', {
      section: 'PREFERENCES',
      content: 'b',
    });
    expect(next).toBe('## preferences\n- a\n- b\n');
  });

  it('lands an unnamed update in the default section', () => {
    expect(applyUpdate('', {content: 'remember this'})).toBe(
      '## Notes\n- remember this\n',
    );
  });

  it('splits a multi-line update into one bullet per line', () => {
    expect(applyUpdate('', {content: 'one\ntwo\n\nthree'})).toBe(
      '## Notes\n- one\n- two\n- three\n',
    );
  });

  it('caps a single bullet', () => {
    const next = applyUpdate('', {content: 'x'.repeat(MAX_ENTRY_CHARS + 50)});
    const bullet = next.split('\n')[1] ?? '';
    expect(bullet.length).toBe(MAX_ENTRY_CHARS + 2);
  });
});

describe('superseding a fact', () => {
  /*
   * The correction path. A memory holding "always use npm" beside "always use
   * pnpm" is worse than one holding neither: the next session reads both and
   * has no way to tell which is current.
   */
  it('removes the old bullet and adds the new one', () => {
    const current = '## Preferences and tone\n- Always use npm.\n- Be terse.\n';
    const report = applyUpdateWithReport(current, {
      section: 'Preferences and tone',
      content: 'Always use pnpm.',
      replaces: 'Always use npm',
    });

    expect(report.content).toBe(
      '## Preferences and tone\n- Be terse.\n- Always use pnpm.\n',
    );
    expect(report.supersede).toEqual({
      outcome: 'removed',
      removed: '- Always use npm.',
    });
  });

  it('matches a leading substring however the model phrases the spacing', () => {
    const report = applyUpdateWithReport(
      '## Notes\n- Prefers   pnpm over npm\n',
      {
        content: 'Prefers pnpm.',
        replaces: 'prefers pnpm',
      },
    );
    expect(report.supersede.outcome).toBe('removed');
    expect(report.content).toBe('## Notes\n- Prefers pnpm.\n');
  });

  it('prefers an exact match over a shorter bullet that starts the same way', () => {
    const report = applyUpdateWithReport(
      '## Notes\n- Uses pnpm.\n- Uses pnpm for scripts.\n',
      {
        content: 'Uses bun.',
        replaces: 'Uses pnpm.',
      },
    );
    expect(report.supersede.removed).toBe('- Uses pnpm.');
    expect(report.content).toBe(
      '## Notes\n- Uses pnpm for scripts.\n- Uses bun.\n',
    );
  });

  /*
   * Refusing is the safe half of a correction. A prefix short enough to hit two
   * bullets is one the model has not actually identified, and deleting a fact
   * nobody named is the same failure as leaving both versions in place.
   */
  it('removes nothing when the target is not unique, and says how many it hit', () => {
    const current =
      '## Environment and conventions\n- Runs the app with pnpm\n- Runs the tests with vitest\n';
    const report = applyUpdateWithReport(current, {
      section: 'Environment and conventions',
      content: 'Runs everything with bun.',
      replaces: 'Runs the',
    });

    expect(report.supersede).toEqual({outcome: 'ambiguous', matches: 2});
    expect(report.content).toContain('- Runs the app with pnpm');
    expect(report.content).toContain('- Runs everything with bun.');
  });

  /*
   * The failure the report exists for: a silent no-op would let the model
   * believe it corrected something it did not.
   */
  it('reports a target that matched nothing instead of ignoring it', () => {
    const current = '## Boundaries\n- Never push.\n';
    const report = applyUpdateWithReport(current, {
      section: 'Boundaries',
      content: 'Never push to main.',
      replaces: 'Always use tabs',
    });

    expect(report.supersede).toEqual({outcome: 'absent', matches: 0});
    expect(report.content).toContain('- Never push.');
    expect(report.content).toContain('- Never push to main.');
  });

  it('reports a target in a section the document does not have', () => {
    const report = applyUpdateWithReport('## Notes\n- something\n', {
      section: 'Project pointers',
      content: 'See docs/state.md.',
      replaces: 'See README.md.',
    });
    expect(report.supersede.outcome).toBe('absent');
    expect(report.content).toBe(
      '## Notes\n- something\n\n## Project pointers\n- See docs/state.md.\n',
    );
  });

  it('says nothing was asked to be replaced when replaces is blank', () => {
    const report = applyUpdateWithReport('', {
      content: 'a fact',
      replaces: '  ',
    });
    expect(report.supersede).toEqual({outcome: 'none'});
    expect(report.content).toBe('## Notes\n- a fact\n');
  });

  it('can supersede the last bullet of a section without leaving a gap', () => {
    const report = applyUpdateWithReport(
      '## Notes\n- old\n\n## Other\n- keep\n',
      {
        content: '',
        replaces: 'old',
      },
    );
    expect(report.supersede.outcome).toBe('removed');
    expect(report.content).toBe('## Other\n- keep\n');
  });

  /*
   * Only the section this call emptied goes. A blank heading the user wrote is
   * still their file, and a replace aimed at a neighbour is not a reason to
   * tidy it away behind them.
   */
  it('leaves a blank heading it did not empty alone', () => {
    const report = applyUpdateWithReport('## To fill in\n\n## Facts\n- old\n', {
      section: 'Facts',
      content: 'new',
      mode: 'replace',
    });
    expect(report.content).toBe('## To fill in\n\n## Facts\n- new\n');
  });
});

describe('splitMemory', () => {
  it('keeps the preamble separate from the sections', () => {
    const blocks = splitMemory('# Title\n\n## A\n- x\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.heading).toBeUndefined();
    expect(blocks[0]?.lines).toEqual(['# Title', '']);
    expect(blocks[1]?.heading).toBe('A');
  });
});

describe('MemoryStore', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-memory-'));
  });

  afterEach(async () => {
    await rm(workDir, {recursive: true, force: true});
  });

  it('reads an empty string before the file exists', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    expect(await store.read()).toBe('');
    expect(await store.readForPrompt()).toBe('');
  });

  it('writes and reads back, creating the profile folder', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({section: 'Preferences', content: 'Prefers pnpm'});
    expect(store.file).toBe(
      join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID, 'memory.md'),
    );
    expect(await store.read()).toContain('- Prefers pnpm');
  });

  it('keeps two profiles in separate files', async () => {
    const first = new MemoryStore({workspaceRoot: workDir});
    const second = new MemoryStore({
      workspaceRoot: workDir,
      profileId: 'research',
    });
    await first.update({content: 'one'});
    await second.update({content: 'two'});
    expect(await first.read()).toContain('one');
    expect(await first.read()).not.toContain('two');
    expect(await second.read()).toContain('two');
  });

  it('follows the workspace when it changes', async () => {
    const other = await mkdtemp(join(process.cwd(), '.marimo-memory-'));
    try {
      const store = new MemoryStore({workspaceRoot: workDir});
      await store.update({content: 'here'});
      store.setWorkspaceRoot(other);
      expect(await store.read()).toBe('');
      await store.update({content: 'there'});
      expect(await store.read()).toContain('there');
    } finally {
      await rm(other, {recursive: true, force: true});
    }
  });

  it('lets every bullet from concurrent updates land', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await Promise.all(
      Array.from({length: 8}, (_value, index) =>
        store.update({section: 'Facts', content: `fact ${index}`}),
      ),
    );
    const text = await store.read();
    for (let index = 0; index < 8; index += 1) {
      expect(text).toContain(`- fact ${index}`);
    }
  });

  it('refuses a write over the cap', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await expect(
      store.write(`- ${'x'.repeat(MAX_MEMORY_BYTES)}`),
    ).rejects.toBeInstanceOf(MemoryTooLargeError);
  });

  it('truncates an oversized file for the prompt instead of failing', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await mkdir(join(workDir, AGENT_DATA_DIR, DEFAULT_PROFILE_ID), {
      recursive: true,
    });
    await writeFile(store.file, 'x'.repeat(MAX_PROMPT_CHARS + 100), 'utf8');
    const prompt = await store.readForPrompt();
    expect(prompt).toContain('[memory.md truncated');
    expect(prompt.length).toBeLessThan(MAX_PROMPT_CHARS + 200);
  });

  it('reports an unreadable file instead of throwing into the prompt', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    // A directory where the file should be is an unreadable memory file.
    await mkdir(store.file, {recursive: true});
    expect(await store.readForPrompt()).toContain('could not be read');
  });

  it('keeps a backup when pruning', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({content: 'old fact'});
    await store.prune({content: '## Facts\n- new fact\n', reason: 'dedupe'});
    expect(await store.read()).toBe('## Facts\n- new fact\n');
    expect(await readFile(`${store.file}.bak`, 'utf8')).toContain('old fact');
  });

  it('writes the file whole, never partially', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({content: 'a'});
    await store.update({content: 'b'});
    const text = await store.read();
    expect(text).toContain('- a');
    expect(text).toContain('- b');
  });

  it('lands a correction on disk with only the new version left', async () => {
    const store = new MemoryStore({workspaceRoot: workDir});
    await store.update({
      section: 'Preferences and tone',
      content: 'Always use npm',
    });
    const report = await store.update({
      section: 'Preferences and tone',
      content: 'Always use pnpm',
      replaces: 'Always use npm',
    });

    expect(report.supersede.outcome).toBe('removed');
    const text = await store.read();
    expect(text).toContain('- Always use pnpm');
    expect(text).not.toContain('- Always use npm');
  });
});
