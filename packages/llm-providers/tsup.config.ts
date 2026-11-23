import { defineConfig } from "tsup";

// We ship both ESM and CJS because while the modern world is ESM-first,
// plenty of consumers (older Next.js apps, CRA holdouts, certain enterprise
// stacks) still resolve the "require" condition. The cost of dual-emit is
// negligible since this package has no heavy runtime dependencies.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Mark zod external — it's a normal runtime dep, so bundling it would
  // ship a duplicate copy that fails `instanceof` checks against the
  // host's zod (schemas, branded types). The consumer pins zod via npm.
  // Provider classes use native fetch, so nothing else needs marking.
  external: ["zod"],
  target: "node20",
  treeshake: true,
});
