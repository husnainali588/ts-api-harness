import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**', '.harness/**'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    env: { HARNESS_NO_DOTENV: '1' },
  },
});
