import { defineConfig } from "vitest/config";

/**
 * Integration test config — kept separate from the default unit test run.
 * These tests spin up a real pgvector container via testcontainers, so
 * they are slow (container pull + boot + migrations) and require Docker.
 * Run with `pnpm --filter @mnemo-ai/server test:integration`.
 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Containers are heavyweight; never parallelise files against one pool.
    fileParallelism: false,
    pool: "forks",
  },
});
