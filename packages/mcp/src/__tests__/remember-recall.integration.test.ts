/**
 * TEST-2 (mcp slice) — real-container + real-server round trip.
 *
 * Every other stdio test in this package (recall.stdio.test.ts,
 * contracts/stdio-tools.ts) drives the MCP stdio adapter against a fake
 * `http.createServer` that just echoes canned JSON — that proves the
 * stdio<->HTTP wiring, not that memory_remember/memory_recall actually work
 * against the real @mnemo-ai/server + @mnemo-ai/core cognitive pipeline.
 *
 * Setup/teardown (real pgvector testcontainer, both migration streams, real
 * Hono app on a real loopback port, real MCP stdio child process) is
 * extracted into `./harness/live-surface.ts` (B3.1) — this file only calls
 * `startLiveSurface()`/`surface.close()` and asserts the round trip: what
 * you remembered through `surface.mcp` is what you recall.
 *
 * Requires Docker AND a prior `pnpm --filter @mnemo-ai/mcp build`,
 * `pnpm --filter @mnemo-ai/cli build`, `pnpm --filter @mnemo-ai/core build`,
 * and `pnpm --filter @mnemo-ai/adapter-postgres build` — see
 * `./harness/live-surface.ts`'s module doc for exactly why.
 *
 * Also requires Node >=22 locally — testcontainers' http-wait-strategy
 * import chain hits undici's `webidl.util.markAsUncloneable`, which doesn't
 * exist on Node 20 (this is why ci.yml's integration-test job pins
 * node-version: 22 while every other job stays on 20; see the same note in
 * packages/core/src/__tests__/integration/entity-episode-decision-store.integration.test.ts).
 * Run with:
 *   mise exec node@22 -- pnpm --filter @mnemo-ai/mcp test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "./harness/live-surface.js";
import { MCP_TIMEOUT_MS, TEST_TIMEOUT_MS } from "./contracts/stdio-tools.js";

const STATEMENT = "The customer Acme Corp prefers invoices in EUR, not USD.";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 180_000);

afterAll(async () => {
  await surface?.close();
}, 60_000);

describe("memory_remember -> memory_recall round trip (real server + real Postgres)", () => {
  it(
    "recalls a fact that was just remembered",
    async () => {
      const rememberResult = await surface.mcp.callTool(
        { name: "memory_remember", arguments: { statement: STATEMENT, subject: "acme" } },
        undefined,
        { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS }
      );
      if (!("content" in rememberResult) || rememberResult.isError) {
        throw new Error(`memory_remember failed: ${JSON.stringify(rememberResult)}`);
      }

      // memory_recall's schema has no `vector` param and deps.llm is
      // undefined in this harness (no real LLM key), so POST /recall
      // degrades to its documented lexical-only fallback (vectorWeight
      // forced to 0 — see routes/recall.ts). Query shares literal words
      // with STATEMENT so the FTS match is reliable rather than relying on
      // the fake embed adapter, which recall.ts doesn't even consult here.
      const recallResult = await surface.mcp.callTool(
        { name: "memory_recall", arguments: { query: "Acme invoices EUR", limit: 5 } },
        undefined,
        { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS }
      );
      if (!("content" in recallResult) || recallResult.isError) {
        throw new Error(`memory_recall failed: ${JSON.stringify(recallResult)}`);
      }

      const structured = recallResult.structuredContent as {
        memories?: Array<Record<string, unknown>>;
      };
      expect(Array.isArray(structured.memories)).toBe(true);
      expect(structured.memories!.length).toBeGreaterThan(0);
      expect(structured.memories!.some((m) => m.content === STATEMENT)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});
