import { defineConfig } from "vitest/config";

/**
 * Unit test config. Coverage is collected ONLY in CI (or when COVERAGE=1) so
 * local `pnpm test` stays fast; thresholds are the ratchet floor — raise them
 * as coverage improves, never lower them.
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
      thresholds: { lines: 89, functions: 94, branches: 69, statements: 87 },
    },
  },
});
