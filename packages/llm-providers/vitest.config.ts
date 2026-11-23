import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // When tests import from "@mnemo-ai/llm-providers" (the package's own
    // name), resolve to source rather than dist so tests run without a prior
    // build step. dist/ may not exist in CI until after the separate build job.
    alias: {
      "@mnemo-ai/llm-providers": path.resolve(__dirname, "./src/index.ts"),
    },
  },
  test: {
    globals: false,
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    coverage: {
      enabled: Boolean(process.env.CI) || Boolean(process.env.COVERAGE),
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/**/*.d.ts"],
      thresholds: { lines: 41, functions: 35, branches: 34, statements: 39 },
    },
  },
});
