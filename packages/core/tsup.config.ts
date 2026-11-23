// packages/core/tsup.config.ts
//
// Dual-output build (ESM + CJS) with type declarations.
//
// Entry points are the four documented `exports` map keys plus the
// migrate CLI binary. Each entry produces an `.js` (ESM), `.cjs`
// (CJS) and `.d.ts` (types) file, all under `dist/`.
//
// `external` lists every package consumers must pin themselves —
// they're declared as peerDeps in package.json, and tsup must not
// bundle them or we'd ship duplicate copies of drizzle that
// instanceof-check against the host's copy and silently fail.
//
// `dts: true` works in v2.0 because the package no longer takes a
// workspace dep (this was the v1.6 blocker that forced DTS off).

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    protocol: "src/protocol/v1.ts",
    migrate: "src/cli/migrate.ts",
    db: "src/db/index.ts",
    // Memory Graph — client-safe canvas/types/layout entry. Zero DB.
    // flatten-legacy-dual-core Phase 8: the server-only twin
    // (`graph-server` → `src/graph/server.ts`, buildGraphData/Query) is
    // DELETED together with its now-orphaned legacy assembly — see
    // index.ts's "Memory Graph" comment.
    graph: "src/graph/index.ts",
    // cognitive entry — zero infrastructure imports, fully port-based
    cognitive: "src/cognitive/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  tsconfig: "./tsconfig.build.json",
  clean: true,
  sourcemap: true,
  target: "node20",
  // Mark every peer/runtime dep as external — tsup must NOT bundle
  // drizzle, postgres, zod, lru-cache or cuid2 because doing so would
  // ship duplicate copies that fail `instanceof` checks against the
  // host's copy. The host owns these versions via peerDeps + deps.
  external: [
    "drizzle-orm",
    "drizzle-orm/pg-core",
    "drizzle-orm/postgres-js",
    "drizzle-orm/node-postgres",
    "postgres",
    "zod",
    "lru-cache",
    "@paralleldrive/cuid2",
    "@mnemo-ai/types",
  ],
  banner: {
    js: "/* @mnemo-ai/core — see https://github.com/lucasmailland/mnemosyne */",
  },
  // `migrate` is a CLI; make the emitted entry executable so
  // `pnpx mnemo-migrate` works straight out of the registry tarball.
  onSuccess: "chmod +x dist/migrate.js dist/migrate.cjs 2>/dev/null || true",
});
