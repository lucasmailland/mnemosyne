import { defineConfig } from "vitest/config";

import { privateTmpdir } from "./vitest.tmpdir";

export default defineConfig({
  test: {
    /**
     * Test FILES run one at a time in this package, deliberately.
     *
     * `package.test.ts` rebuilds `dist/` to pack it, and `capabilities.test.ts`
     * hashes that same `dist/` to check the checked-in qualification records
     * still describe the artifact. Run in parallel workers, the second reads
     * bytes the first is mid-write, the digest comes out different, and the
     * capture decision degrades to `mcp-only` — which is a *safe* wrong answer,
     * so it surfaced as an unexplained intermittent failure rather than a crash.
     *
     * The alternative, packing from a copy of the package, means reproducing
     * pnpm's workspace resolution in a temp directory. This costs a minute of
     * local test time and removes the whole class.
     */
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    env: { TMPDIR: privateTmpdir() },
  },
});
