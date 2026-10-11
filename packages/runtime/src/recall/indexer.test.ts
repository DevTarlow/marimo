/**
 * Building an index, and keeping it up to date without rebuilding it.
 *
 * The engine is faked, and deliberately: the fake counts what it was *asked* to
 * embed, which is where all the interesting behaviour is. An incremental refresh
 * that quietly re-embeds the whole folder is a folder that gets slower the more
 * of it you have indexed, and it looks exactly like one that does not. So the
 * assertions are mostly about the calls that did not happen.
 *
 * Files are real, in a temporary directory, because everything about deciding
 * what changed is a fact about the filesystem: stamps, sizes, and the walk.
 */
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {memoryBullets, refreshIndex} from './indexer.js';
import {readIndex} from './store.js';
import type {IndexModel} from './store.js';

const MODEL: IndexModel = {repo: 'unsloth/embeddinggemma-2-GGUF', revision: 'rev2', dims: 8};

/** Words the fake embedder knows, so a query can find a chunk. */
const VOCABULARY = ['retry', 'upload', 'cookie', 'bake', 'memory', 'tabs', 'oven', 'user'];

/**
 * A deterministic stand-in for the model.
 *
 * A bag of words over a fixed vocabulary, which is enough to make ranking
 * meaningful — a chunk about retries really is nearer a question about retries
 * than one about baking — and enough to see what was asked for.
 */
function fakeEmbedder(): {
  embed: (texts: readonly string[]) => Promise<{vectors: Float32Array[]}>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    embed: async (texts) => {
      calls.push([...texts]);
      return {
        vectors: texts.map((text) => {
          const vector = new Float32Array(VOCABULARY.length);
          for (const [index, word] of VOCABULARY.entries()) {
            if (text.toLowerCase().includes(word)) {
              vector[index] += 1;
            }
          }
          if (vector.every((value) => value === 0)) {
            // Something rather than nothing, so the vector is usable and does not
            // pretend to mean anything.
            vector[0] = 0.01;
          }
          return vector;
        }),
      };
    },
  };
}

