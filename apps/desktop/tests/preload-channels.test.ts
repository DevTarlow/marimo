/**
 * The preload repeats its channel names as literals.
 *
 * It has to: a sandboxed preload is CommonJS and cannot `require` the protocol,
 * which is ESM. The duplication is unavoidable, which is exactly why it is
 * tested — a channel that drifts is a bridge that listens where nobody sends,
 * and the symptom is a window that hangs on its first call with no error
 * anywhere.
 */
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {IPC_CALL_CHANNEL, IPC_EVENT_CHANNEL} from '@marimo/protocol';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const preloadSource = join(appRoot, 'src', 'preload', 'index.cts');

/** The right-hand side of `const NAME = 'value';` in the preload. */
function literal(source: string, name: string): string | undefined {
  const match = new RegExp(`const ${name} = '([^']+)';`, 'u').exec(source);
  return match?.[1];
}

describe('preload channels', () => {
  it('listens and calls on the channels the protocol names', async () => {
    const source = await readFile(preloadSource, 'utf8');

    expect(literal(source, 'CALL_CHANNEL')).toBe(IPC_CALL_CHANNEL);
    expect(literal(source, 'EVENT_CHANNEL')).toBe(IPC_EVENT_CHANNEL);
  });

  it('exposes exactly one bridge and nothing else', async () => {
    const source = await readFile(preloadSource, 'utf8');

    // The whole of the renderer's reach. A second `exposeInMainWorld`, or a
    // direct `ipcRenderer` handed over, would be a way around the validated
    // handler in the main process.
    const exposures = source.match(/exposeInMainWorld\(/gu) ?? [];
    expect(exposures).toHaveLength(1);
    expect(source).toContain("exposeInMainWorld('marimo'");
    expect(source).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/u);
  });
});
