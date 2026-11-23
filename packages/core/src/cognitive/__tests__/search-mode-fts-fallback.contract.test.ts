/**
 * Contract test supporting `memory_search` (packages/mcp/src/tools/search.ts).
 *
 * `memory_search`'s promise: "fuerza vectorWeight: 1.0 para búsqueda 100%
 * semántica/vectorial" and "Cuando el servidor no tiene MNEMO_LLM_API_KEY
 * configurada, cae automáticamente a búsqueda full-text (FTS)... los
 * resultados siguen siendo útiles pero rankeados por ts_rank".
 *
 * This file proves the CORE-level (`recallCold`) half of that promise in
 * isolation, with mocked ports (no Postgres needed) — the companion
 * integration test (packages/server/src/__tests__/integration/
 * search-recall-vectorweight-noop.integration.test.ts) proves the same
 * claims end-to-end through the real HTTP route and a real Postgres
 * instance.
 *
 * MCP-1 (docs/archive/openspec/tool-promise-remediation/spec.md Requirement 8) — FIXED
 * 2026-07-29: the HTTP route (packages/server/src/routes/recall.ts) used to
 * never forward the request's `mode`/`vectorWeight` fields into the
 * `RecallQuery` sent to `recallCold`, so every HTTP call resolved to
 * `mode: "auto"` regardless of what was requested. The route now declares
 * `mode` in its zod schema and forwards both fields when explicitly
 * supplied.
 *
 * The asymmetry proven here is exactly WHY `memory_search` (search.ts)
 * deliberately does NOT force `mode: "semantic"` even post-fix:
 *
 *   - `recallCold` given a REAL `mode: "semantic"` (which now genuinely
 *     reaches core once the route forwards it) throws
 *     `semantic_search_unavailable` when no embedder is configured — it
 *     does NOT fall back to FTS. That would break `memory_search`'s own
 *     documented FTS-fallback promise.
 *   - `recallCold` given `mode: "auto"` (what `memory_search` sends today,
 *     by omitting mode/vectorWeight entirely) falls back to FTS
 *     gracefully, ranked by the storage port's `ftsCandidates` (ts_rank in
 *     the real Postgres adapter), matching the documented promise.
 *
 * Net effect: `memory_search`'s FTS-fallback promise now holds by genuine
 * design (it asks for "auto", not "semantic"), not as a side effect of a
 * routing bug. This is documented in `search.ts`'s MCP description.
 */
import { describe, it, expect, vi } from "vitest";
import { recallCold } from "../recall-cold.js";
import type { AuthContext } from "@mnemo-ai/types";

const AUTH: AuthContext = {
  workspaceId: "ws-1",
  actorId: "actor-1",
  scopes: ["memory:read", "memory:write"],
};

