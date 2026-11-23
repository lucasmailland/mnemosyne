/**
 * Unit tests for LLM-enhanced contextual anticipation (§gap4).
 *
 * Tests the enrichWithLlmContext path in GET /anticipation:
 *   - When no context is provided, LLM is not invoked.
 *   - When context is provided but no LLM is available, feed is returned unchanged.
 *   - When context + LLM are available, extra search queries are generated and merged.
 *   - LLM-derived items deduplicate against existing statistical items.
 *   - LLM failures degrade gracefully (feed unchanged).
 *
 * flatten-legacy-dual-core PR11: `deps.core.recall` -> `deps.cognitive.recall`
 * (v3 `MnemoCore`) — response shape is `{hits: RecallHit[]}`, not a bare
 * array; see anticipation.ts's `enrichWithLlmContext` doc comment.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { LLMAdapter } from "@mnemo-ai/types";
import { mountAnticipation } from "../../routes/anticipation.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";

function makeApp(storageOverrides: Partial<StorageAdapter>, extraDeps: Partial<ServerDeps> = {}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", [] as ReadonlyArray<string>);
    // flatten-legacy-dual-core PR11: the LLM-enrichment branch now builds a
    // v3 AuthContext via resolveProvenance(c), which requires actorId/
    // actorType to be populated (provenance.ts) — previously unneeded here
    // since the legacy `deps.core.recall` call took no auth argument.
    c.set("actorId", "test-anticipation-key-id");
    c.set("actorType", "agent");
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    cognitive: {
      recall: vi.fn().mockResolvedValue({ hits: [] }),
    },
    ...extraDeps,
  } as unknown as ServerDeps;

  mountAnticipation(app, fakeDeps);
  return { request: app.request.bind(app), fakeDeps };
}

const EMPTY_STORAGE: Partial<StorageAdapter> = {
  getSequentialPatterns: async () => [],
  getPeriodicPatterns: async () => [],
  getConditionalPatterns: async () => [],
  getCoOccurrencePatterns: async () => [],
};

describe("GET /anticipation — LLM contextual enrichment (§gap4)", () => {
  it("returns 200 without LLM enrichment when no context is provided", async () => {
    const { request, fakeDeps } = makeApp(EMPTY_STORAGE);
    const res = await request("/anticipation");
    expect(res.status).toBe(200);
    // deps.cognitive.recall should NOT be called when there is no context.
    expect(
      (fakeDeps.cognitive as { recall: ReturnType<typeof vi.fn> }).recall
    ).not.toHaveBeenCalled();
  });

  it("returns feed unchanged when context is provided but no LLM adapter is available", async () => {
    const { request } = makeApp(EMPTY_STORAGE);
    const res = await request("/anticipation?context=deploy+pipeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    // No LLM = no extra items beyond statistical ones (empty here).
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("enriches feed with LLM-derived items when context + LLM adapter are available", async () => {
    const mockLlmAdapter: Partial<LLMAdapter> = {
      id: "test-llm",
      model: "test-model",
      generate: vi.fn().mockResolvedValue({
        content: '["deploy pipeline steps", "CI configuration"]',
        tokensUsed: { input: 10, output: 10 },
        model: "test-model",
        finishReason: "stop",
      }),
      generateStructured: vi.fn(),
      healthCheck: vi.fn(),
    };

    const recallHit = {
      id: "fact-from-llm-recall",
      content: "Deploy uses GitHub Actions",
      score: 0.85,
      lexicalScore: 0.5,
      vectorScore: 0.85,
      validFrom: new Date().toISOString(), // determinism-ok: fixture timestamp, value not asserted
      validTo: null,
    };

    const { request, fakeDeps } = makeApp(EMPTY_STORAGE, {
      llmAdapter: mockLlmAdapter as LLMAdapter,
    });

    // Make recall return a hit for LLM-generated queries.
    (fakeDeps.cognitive as { recall: ReturnType<typeof vi.fn> }).recall
      .mockResolvedValueOnce({ hits: [recallHit] })
      .mockResolvedValue({ hits: [] });

    const res = await request("/anticipation?context=deploy+pipeline");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; source: string }> };

    // The LLM adapter should have been called for query generation.
    expect(mockLlmAdapter.generate).toHaveBeenCalledOnce();

    // The recall hit from LLM queries should appear in the feed.
    const llmItem = body.items.find((i) => i.id === "fact-from-llm-recall");
    expect(llmItem).toBeDefined();
    expect(llmItem!.source).toBe("conditional");
  });

  it("deduplicates LLM-derived items that are already in the statistical feed", async () => {
    const existingFactId = "existing-stat-fact";

    const storageWithItems: Partial<StorageAdapter> = {
      getSequentialPatterns: async () => [],
      getPeriodicPatterns: async () => [
        {
          memoryId: existingFactId,
          workspaceId: WORKSPACE_ID,
          dayOfWeek: 1,
          hourBucket: 2,
          slotShare: 0.8,
          distinctWeeks: 4,
        },
      ],
      getConditionalPatterns: async () => [],
      getCoOccurrencePatterns: async () => [],
    };

    const mockLlmAdapter: Partial<LLMAdapter> = {
      id: "test-llm",
      model: "test-model",
      generate: vi.fn().mockResolvedValue({
        content: '["weekly standup topics"]',
        tokensUsed: { input: 10, output: 5 },
        model: "test-model",
        finishReason: "stop",
      }),
      generateStructured: vi.fn(),
      healthCheck: vi.fn(),
    };

    const { request, fakeDeps } = makeApp(storageWithItems, {
      llmAdapter: mockLlmAdapter as LLMAdapter,
    });

    // LLM recall returns the same fact that is already in the statistical feed.
    (fakeDeps.cognitive as { recall: ReturnType<typeof vi.fn> }).recall.mockResolvedValue({
      hits: [
        {
          id: existingFactId,
          content: "Weekly standup is at 9am",
          score: 0.9,
          validFrom: new Date().toISOString(), // determinism-ok: fixture timestamp, value not asserted
          validTo: null,
        },
      ],
    });

    const res = await request("/anticipation?context=morning+standup");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };

    // Fact appears only once despite being in both statistical and LLM results.
    const occurrences = body.items.filter((i) => i.id === existingFactId);
    expect(occurrences).toHaveLength(1);
  });

  it("returns feed unchanged when LLM query generation fails", async () => {
    const mockFailingAdapter: Partial<LLMAdapter> = {
      id: "failing-llm",
      model: "test-model",
      generate: vi.fn().mockRejectedValue(new Error("LLM provider unavailable")),
      generateStructured: vi.fn(),
      healthCheck: vi.fn(),
    };

    const { request } = makeApp(EMPTY_STORAGE, {
      llmAdapter: mockFailingAdapter as LLMAdapter,
    });

    const res = await request("/anticipation?context=failing+context");
    // Should still return 200 with an empty (but valid) feed.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("returns feed unchanged when LLM returns invalid JSON", async () => {
    const mockBadJsonAdapter: Partial<LLMAdapter> = {
      id: "bad-json-llm",
      model: "test-model",
      generate: vi.fn().mockResolvedValue({
        content: "not valid json at all",
        tokensUsed: { input: 10, output: 5 },
        model: "test-model",
        finishReason: "stop",
      }),
      generateStructured: vi.fn(),
      healthCheck: vi.fn(),
    };

    const { request } = makeApp(EMPTY_STORAGE, {
      llmAdapter: mockBadJsonAdapter as LLMAdapter,
    });

    const res = await request("/anticipation?context=some+context");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });
});
