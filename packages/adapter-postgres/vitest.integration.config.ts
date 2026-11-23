import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
