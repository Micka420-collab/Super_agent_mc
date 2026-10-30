import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.EMETH_E2E ? [] : ['test/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
