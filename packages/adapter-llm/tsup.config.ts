import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: ["@mnemo-ai/types", "@mnemo-ai/llm-providers"],
  banner: {
    js: "/* @mnemo-ai/adapter-llm — see https://github.com/lucasmailland/mnemosyne */",
  },
});
