import { defineConfig } from "vitest/config";

/**
 * Default (unit) test config. Integration tests are heavyweight (they boot
 * a real pgvector container via testcontainers and need Docker) so they are
 * EXCLUDED here and run separately via `test:integration` against
 * `vitest.integration.config.ts`.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      enabled:
        !process.env.NO_COVERAGE && (Boolean(process.env.CI) || Boolean(process.env.COVERAGE)),
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        "src/index.ts", // boot script — covered by e2e
        "src/openapi.ts", // schema registration only
      ],
      thresholds: {
        lines: 62,
        functions: 52,
        branches: 50,
        statements: 60,
      },
    },
  },
});
