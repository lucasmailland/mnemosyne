import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

// Bug 2 regression — async fact-embedding gap.
//
// remember() used to apply a fact's embedding ONLY by appending a `vector_upsert`
// outbox entry and letting the background OutboxWorker drain it. Any outbox
// consumer that claimed that entry and failed to route it to the vector sink
// (e.g. a second/stale server on an older build whose worker no-ops every entry)
// silently dropped the embedding, leaving mnemo_fact.embedding NULL and recall
// of fresh facts non-semantic.
//
// The fix applies the embedding SYNCHRONOUSLY to the fact row inside remember()
// via ctx.vector.upsert, so a freshly-written fact is searchable immediately and
// is no longer at the mercy of the async drain. The outbox entry remains as an
// idempotent durability fallback.

const auth: AuthContext = {
  workspaceId: "ws-sync-embed",
  actorId: "agent-sync-embed",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

type UpsertCall = { id: string; vector: Float32Array; metadata?: Record<string, unknown> };

function makeCtx(storage: InMemoryStorageAdapter, upsertCalls: UpsertCall[]) {
  return {
    storage,
    vector: {
      // PE = 1.0 → never surprise-gated, so the fact is always committed.
      search: async () => [],
      // Spy that records every synchronous embedding write.
      upsert: async (id: string, vector: Float32Array, metadata?: Record<string, unknown>) => {
        upsertCalls.push({ id, vector, metadata });
      },
    },
    embed: {
      model: "test-embed-model",
      embedSingle: async () => new Float32Array([0.1, 0.2, 0.3]),
    },
    telemetry: {
      startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {} }),
    },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
    },
  } as never;
}

describe("remember() — Bug 2: synchronous fact embedding", () => {
  it("persists fact tags in domain metadata for canonical recall filtering", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, []);

    const res = await remember(
      ctx,
      {
        workspaceId: "ws-sync-embed",
        kind: "fact",
        content: "tagged fact",
        tags: ["typescript", "security"],
        metadata: { source: "test" },
      },
      auth
    );

    const saved = await storage.getFact(res.id, "ws-sync-embed");
    expect(saved?.metadata).toEqual({
      source: "test",
      tags: ["typescript", "security"],
    });
  });

  it("applies a host-precomputed embedding to the fact row synchronously via ctx.vector.upsert", async () => {
    const storage = new InMemoryStorageAdapter();
    const upsertCalls: UpsertCall[] = [];
    const ctx = makeCtx(storage, upsertCalls);
    const precomputed = new Float32Array([0.5, -0.25, 0.75]);

    const res = await remember(
      ctx,
      {
        workspaceId: "ws-sync-embed",
        kind: "fact",
        content: "the sky is blue",
        precomputedEmbedding: precomputed,
      },
      auth
    );

    // The embedding must be written for the SAME fact id remember() returns, by
    // the time remember() resolves (i.e. synchronously, not deferred to the outbox).
    expect(res.staged).not.toBe(true);
    const factUpsert = upsertCalls.find((c) => c.id === res.id);
    expect(factUpsert, "ctx.vector.upsert was not called for the new fact id").toBeDefined();
    expect(Array.from(factUpsert!.vector)).toEqual(Array.from(precomputed));
    expect(factUpsert!.metadata).toMatchObject({ kind: "fact" });

    // Clobber guard: with a host vector supplied, the fact's vector_upsert outbox
    // entry MUST be vector-form (authoritative) and MUST NOT be a text-form entry
    // that the worker would re-embed — re-embedding the statement would overwrite
    // the host vector. Honours "server skips its own embed pass when a vector is
    // supplied".
    const factOutbox = storage.outbox.filter(
      (e) => e.eventType === "vector_upsert" && (e.payload as { id?: string }).id === res.id
    );
    expect(
      factOutbox.some((e) => Array.isArray((e.payload as { vector?: unknown }).vector)),
      "expected a vector-form vector_upsert outbox entry for the fact"
    ).toBe(true);
    expect(
      factOutbox.some((e) => typeof (e.payload as { text?: unknown }).text === "string"),
      "a text-form vector_upsert entry would re-embed and clobber the host vector"
    ).toBe(false);
  });

  it("also embeds synchronously when the embedding is computed server-side (no precomputed vector)", async () => {
    const storage = new InMemoryStorageAdapter();
    const upsertCalls: UpsertCall[] = [];
    const ctx = makeCtx(storage, upsertCalls);

    const res = await remember(
      ctx,
      { workspaceId: "ws-sync-embed", kind: "fact", content: "grass is green" },
      auth
    );

    const factUpsert = upsertCalls.find((c) => c.id === res.id);
    expect(factUpsert, "ctx.vector.upsert was not called for the embedded fact").toBeDefined();
    // Embed stub returns [0.1, 0.2, 0.3].
    expect(Array.from(factUpsert!.vector)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
    ]);
  });
});
