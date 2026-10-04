import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The end-to-end agent tests drive a real ADK runner over a loopback HTTP
    // server, which is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
