import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: ["@mnemo-ai/types", "postgres"],
  banner: {
    js: "/* @mnemo-ai/adapter-vector — see https://github.com/lucasmailland/mnemosyne */",
  },
});
