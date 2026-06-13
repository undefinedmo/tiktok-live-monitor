import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',          // each test file in its own process — safe for the Prisma singleton
    fileParallelism: false, // integration tests share one DB; run files serially
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
