import { defineConfig } from "vitest/config";

/**
 * Integration test config — REAL Postgres+pgvector via testcontainers, REAL
 * @mnemo-ai/server bound to a real loopback port. Separate from the default
 * unit-test run because these are slow (container boot + server boot) and
 * require Docker. Mirrors packages/core/vitest.integration.config.ts.
 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
