import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries. `src/index.ts` is a `bin` with top-level dispatch — importing it
  // RUNS the CLI — so the Codex gate reader gets its own side-effect-free entry
  // that the qualifier can import to share one implementation of the parse.
  entry: ["src/index.ts", "src/codex-config.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: ["@mnemo-ai/types", "@mnemo-ai/client-ts"],
  // @mnemo-ai/harness is not on npm, so it ships inside the CLI:
  // scripts/copy-harness.cjs copies its built package to dist/harness after
  // tsup, and the CLI imports it from there rather than bundling it, because
  // capture is only enabled when the harness dist that runs is the one its
  // qualification records were made for. Its only dependency, @mnemo-ai/types,
  // is a CLI dependency.
  esbuildPlugins: [
    {
      name: "harness-from-dist-copy",
      setup(build) {
        build.onResolve({ filter: /^@mnemo-ai\/harness$/ }, () => ({
          path: "./harness/dist/index.js",
          external: true,
        }));
      },
    },
  ],
  banner: {
    js: "/* @mnemo-ai/cli — see https://github.com/lucasmailland/mnemosyne */",
  },
  onSuccess: "chmod +x dist/index.js 2>/dev/null || true",
});
