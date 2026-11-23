import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "node",
  target: "node20",
  external: ["@mnemo-ai/types", "@mnemo-ai/core"],
  banner: {
    js: "/* @mnemo-ai/plugins — see https://github.com/lucasmailland/mnemosyne */",
  },
});
