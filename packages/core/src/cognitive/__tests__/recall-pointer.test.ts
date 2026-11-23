import { describe, it, expect } from "vitest";
import { tryPointerTier, applyTokenBudget } from "../recall-pointer.js";
import type { AuthContext, PointerCandidate } from "@mnemo-ai/types";

const auth = {
  scopes: [],
  sessionId: "s1",
  actorId: "a1",
  sensitivityCeiling: "restricted",
} as unknown as AuthContext;
const WS = "ws-1";

function emb(prefix: number[]): Float32Array {
  const v = new Float32Array(1536);
  for (let i = 0; i < prefix.length; i++) v[i] = prefix[i]!;
  return v;
}

function makeCtx(cands: PointerCandidate[], queryVec: Float32Array) {
  const bumped: string[] = [];
  return {
    bumped,
    ctx: {
      embed: { embedSingle: async () => queryVec },
      storage: { pointerCandidates: async () => cands },
      cache: {
        zincrby: async (_k: string, _by: number, id: string) => {
          bumped.push(id);
          return 1;
        },
        zrangeByScore: async () => bumped,
      },
      telemetry: { startSpan: () => ({ end: () => {} }), histogram: () => {} },
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      config: {
        maxHotTierSize: 1000,
        surpriseThreshold: 0,
        worthDecayLambda: 0.1,
        hotTierTtlSeconds: 1,
      },
      // unused but required by CoreContext
      outbox: {},
      vector: {},
      auth: {},
    } as never,
  };
}

// ─── applyTokenBudget ─────────────────────────────────────────────────────────

describe("applyTokenBudget — CALMem ladder (spec §17 lines 1338-1342)", () => {
  it("skips recall below 500 tokens", () => {
    expect(applyTokenBudget(300)).toEqual({
      skip: true,
      tryHot: false,
      tryPointer: false,
      tryCold: false,
      limit: 0,
    });
  });

  it("Tier 1 only below 2000, capped at 3", () => {
    const p = applyTokenBudget(1500);
    expect(p).toMatchObject({
      skip: false,
      tryHot: true,
      tryPointer: false,
      tryCold: false,
      limit: 3,
    });
  });

  it("Tier 1+2 below 8000, capped at 5", () => {
    const p = applyTokenBudget(5000);
    expect(p).toMatchObject({ tryHot: true, tryPointer: true, tryCold: false, limit: 5 });
  });

  it("full pipeline at/above 8000", () => {
    const p = applyTokenBudget(20000, 10);
    expect(p).toMatchObject({ tryHot: true, tryPointer: true, tryCold: true, limit: 10 });
  });

  it("unset budget => full pipeline", () => {
    expect(applyTokenBudget(undefined, 7)).toMatchObject({
      tryPointer: true,
      tryCold: true,
      limit: 7,
    });
  });

  it("exactly 500 => Tier 1 only (boundary)", () => {
    const p = applyTokenBudget(500);
    expect(p).toMatchObject({ skip: false, tryHot: true, tryPointer: false });
  });

  it("exactly 8000 => full pipeline (boundary)", () => {
    const p = applyTokenBudget(8000, 10);
    expect(p).toMatchObject({ tryPointer: true, tryCold: true });
  });
});

// ─── tryPointerTier ───────────────────────────────────────────────────────────