function makeNoEmbedCtx() {
  const ftsCandidates = vi.fn(async () => [
    {
      factId: "f-fts-1",
      workspaceId: "ws-1",
      statement: "FTS lexical result about the query terms",
      kind: "preference",
      status: "active",
      sensitivity: "internal",
      worth: 0.9,
      rank: 0.72,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ]);

  const search = vi.fn(async () => {
    throw new Error("vector.search must never be called when embed adapter is unavailable");
  });

  const storage = {
    ftsCandidates,
    getFact: vi.fn(async (id: string) =>
      id === "f-fts-1"
        ? {
            id: "f-fts-1",
            workspaceId: "ws-1",
            statement: "FTS lexical result about the query terms",
            kind: "preference",
            status: "active",
            sensitivity: "internal",
            worth: 0.9,
            createdAt: new Date("2026-01-01T00:00:00Z"),
          }
        : null
    ),
    getDecision: vi.fn(async () => null),
    getEpisode: vi.fn(async () => null),
    getEntity: vi.fn(async () => null),
    getStrategy: vi.fn(async () => null),
    getWorkflow: vi.fn(async () => null),
    getSkill: vi.fn(async () => null),
    getTask: vi.fn(async () => null),
    getEvent: vi.fn(async () => null),
    getReasoning: vi.fn(async () => null),
    getRelations: vi.fn(async () => []),
    queryHyperedges: vi.fn(async () => ({
      items: [],
      total: 0,
      offset: 0,
      limit: 10,
      hasMore: false,
    })),
    recordRecall: vi.fn(async () => undefined),
  };

  const vector = { search };
  // Matches the production "no embed adapter configured" shim exactly
  // (packages/server/src/index.ts model:"none" branch) — this is what
  // ctx.embed looks like when MNEMO_LLM_API_KEY is unset.
  const embed = {
    id: "no-embed",
    model: "none",
    dimensions: 1536,
    embedSingle: vi.fn(async () => {
      throw new Error("NO_EMBED_ADAPTER: embed adapter is not configured");
    }),
    embed: vi.fn(async () => {
      throw new Error("NO_EMBED_ADAPTER: embed adapter is not configured");
    }),
    healthCheck: vi.fn(async () => ({ status: "degraded" as const })),
  };

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const telemetry = {
    startSpan: vi.fn(() => ({ setAttribute: vi.fn(), end: vi.fn() })),
    histogram: vi.fn(),
  };
  const outbox = { append: vi.fn(async () => undefined) };

  return {
    ctx: { storage, vector, embed, logger, telemetry, outbox, config: {} } as any,
    ftsCandidates,
    search,
  };
}

describe("memory_search / memory_recall shared core — mode vs. no-embedder interaction", () => {
  it("mode: 'semantic' (a REAL, correctly-forwarded strict semantic request) throws rather than falling back when no embedder is configured", async () => {
    const { ctx, search } = makeNoEmbedCtx();

    await expect(
      recallCold(
        ctx,
        { workspaceId: "ws-1", text: "banana rocket velocity", mode: "semantic" },
        AUTH
      )
    ).rejects.toThrow(/semantic_search_unavailable/);

    expect(search).not.toHaveBeenCalled();
  });

  it("mode: 'auto' (what every HTTP-routed recall/search call ACTUALLY resolves to today) falls back to FTS gracefully — no throw, ranked by the storage ftsCandidates port (ts_rank in the real adapter)", async () => {
    const { ctx, ftsCandidates } = makeNoEmbedCtx();

    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "banana rocket velocity" /* mode omitted -> "auto" */ },
      AUTH
    );

    expect(ftsCandidates).toHaveBeenCalled();
    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.searchMode).toBe("fts");
    expect(response.debug?.fallback).toBe(true);
  });

  it("mode: undefined + vectorWeight: 1 (memory_search's PRE-fix request shape) throws rather than falling back — vectorWeight=1 alone (without mode) resolves to strict 'semantic' inside recallCold, same as mode:'semantic' explicitly", async () => {
    // Now that the HTTP route (packages/server/src/routes/recall.ts)
    // forwards body.vectorWeight into the RecallQuery it builds for
    // deps.cognitive.recall() (MCP-1 fix, 2026-07-29), a RecallQuery with
    // vectorWeight:1 genuinely reaches recallCold with that field
    // populated. This test isolates recallCold's own mode-resolution
    // logic: it maps vectorWeight===1 to "semantic" (see recall-cold.ts
    // requestedMode ternary), which — per the test above — throws instead
    // of falling back. This is exactly why memory_search (search.ts) no
    // longer sends vectorWeight:1/mode:"semantic" post-fix: there is no
    // parameter combination that both (a) requests pure-vector semantic
    // search and (b) gracefully degrades to FTS when no embedder is
    // configured; those two are mutually exclusive by design (B5.9).
    const { ctx, search } = makeNoEmbedCtx();

    await expect(
      recallCold(
        ctx,
        { workspaceId: "ws-1", text: "banana rocket velocity", vectorWeight: 1 },
        AUTH
      )
    ).rejects.toThrow(/semantic_search_unavailable/);
    expect(search).not.toHaveBeenCalled();
  });
});
