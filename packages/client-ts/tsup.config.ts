import { defineConfig } from "tsup";

// Why tsup over plain tsc:
// - Single source compiles to BOTH ESM (`.js`) and CJS (`.cjs`) so legacy
//   Next.js / Express consumers stuck on `require()` still work without
//   needing a separate build matrix.
// - `dts: true` emits a single rolled-up `.d.ts` per format — keeps the
//   published tarball small and import paths predictable.
// - `external: []` is intentional: this SDK has ZERO runtime dependencies
//   (it uses native fetch + AbortController). Anything that snuck in
//   should fail the build, not silently become a peer.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep no runtime deps bundled or referenced. The SDK is pure code.
  external: [],
  // Help bundlers tree-shake unused methods (recall vs. timeline vs. health).
  splitting: false,
  treeshake: true,
  target: "node20",
  // Banner identifies the package + version in stack traces from minified
  // consumer bundles. Cheap insurance for debuggability.
  banner: {
    js: "/* @mnemo-ai/client-ts — Apache-2.0 */",
  },
});
