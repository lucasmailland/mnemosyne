import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing/index.ts", "src/harness-runtime.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  treeshake: true,
  // vitest must never be bundled — the testing subpath imports describe/it/expect
  // at the top level, and bundling vitest severs the runner context that the
  // vitest CLI sets up. Mark it external so the compiled output keeps a live
  // `import ... from "vitest"` that resolves to the same runtime instance.
  external: ["vitest"],
  banner: {
    js: "/* @mnemo-ai/types — see https://github.com/lucasmailland/mnemosyne */",
  },
});
