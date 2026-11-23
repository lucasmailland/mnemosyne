import { defineConfig } from "tsup";

export default defineConfig([
  // Library entry (index.ts) — dual ESM+CJS
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    external: ["@mnemo-ai/types", "@mnemo-ai/core"],
    banner: {
      js: "/* @mnemo-ai/cup — see https://github.com/lucasmailland/mnemosyne */",
    },
  },
  // CLI entry (migrate.ts) — ESM only, not shipped as CJS
  {
    entry: ["src/migrate.ts"],
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node20",
    external: ["@mnemo-ai/types", "@mnemo-ai/core"],
    banner: {
      js: "#!/usr/bin/env node\n/* @mnemo-ai/cup — see https://github.com/lucasmailland/mnemosyne */",
    },
  },
]);
