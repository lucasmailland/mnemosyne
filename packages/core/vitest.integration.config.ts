import { defineConfig } from "vitest/config";

/**
 * Integration test config — REAL Postgres+pgvector via testcontainers.
 * Separate from the default unit-test run because these are slow (container
 * boot) and require Docker. Long timeouts cover container startup + migrate.
 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Containers are heavy; run integration files serially to avoid spinning
    // up N pgvector instances at once.
    fileParallelism: false,
  },
});