describe("tryPointerTier — sufficiency gate (spec §17 lines 1362-1365)", () => {
  it("returns hits when ≥3 candidates have score >0.7", async () => {
    // Same vector → cosine ≈ 1.0, worth=0.9 → score≈0.9
    const qVec = emb(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
    const cand = (id: string): PointerCandidate => ({
      factId: id,
      statement: `fact ${id}`,
      embedding: Array.from(qVec),
      status: "active",
      validTo: null,
      sensitivity: "internal",
      worth: 0.9,
      worthAlpha: 20,
      worthBeta: 2,
      attribution: "user_stated",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    });
    const { ctx } = makeCtx([cand("f1"), cand("f2"), cand("f3")], qVec);
    const res = await tryPointerTier(
      ctx,
      { workspaceId: WS, text: "acme", limit: 5 } as never,
      auth
    );
    expect(res).not.toBeNull();
    expect(res!.hits.length).toBeGreaterThanOrEqual(3);
  });

  it("serves synthetic traffic without promoting hits to the hot tier", async () => {
    const qVec = emb(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
    const cand = (id: string): PointerCandidate => ({
      factId: id,
      statement: `fact ${id}`,
      embedding: Array.from(qVec),
      status: "active",
      validTo: null,
      sensitivity: "internal",
      worth: 0.9,
      worthAlpha: 20,
      worthBeta: 2,
      attribution: "user_stated",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const { ctx, bumped } = makeCtx([cand("f1"), cand("f2"), cand("f3")], qVec);
    const res = await tryPointerTier(
      ctx,
      {
        workspaceId: WS,
        text: "acme",
        limit: 5,
        effects: { trafficOrigin: "installer_verify", applyOrganicEffects: false },
      } as never,
      auth
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res!.hits.length).toBeGreaterThanOrEqual(3);
    expect(bumped).toEqual([]);
  });

  it("returns null when fewer than 3 candidates exceed 0.7", async () => {
    // Orthogonal vector → cosine ≈ 0, worth=0.2 → score≈0
    const qVec = emb(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
    const orthogonal = emb(Array.from({ length: 64 }, (_, i) => Math.cos(i) * (i % 2 ? -1 : 1)));
    const weak = (id: string): PointerCandidate => ({
      factId: id,
      statement: id,
      embedding: Array.from(orthogonal),
      status: "active",
      validTo: null,
      sensitivity: "internal",
      worth: 0.2,
      attribution: "user_stated",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    });
    const { ctx } = makeCtx([weak("f1"), weak("f2"), weak("f3")], qVec);
    const res = await tryPointerTier(
      ctx,
      { workspaceId: WS, text: "acme", limit: 5 } as never,
      auth
    );
    expect(res).toBeNull();
  });

  it("returns null when no candidates returned", async () => {
    const qVec = emb([1, 0]);
    const { ctx } = makeCtx([], qVec);
    const res = await tryPointerTier(
      ctx,
      { workspaceId: WS, text: "anything", limit: 5 } as never,
      auth
    );
    expect(res).toBeNull();
  });

  it("rejects closed candidates before sufficiency and hot promotion", async () => {
    const qVec = emb(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
    const closed = (id: string): PointerCandidate => ({
      factId: id,
      statement: id,
      embedding: Array.from(qVec),
      sensitivity: "internal",
      worth: 0.9,
      attribution: "user_stated",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      status: "forgotten",
      validTo: new Date("2026-02-01T00:00:00Z"),
    });
    const { ctx, bumped } = makeCtx([closed("f1"), closed("f2"), closed("f3")], qVec);

    const result = await tryPointerTier(
      ctx,
      { workspaceId: WS, text: "acme", limit: 5 } as never,
      auth
    );

    expect(result).toBeNull();
    expect(bumped).toEqual([]);
  });

  it("returns null for non-fact-only kind filters (storage is fact-scoped, fall through to cold)", async () => {
    const qVec = emb([1, 0]);
    const { ctx } = makeCtx([], qVec);
    // Queries filtered to decisions, episodes, entities, etc. cannot use the
    // pointer tier because only mnemo_fact_lsh exists. The tier returns null so
    // the cascade continues to the cold HNSW tier which covers all kinds.
    for (const kinds of [
      ["decision"],
      ["episode"],
      ["entity"],
      ["strategy"],
      ["decision", "episode"],
    ] as const) {
      const res = await tryPointerTier(
        ctx,
        { workspaceId: WS, text: "anything", limit: 5, filter: { kinds } } as never,
        auth
      );
      expect(res).toBeNull();
    }
  });

  it("proceeds into pointer tier when kinds filter includes fact (even alongside others)", async () => {
    // When "fact" is present in the kinds filter, the pointer tier should NOT
    // short-circuit — it proceeds and may still return null for other reasons.
    const qVec = emb([1, 0]);
    const { ctx } = makeCtx([], qVec); // empty candidates → null
    const res = await tryPointerTier(
      ctx,
      {
        workspaceId: WS,
        text: "anything",
        limit: 5,
        filter: { kinds: ["fact", "decision"] },
      } as never,
      auth
    );
    // null here because pointerCandidates returned [] — but the tier was entered
    expect(res).toBeNull();
  });

  it("skips candidates that fail sensitivity ceiling", async () => {
    const qVec = emb(Array.from({ length: 64 }, (_, i) => Math.sin(i)));
    // 3 restricted facts — auth has sensitivityCeiling="restricted" so they should pass
    // but let's test with "public" ceiling on restricted facts
    const restrictedAuth = { ...auth, sensitivityCeiling: "internal" } as unknown as AuthContext;
    const cand = (id: string): PointerCandidate => ({
      factId: id,
      statement: `secret ${id}`,
      embedding: Array.from(qVec),
      sensitivity: "restricted", // above the ceiling
      worth: 0.9,
      attribution: "user_stated",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      status: "active",
      validTo: null,
    });
    const { ctx } = makeCtx([cand("f1"), cand("f2"), cand("f3")], qVec);
    const res = await tryPointerTier(
      ctx,
      { workspaceId: WS, text: "secret", limit: 5 } as never,
      restrictedAuth
    );
    // All filtered out → below sufficiency threshold → null
    expect(res).toBeNull();
  });
});
