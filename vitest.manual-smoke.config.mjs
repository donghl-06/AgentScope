import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['tests/manual-smoke/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
