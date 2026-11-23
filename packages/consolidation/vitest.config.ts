import { defineConfig } from "vitest/config";

/**
 * Unit test config. Integration tests (testcontainers + Docker) are excluded
 * here and run via `test:integration`. Coverage is collected ONLY in CI (or when
 * COVERAGE=1) so local `pnpm test` stays fast; thresholds are the ratchet floor —
 * raise them toward the 85% rubric target in W0 follow-ups, never lower them.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    coverage: {
      enabled: Boolean(process.env.CI) || Boolean(process.env.COVERAGE),
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/**/*.d.ts"],
      thresholds: { lines: 76, functions: 75, branches: 71, statements: 76 },
    },
  },
});
