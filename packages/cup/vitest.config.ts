import { defineConfig } from "vitest/config";

/**
 * Unit test config. This package has no integration tests (and no
 * test:integration script); *.integration.test.ts stays excluded so one
 * added later needs its own config and script instead of running here.
 * Coverage is collected ONLY in CI (or when COVERAGE=1) so local `pnpm test`
 * stays fast; thresholds are the ratchet floor — raise them as coverage
 * improves, never lower them.
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
      thresholds: { lines: 86, functions: 93, branches: 73, statements: 86 },
    },
  },
});
