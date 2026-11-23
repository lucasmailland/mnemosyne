import { defineConfig } from "vitest/config";

import { privateTmpdir } from "../harness/vitest.tmpdir";

/**
 * Unit test config. Coverage is collected ONLY in CI (or when COVERAGE=1) so
 * local `pnpm test` stays fast; thresholds are the ratchet floor — raise them
 * as coverage improves, never lower them.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Test homes are made under tmpdir(); see ../harness/vitest.tmpdir.ts.
    env: { TMPDIR: privateTmpdir() },
    server: {
      deps: {
        // @mnemo-ai/harness is a runtime dependency the CLI imports lazily and
        // tsup marks external — it is never bundled. Vitest's transform pipeline
        // would otherwise try to resolve its built entry at import-scan time, and
        // the harness package's own tests run `pnpm pack`, whose prepack build
        // wipes dist. Under a parallel run that race makes every CLI test file
        // fail to resolve a package it does not even load.
        external: ["@mnemo-ai/harness"],
      },
    },
    coverage: {
      enabled: Boolean(process.env.CI) || Boolean(process.env.COVERAGE),
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/**/*.d.ts"],
      thresholds: { lines: 40, functions: 57, branches: 35, statements: 40 },
    },
  },
});
