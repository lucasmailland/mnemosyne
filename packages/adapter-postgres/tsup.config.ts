import { defineConfig } from "tsup";

export default defineConfig({
  // migration-safety.ts must stay a separate entry (not just re-exported from
  // index.ts) — scripts/lint-migrations.mjs dynamically imports
  // dist/migration-safety.js directly, and tsup only emits a standalone file
  // per declared entry.
  entry: ["src/index.ts", "src/migrate.ts", "src/migration-safety.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: [
    "@mnemo-ai/types",
    "@mnemo-ai/core",
    "drizzle-orm",
    "drizzle-orm/pg-core",
    "drizzle-orm/postgres-js",
    "postgres",
  ],
  banner: {
    js: "/* @mnemo-ai/adapter-postgres — see https://github.com/lucasmailland/mnemosyne */",
  },
});
