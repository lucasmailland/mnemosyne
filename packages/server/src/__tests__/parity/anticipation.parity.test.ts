/**
 * Tier A parity — `routes/anticipation.ts` (design.md D3).
 *
 * HTTP characterization contract for GET /anticipation. The statistical
 * (non-LLM) path already reads exclusively from `deps.storage` (via
 * `buildAnticipationFeed`) — not `deps.core` — before this PR. This file
 * exercises the one `deps.core` call site: `enrichWithLlmContext`'s
 * `deps.core.recall`, used only when a `context` query param is supplied AND
 * an LLM adapter resolves. Written and merged green against the legacy
 * `deps.core.recall` implementation FIRST (flatten-legacy-dual-core PR11);
 * the port commit in this same PR swaps that one call to
 * `deps.cognitive.recall` (v3 `MnemoCore`).
 *
 * DISCLOSED exception: legacy `recall({workspaceId, query, topK,
 * vectorWeight})` returns a bare `RecallHit[]`; v3
 * `recall(RecallQuery, AuthContext)` takes `{workspaceId, text, limit}` +
 * a second `AuthContext` arg and returns `{hits: RecallHit[]}` — v3 has no
 * per-call `vectorWeight` knob (its 7-stage cascade always fuses vector +
 * lexical internally). A real calling-convention difference, not a behavior
 * change — every `expect(...)` line asserting response status/body is
 * unchanged; only the `recall` call-shape assertion below is updated.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountAnticipation } from "../../routes/anticipation.js";

const PLAINTEXT_KEY = "mns_live_anticipationparitytest1";
const WS_ID = "00000000-0000-0000-0000-000000000a02";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "anticipation-key-001", keyHash, workspaceId: WS_ID, scopes: [] },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

function noPatternStorage() {
  return {
    getSequentialPatterns: vi.fn().mockResolvedValue([]),
    getPeriodicPatterns: vi.fn().mockResolvedValue([]),
    getConditionalPatterns: vi.fn().mockResolvedValue([]),
    getCoOccurrencePatterns: vi.fn().mockResolvedValue([]),
  };
}

function recallHit(id: string, score: number) {
  return {
    id,
    content: "recalled content",
    score,
    validFrom: "2026-06-20T00:00:00.000Z",
    validTo: null,
  };
}

async function buildApp(
  opts: {
    storageOverrides?: Record<string, unknown>;
    cognitive?: Record<string, unknown>;
    llmAdapter?: Record<string, unknown>;
  } = {}
) {
  const storage = { ...noPatternStorage(), ...(opts.storageOverrides ?? {}) };
  const cognitive = opts.cognitive ?? {};
  const deps = {
    storage,
    cognitive,
    llmAdapter: opts.llmAdapter,
    apiKeys: await makeKeyLookup(),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountAnticipation]);
  return { app, storage, core: cognitive };
}

describe("Tier A parity: GET /anticipation (statistical path)", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/anticipation");
    expect(res.status).toBe(401);
  });

  it("returns 200 with an empty feed when no patterns exist", async () => {
    const { app } = await buildApp();
    const res = await app.request("/anticipation", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; items: unknown[] };
    expect(body.workspaceId).toBe(WS_ID);
    expect(body.items).toEqual([]);
  });

  it("returns 200 with items conforming to anticipated-memory.schema.json", async () => {
    const schema = loadSchema("anticipated-memory");
    const { app } = await buildApp({
      storageOverrides: {
        getSequentialPatterns: vi.fn().mockResolvedValue([
          {
            workspaceId: WS_ID,
            predecessorId: "fact_cue",
            successorId: "fact_next",
            support: 4,
            avgLagSeconds: 120,
            confidence: 0.9,
          },
        ]),
      },
    });
    const res = await app.request("/anticipation?recentlyRecalledId=fact_cue", {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, schema);
      expect(err).toBeNull();
    }
  });
});

describe("Tier A parity: GET /anticipation (LLM-context enrichment)", () => {
  it("no LLM adapter available: context is ignored, statistical feed returned unchanged", async () => {
    const { app, core } = await buildApp();
    const res = await app.request("/anticipation?context=deploying+the+chatbot", {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect(core.recall).toBeUndefined();
  });

  it("with an LLM adapter: generates queries, calls core.recall, and merges new items", async () => {
    const recall = vi
      .fn()
      .mockResolvedValueOnce({ hits: [recallHit("fact_llm_1", 0.6)] })
      .mockResolvedValueOnce({ hits: [recallHit("fact_llm_2", 0.4)] });
    const generate = vi.fn().mockResolvedValue({
      content: JSON.stringify(["deploy chatbot", "chatbot rollout plan"]),
    });
    const { app } = await buildApp({
      cognitive: { recall },
      llmAdapter: { generate },
    });
    const res = await app.request("/anticipation?context=deploying+the+chatbot", {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; source: string }> };
    expect(recall).toHaveBeenCalledTimes(2);
    // DISCLOSED exception (see file header) — v3 `recall` call shape.
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_ID, limit: 5 }),
      expect.objectContaining({ workspaceId: WS_ID })
    );
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain("fact_llm_1");
    expect(ids).toContain("fact_llm_2");
    expect(body.items.find((i) => i.id === "fact_llm_1")?.source).toBe("conditional");
  });

  it("LLM query generation fails: degrades gracefully to the statistical feed", async () => {
    const recall = vi.fn();
    const generate = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
    const { app } = await buildApp({ cognitive: { recall }, llmAdapter: { generate } });
    const res = await app.request("/anticipation?context=deploying+the+chatbot", {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect(recall).not.toHaveBeenCalled();
  });

  it("a rejected recall query is skipped, not fatal to the response", async () => {
    const recall = vi
      .fn()
      .mockResolvedValueOnce({ hits: [recallHit("fact_ok", 0.5)] })
      .mockRejectedValueOnce(new Error("recall failed"));
    const generate = vi.fn().mockResolvedValue({ content: JSON.stringify(["q1", "q2"]) });
    const { app } = await buildApp({ cognitive: { recall }, llmAdapter: { generate } });
    const res = await app.request("/anticipation?context=deploying+the+chatbot", {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain("fact_ok");
  });
});