describe('refreshIndex', () => {
  let workspace: string;
  let indexDir: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(process.cwd(), '.marimo-recall-ws-'));
    indexDir = await mkdtemp(join(process.cwd(), '.marimo-recall-idx-'));
  });

  afterEach(async () => {
    await rm(workspace, {recursive: true, force: true});
    await rm(indexDir, {recursive: true, force: true});
  });

  async function write(path: string, text: string): Promise<void> {
    const absolute = join(workspace, path);
    await mkdir(join(absolute, '..'), {recursive: true});
    await writeFile(absolute, text, 'utf8');
  }

  function refresh(
    embedder: ReturnType<typeof fakeEmbedder>,
    options: {memory?: string; maxFiles?: number} = {},
  ) {
    return refreshIndex({
      workspaceRoot: workspace,
      dir: indexDir,
      model: MODEL,
      embed: embedder.embed,
      memory: options.memory ?? '',
      ...(options.maxFiles === undefined ? {} : {maxFiles: options.maxFiles}),
    });
  }

  it('indexes the folder and the memory file into one space', async () => {
    await write('src/retry.ts', 'export function withRetry() {}\n// three attempts');
    await write('README.md', 'how to upload a file');
    const embedder = fakeEmbedder();

    const {data, coverage} = await refresh(embedder, {
      memory: '## Project pointers\n- the retry code lives in src/retry.ts\n',
    });

    expect(coverage.embedded).toBe(2);
    const paths = data.file.records.map((record) =>
      record.kind === 'memory' ? `memory:${record.section ?? ''}` : record.path,
    );
    expect(paths).toContain('src/retry.ts');
    expect(paths).toContain('README.md');
    expect(paths).toContain('memory:Project pointers');

    const chunk = data.file.records.find((record) => record.path === 'src/retry.ts');
    expect(chunk?.startLine).toBe(1);
    expect(chunk?.endLine).toBe(2);
    expect(chunk?.preview).toContain('withRetry');
    // The file name travels with the text, which is what the model was trained on.
    expect(embedder.calls.flat().join('\n')).toContain('title: src/retry.ts | text:');
  });

  /*
   * The whole point of the stamps. A refresh on a folder that has not changed
   * must cost *nothing* — no reads, no vectors — or every search pays for the
   * whole folder.
   */
  it('embeds nothing at all the second time', async () => {
    await write('a.ts', 'const retry = 1;');
    const first = fakeEmbedder();
    await refresh(first, {memory: '## Notes\n- the user prefers tabs\n'});
    expect(first.calls.length).toBeGreaterThan(0);

    const second = fakeEmbedder();
    const {coverage} = await refresh(second, {memory: '## Notes\n- the user prefers tabs\n'});

    expect(second.calls).toEqual([]);
    expect(coverage.embedded).toBe(0);
  });

  it('re-embeds only the file that changed', async () => {
    await write('a.ts', 'const retry = 1;');
    await write('b.ts', 'const bake = 1;');
    await refresh(fakeEmbedder());
    // A sleep is what makes the modification time different: it is the stamp that
    // decides, and a filesystem with one-second granularity would otherwise say
    // nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 12));
    await write('a.ts', 'const retry = 2;');

    const embedder = fakeEmbedder();
    const {coverage} = await refresh(embedder);

    expect(coverage.embedded).toBe(1);
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]?.join('\n')).toContain('title: a.ts | text:');
    expect(embedder.calls[0]?.join('\n')).not.toContain('b.ts');
  });

  it('drops the records of a file that is gone', async () => {
    await write('a.ts', 'const retry = 1;');
    await write('b.ts', 'const bake = 1;');
    await refresh(fakeEmbedder());

    await rm(join(workspace, 'b.ts'));
    const {data} = await refresh(fakeEmbedder());

    expect(data.file.records.map((record) => record.path)).not.toContain('b.ts');
    expect(data.file.files.map((file) => file.path)).not.toContain('b.ts');
  });

  /*
   * The budget, and the honesty about it. A refresh that quietly stopped at the
   * first hundred files would report a complete index over a folder it had read a
   * tenth of — and the next search would answer as though the rest did not exist.
   */
  it('stops at the budget, says so, and finishes next time', async () => {
    await write('a.ts', 'const retry = 1;');
    await write('b.ts', 'const bake = 1;');

    const first = await refresh(fakeEmbedder(), {maxFiles: 1});
    expect(first.coverage.embedded).toBe(1);
    expect(first.coverage.pending).toBe(1);
    expect(first.coverage.truncated).toBe(true);

    const second = await refresh(fakeEmbedder());
    expect(second.coverage.embedded).toBe(1);
    expect(second.coverage.pending).toBe(0);
    expect(second.coverage.truncated).toBe(false);
    expect(second.data.file.files).toHaveLength(2);
  });

  it('skips a file that is not text, and remembers that it did', async () => {
    await write('binary.bin', 'header\u0000\u0000more');
    await write('a.ts', 'const retry = 1;');

    const {data, coverage} = await refresh(fakeEmbedder());

    expect(data.file.records.map((record) => record.path)).not.toContain('binary.bin');
    expect(coverage.skipped).toBe(1);
    // Recorded with a stamp and no records, so the next refresh does not try it
    // again — and the file's presence does not read as a change forever.
    expect(data.file.files.map((file) => file.path)).toContain('binary.bin');
  });

  it('never walks into the folders the search skips', async () => {
    await write('node_modules/pkg/index.js', 'const retry = 1;');
    await write('.marimo/default/memory.md', '## Notes\n- the user prefers tabs');
    await write('.git/config', 'const bake = 1;');
    await write('src/a.ts', 'const retry = 1;');

    const {data} = await refresh(fakeEmbedder());

    expect(data.file.records.map((record) => record.path)).toEqual(['src/a.ts']);
  });

  it('re-embeds memory when the file changes, and only then', async () => {
    await write('a.ts', 'const retry = 1;');
    await refresh(fakeEmbedder(), {memory: '## Notes\n- the user prefers tabs\n'});

    const same = fakeEmbedder();
    await refresh(same, {memory: '## Notes\n- the user prefers tabs\n'});
    expect(same.calls).toEqual([]);

    const changed = fakeEmbedder();
    const {coverage} = await refresh(changed, {
      memory: '## Notes\n- the user prefers tabs\n- the user bakes bread\n',
    });

    expect(coverage.memory).toBe(2);
    expect(changed.calls).toHaveLength(1);
  });

  /*
   * A short answer from the engine would attach every later chunk's text to
   * another chunk's numbers if it were stored, so the file is left as it was: out
   * of date and honest about it, rather than current and wrong.
   */
  it('refuses a file whose vectors do not all come back', async () => {
    // Long enough to be cut into more than one chunk: with a single chunk a short
    // answer would be *right*, and the test would pass for the wrong reason.
    await write(
      'a.ts',
      Array.from({length: 200}, (_, i) => `const retry${String(i)} = bake(${String(i)});`).join('\n'),
    );
    const partial = {
      calls: [] as string[][],
      embed: async (texts: readonly string[]) => {
        partial.calls.push([...texts]);
        return {vectors: texts.slice(0, 1).map(() => new Float32Array(8).fill(1))};
      },
    };

    const {data, coverage} = await refresh(partial);

    expect(coverage.skipped).toBe(1);
    expect(data.file.records).toEqual([]);
  });

  it('writes an index that a reader accepts', async () => {
    await write('a.ts', 'const retry = 1;');
    await refresh(fakeEmbedder());

    const read = await readIndex(indexDir, MODEL);

    expect(read?.file.count).toBe(1);
    expect(read?.vectors.length).toBe(8);
  });
});

describe('memoryBullets', () => {
  it('reads sections and bullets with the store’s own splitter', () => {
    const bullets = memoryBullets(
      '# My notes\n\n## Preferences and tone\n- short answers\n- no emoji\n\n## Boundaries\n- never force-push\n',
    );

    expect(bullets).toEqual([
      {section: 'Preferences and tone', text: 'short answers'},
      {section: 'Preferences and tone', text: 'no emoji'},
      {section: 'Boundaries', text: 'never force-push'},
    ]);
  });

  /*
   * A bullet before the first `##` has no heading, which is not the same as
   * belonging nowhere: it is indexed under the file's own name rather than
   * dropped. Prose is not a bullet and is not indexed — the unit of memory is the
   * bullet, and the tools only ever write those.
   */
  it('keeps a bullet that has no heading', () => {
    expect(memoryBullets('- the user is called Sam\n')).toEqual([
      {section: 'memory.md', text: 'the user is called Sam'},
    ]);
  });

  it('ignores prose and blank lines', () => {
    expect(
      memoryBullets('## Notes\n\nSome prose with no bullet.\n- a real fact\n\n'),
    ).toEqual([{section: 'Notes', text: 'a real fact'}]);
  });

  it('handles an empty file', () => {
    expect(memoryBullets('')).toEqual([]);
  });
});
