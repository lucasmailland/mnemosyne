import { defineConfig } from "tsup";

/**
 * Build config for @mnemo-ai/mcp.
 *
 * Why ESM-only here (unlike the rest of the monorepo which dual-emits CJS):
 * this package ships a single CLI binary (`mnemosyne-mcp`) that runs as a
 * standalone Node process under an MCP client. There is no library consumer
 * that needs CommonJS interop — the `bin` is invoked directly via `node`
 * (or `npx`), so a single ESM artifact keeps the install small and the
 * `#!/usr/bin/env node` shebang unambiguous.
 *
 * `external` keeps the SDK and the workspace client peer-resolved instead
 * of bundled. The SDK is heavy and frequently updated; the client is a
 * peer dep so the host app pins the version it trusts.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  platform: "node",
  splitting: false,
  shims: false,
  external: ["@modelcontextprotocol/sdk", "@mnemo-ai/client-ts"],
  banner: {
    // tsup strips/preserves shebangs inconsistently across versions; setting
    // it explicitly here guarantees the compiled `dist/index.js` is directly
    // executable as a CLI without an extra post-build step.
    js: "#!/usr/bin/env node",
  },
  onSuccess: "chmod +x dist/index.js",
});
