import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

// Isolate cold cascade: stub composition so the test is self-contained.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { recallCold } = await import("../recall-cold.js");

const auth = {
  workspaceId: "ws-he",
  scopes: ["memory:admin"],
  sessionId: "s-he",
} as unknown as AuthContext;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The primary recalled fact — has two hyperedge memberships. */
const F1 = {
  id: "f1",
  workspaceId: "ws-he",
  subject: "user",
  kind: "other" as const,
  scope: "global" as const,
  statement: "Primary fact",
  sensitivity: "internal" as const,
  attribution: "user_stated" as const,
  attributedTo: "user",
  sourceMessageIds: [],
  revisionCount: 0,
  protocolVersion: "3",
  episodeId: null,
  status: "active" as const,
  pinned: false,
  canonical: false,
  validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
  embeddingStale: false,
  memoryStrength: 0.8,
  memoryStability: 1.0,
  worth: 0.9,
  worthAlpha: 10,
  worthBeta: 2,
  worthSuccess: 8,
  worthFailure: 0,
  confidence: 0.9,
  relevance: 0.9,
  hitCount: 10,
  memoryType: "semantic" as const,
  createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  metadata: {},
};

/** Co-member of the high-worth edge (HE_hi, worth 0.8) — MUST appear in results. */
const M1 = {
  ...F1,
  id: "m1",
  statement: "Co-member of high-worth edge",
};

/** Co-member of the low-worth edge (HE_lo, worth 0.4) — MUST NOT appear in results. */
const M2 = {
  ...F1,
  id: "m2",
  statement: "Co-member of low-worth edge",
};

/** Hyperedge HE_hi — worth 0.8 (> 0.5 gate → members expanded). */
const HE_HI = {
  id: "he-hi",
  workspaceId: "ws-he",
  memberIds: ["f1", "m1"],
  label: "high-worth-edge",
  worth: 0.8,
  activationCount: 1,
  createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
};

/** Hyperedge HE_lo — worth 0.4 (≤ 0.5 gate → members gated out). */
const HE_LO = {
  id: "he-lo",
  workspaceId: "ws-he",
  memberIds: ["f1", "m2"],
  label: "low-worth-edge",
  worth: 0.4,
  activationCount: 1,
  createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
};

