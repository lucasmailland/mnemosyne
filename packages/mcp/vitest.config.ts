import { defineConfig } from "vitest/config";

/**
 * Unit + contract test config. `pnpm test` here needs a prior build (some
 * contract tests spawn the built stdio server — see turbo.json's
 * `@mnemo-ai/mcp#test` task, which depends on `build`). Coverage is
 * collected ONLY in CI (or when COVERAGE=1) so local `pnpm test` stays fast;
 * thresholds are the ratchet floor — raise them as coverage improves, never
 * lower them. NO_COVERAGE=1 opts back out — `test:contracts:runtime` sets it
 * because it only runs a 14-file curated subset, whose coverage % against
 * the whole src/ tree is meaningless to gate (same pattern as
 * @mnemo-ai/server's test:contracts).
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
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/**/*.d.ts"],
      thresholds: { lines: 81, functions: 85, branches: 70, statements: 82 },
    },
  },
});
