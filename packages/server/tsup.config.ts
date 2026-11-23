import { defineConfig } from "tsup";

/**
 * tsup build configuration for @mnemo-ai/server.
 *
 * The server is a runnable application, not a dual-format library.
 * We emit ESM only — CJS is dropped because the `import.meta.url`
 * entrypoint guard silently no-ops in CJS (esbuild `empty-import-meta`
 * warning) and there are no CJS consumers to support.
 *
 * `@mnemo-ai/core` and `@mnemo-ai/llm-providers` are marked external so
 * each workspace package stays separately versionable and we don't bundle
 * peer dependencies into the server's dist output.
 *
 * The shebang banner is applied unconditionally — the sole output format is
 * ESM, which is what the `mnemosyne-server` bin entry points at.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/app.ts", "src/dashboard-password.ts"],
  format: ["esm"],
  // DTS emit runs in a tsup worker heavy enough to OOM the
  // memory-constrained Docker build (ERR_WORKER_OUT_OF_MEMORY). The runtime
  // image only executes dist/*.js and never imports the .d.ts, so the
  // Dockerfile sets MNEMO_BUILD_NO_DTS=1 to skip declaration emit. The normal
  // `pnpm build` (CI / publish) still emits types.
  dts: process.env.MNEMO_BUILD_NO_DTS !== "1",
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: false,
  shims: false,
  external: ["@mnemo-ai/core", "@mnemo-ai/llm-providers", "ioredis"],
  banner: { js: "#!/usr/bin/env node" },
});
