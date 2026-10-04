/**
 * The development launcher.
 *
 * Compiles the main process, preload and runner, starts Vite for the renderer,
 * and opens Electron pointed at the dev server. The point of doing it in one
 * command is that the three parts have to agree: a preload that was not rebuilt
 * fails in a way that looks like a renderer bug, and a main process started
 * before Vite is ready opens a window that never paints.
 *
 * The environment is passed through deliberately, so `MARIMO_USER_DATA_DIR` and
 * `MARIMO_OFFSCREEN` work here exactly as they do everywhere else.
 */
import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import electronPath from 'electron';
import {createServer} from 'vite';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function main(): Promise<void> {
  const server = await createServer({configFile: join(appRoot, 'vite.config.ts')});
  await server.listen();

  const url = server.resolvedUrls?.local[0];
  if (url === undefined) {
    throw new Error('Vite did not report a local URL to load.');
  }

  server.printUrls();

  const child = spawn(electronPath as unknown as string, [appRoot], {
    stdio: 'inherit',
    env: {...process.env, MARIMO_DEV_SERVER_URL: url},
  });

  const close = async (code: number | null): Promise<void> => {
    await server.close();
    process.exit(code ?? 0);
  };

  child.on('close', (code) => {
    void close(code);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      child.kill();
    });
  }
}

await main();