function makeCtx() {
  // getFact(id, workspaceId) — serves viewFact (F1); M1/M2 must never be fetched
  const getFact = vi.fn(async (id: string, _ws: string) => {
    if (id === "f1") return F1;
    if (id === "m1") return M1;
    if (id === "m2") return M2;
    return null;
  });

  // queryHyperedges returns the two hyperedges for F1 as the member
  const queryHyperedges = vi.fn(async ({ memberId }: { memberId?: string }) => {
    if (memberId === "f1") {
      return { items: [HE_HI, HE_LO], total: 2, offset: 0, limit: 10, hasMore: false };
    }
    return { items: [], total: 0, offset: 0, limit: 10, hasMore: false };
  });

  const storage = {
    getFact,
    queryHyperedges,
    getRelations: vi.fn(async () => []),
    recordRecall: vi.fn(async () => undefined),
    getCoOccurrencePatterns: vi.fn(async () => []),
    createHyperedge: vi.fn(async () => ({ id: "x", memberIds: [] })),
  };

  // Vector search returns F1 with score 1.0 (high enough to pass worth gate after blending)
  const vector = {
    search: vi.fn(async () => [{ id: "f1", score: 1.0, primitiveKind: "fact" }]),
  };

  // Return distinct, orthogonal unit vectors so dedupByContent never confuses
  // different content strings with each other (cosine < 0.88 for distinct slots).
  // We cycle through 3 orthogonal basis vectors per unique string.
  const VECS: Float32Array[] = [
    new Float32Array([1, 0, 0]),
    new Float32Array([0, 1, 0]),
    new Float32Array([0, 0, 1]),
  ];
  const vecCache = new Map<string, Float32Array>();
  let vecIdx = 0;
  const getVec = (s: string) => {
    if (!vecCache.has(s)) {
      vecCache.set(s, VECS[vecIdx++ % VECS.length]!);
    }
    return vecCache.get(s)!;
  };
  const embed = {
    id: "e",
    model: "m",
    dimensions: 3,
    embed: vi.fn(async (xs: string[]) => xs.map((x) => getVec(x))),
    embedSingle: vi.fn(async (x: string) => getVec(x)),
  };

  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };

  // CRITICAL: telemetry mock must have full span shape — setAttribute called by child spans.
  const telemetry = {
    startSpan: () => ({ end() {}, setAttribute() {}, setStatus() {} }),
    histogram() {},
  };

  const outbox = { append: vi.fn(async () => undefined) };

  const ctx = {
    storage,
    vector,
    embed,
    logger,
    telemetry,
    outbox,
    config: {},
  } as unknown as Parameters<typeof recallCold>[0];
  return ctx;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recallCold — hyperedges are hints, not hits (spec §15, WP-3 RECALL-2)", () => {
  it("bumps only accepted batched structures and deduplicates shared hyperedges", async () => {
    const storage = new InMemoryStorageAdapter();
    const createCandidate = async (
      id: string,
      options: { sensitivity?: "internal" | "confidential"; tags?: string[] } = {}
    ) => {
      const fact = await storage.createFact({
        id,
        workspaceId: "ws-he",
        scope: "global",
        statement: `candidate ${id}`,
        subject: "batch",
        kind: "other",
        sensitivity: options.sensitivity ?? "internal",
        metadata: { tags: options.tags ?? ["wanted"] },
      });
      await storage.updateWorth(fact.id, "ws-he", "fact", {
        success: 20,
        failure: 0,
        creditWeight: 1,
      });
      return fact;
    };

    const acceptedA = await createCandidate("accepted-a");
    const acceptedB = await createCandidate("accepted-b");
    const confidential = await createCandidate("confidential", { sensitivity: "confidential" });
    const archived = await createCandidate("archived");
    const filterMismatch = await createCandidate("filter-mismatch", { tags: ["other"] });
    const lowWorth = await storage.createFact({
      id: "low-worth",
      workspaceId: "ws-he",
      scope: "global",
      statement: "candidate low-worth",
      subject: "batch",
      kind: "other",
      sensitivity: "internal",
      metadata: { tags: ["wanted"] },
    });
    // Must carry actual negative evidence, not just the untouched neutral
    // Beta(2,2) prior — passesWorthGate() exempts never-observed facts
    // (isUntested) from the gate, so a fact indistinguishable from "just
    // created" would now legitimately pass. Driving worth below 0.5 via a
    // real recorded failure is what should still reject it.
    await storage.updateWorth(lowWorth.id, "ws-he", "fact", {
      success: 0,
      failure: 20,
      creditWeight: 1,
    });
    await storage.updateFact(archived.id, "ws-he", { status: "forgotten", validTo: new Date() }); // determinism-ok: test date
    await storage.updateFact(lowWorth.id, "ws-he", { worthAlpha: 3, worthBeta: 10, worth: 0.23 });

    const acceptedEdge = await storage.createHyperedge({
      workspaceId: "ws-he",
      memberIds: [acceptedA.id, acceptedB.id, "accepted-anchor"],
    });
    const rejectedEdges = await Promise.all(
      [confidential, archived, lowWorth, filterMismatch].map((fact) =>
        storage.createHyperedge({
          workspaceId: "ws-he",
          memberIds: [fact.id, `${fact.id}-anchor-a`, `${fact.id}-anchor-b`],
        })
      )
    );
    const getRecallStructures = vi.spyOn(storage, "getRecallStructures");
    const outbox = { append: vi.fn(async () => undefined) };
    const ids = [acceptedA, acceptedB, confidential, archived, lowWorth, filterMismatch].map(
      (f) => f.id
    );
    const ctx = {
      storage,
      vector: {
        search: vi.fn(async () =>
          ids.map((id) => ({ id, score: 1, primitiveKind: "fact" as const }))
        ),
      },
      embed: {
        model: "test",
        embedSingle: vi.fn(async () => new Float32Array([1, 0])),
        embed: vi.fn(async (texts: string[]) =>
          texts.map((_, index) => {
            const vector = new Float32Array(texts.length);
            vector[index] = 1;
            return vector;
          })
        ),
      },
      outbox,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return this;
        },
      },
      telemetry: {
        startSpan: () => ({ end() {}, setAttribute() {} }),
        histogram() {},
        counter() {},
        gauge() {},
      },
      config: {},
    } as unknown as Parameters<typeof recallCold>[0];

    const result = await recallCold(
      ctx,
      {
        workspaceId: "ws-he",
        text: "query",
        embedding: new Float32Array([1, 0]),
        filter: { tags: ["wanted"] },
        limit: 10,
      },
      { ...auth, maxSensitivity: "internal" }
    );

    expect(result.hits.map((hit) => hit.id)).toEqual(
      expect.arrayContaining([acceptedA.id, acceptedB.id])
    );
    expect(getRecallStructures).toHaveBeenCalledOnce();
    const bumps = outbox.append.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.eventType === "hyperedge_bump");
    expect(bumps).toEqual([expect.objectContaining({ payload: { hyperedgeId: acceptedEdge.id } })]);
    for (const edge of rejectedEdges) {
      expect(bumps).not.toContainEqual(
        expect.objectContaining({ payload: { hyperedgeId: edge.id } })
      );
    }
  });

  it("does not bump hyperedges for a candidate rejected by an explicit lower ceiling", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.storage.getFact).mockResolvedValue({ ...F1, sensitivity: "confidential" });

    await recallCold(ctx, { workspaceId: "ws-he", text: "query", limit: 20 } as any, {
      ...auth,
      maxSensitivity: "public",
    });

    expect(ctx.outbox.append).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "hyperedge_bump",
      })
    );
  });

  it("bumps hyperedges organically but never for synthetic recalls", async () => {
    const organicCtx = makeCtx();
    await recallCold(organicCtx, { workspaceId: "ws-he", text: "query", limit: 20 } as any, auth);
    expect(organicCtx.outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "hyperedge_bump" })
    );

    const ctx = makeCtx();
    await recallCold(
      ctx,
      {
        workspaceId: "ws-he",
        text: "query",
        limit: 20,
        effects: { trafficOrigin: "evaluation", applyOrganicEffects: false },
      } as any,
      auth
    );
    expect(ctx.outbox.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "hyperedge_bump" })
    );
  });

  it("RECALL-2: never injects the co-member of a worth>0.5 hyperedge, nor fetches it", async () => {
    // HE_hi (worth 0.8) links the relevant F1 to M1, which the query never
    // matched. M1 used to be injected at F1.score × 0.8 with no similarity
    // check of its own, bypassing minSimilarity — 396 auto-formed hyperedges
    // put unrelated facts into every recall of the evaluation workspace.
    const ctx = makeCtx();
    const res = await recallCold(
      ctx,
      { workspaceId: "ws-he", text: "query", limit: 20 } as any,
      auth
    );

    expect(res.hits.map((h) => h.id)).not.toContain("m1");
    expect(ctx.storage.getFact).not.toHaveBeenCalledWith("m1", expect.anything());
  });

  it("keeps the hyperedge as a hint on the hit that belongs to it", async () => {
    const ctx = makeCtx();
    const res = await recallCold(
      ctx,
      { workspaceId: "ws-he", text: "query", limit: 20 } as any,
      auth
    );

    const f1Hit = res.hits.find((h) => h.id === "f1");
    expect(f1Hit?.hyperedges).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "he-hi", coMembers: ["m1"] })])
    );
  });

  it("does NOT include the co-member of a worth≤0.5 hyperedge", async () => {
    const ctx = makeCtx();
    const res = await recallCold(
      ctx,
      { workspaceId: "ws-he", text: "query", limit: 20 } as any,
      auth
    );

    const ids = res.hits.map((h) => h.id);
    expect(ids).not.toContain("m2");
  });

  it("still includes the primary fact F1 in the result set", async () => {
    const ctx = makeCtx();
    const res = await recallCold(
      ctx,
      { workspaceId: "ws-he", text: "query", limit: 20 } as any,
      auth
    );

    expect(res.hits.find((h) => h.id === "f1")).toBeDefined();
  });
});
