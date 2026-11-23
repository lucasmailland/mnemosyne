import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  noExternal: ["@mnemo-ai/types/harness-runtime"],
  splitting: false,
  treeshake: true,
  target: "node20",
});
