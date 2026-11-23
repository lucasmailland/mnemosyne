import { RECALLABLE_KINDS } from "@mnemo-ai/types";
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

// CORE-5: FactRepository.createFact (adapter-postgres) already enqueues a
// vector-form vector_upsert outbox entry inside its own transaction whenever
// input.embedding is set -- and remember.ts always passes embedding:
// Array.from(storedVector) for facts (see the comment right above that call:
// "Authoritative embedding -> createFact enqueues a vector-form
// vector_upsert"). remember.ts's own Step 6 ALSO unconditionally appended a
// second, identical vector_upsert entry for every kind, including fact --
// so every fact write produced two duplicate outbox rows. Gated Step 6's
// append on kind !== "fact" so FactRepository keeps owning the fact-path
// enqueue exclusively; the two neighboring appendOutbox calls (queue_job
// staging + anomaly_review) are untouched -- different event types.
//
// make-primitives-recallable (design.md D1/D2, PR1): the same double-enqueue
// bug existed for decisions -- DecisionRepository.createDecision already
// enqueues its own in-transaction vector_upsert entry, and Step 6's old
// `kind !== "fact"` gate still fired a second one for every decision write.
// Step 6 is now gated on RECALLABLE_KINDS (fact, decision) instead, so
// exactly one entry survives for both.
//
// CORE-6: ctx.vector.upsert (Step 6a's synchronous write) is fact-only by
// construction (PgVectorAdapter is bound to one table at construction time).
// RememberResponse's `vectorSearchable` field now reports RECALLABLE_KINDS
// membership (design.md D1/D2) rather than "applied synchronously": true for
// every recallable kind (fact, decision), even though only facts are
// vector-searchable the instant remember() returns -- decisions land once
// the async outbox worker drains their vector_upsert entry. Kinds outside
// RECALLABLE_KINDS still report false, permanently (never indexed at all).

const auth: AuthContext = {
  workspaceId: "ws-outbox-dedup",
  actorId: "agent-outbox-dedup",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

function makeCtx(storage: InMemoryStorageAdapter) {
  return {
    storage,
    vector: {
      search: async () => [],
      upsert: async () => {},
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

function vectorUpsertEntriesFor(storage: InMemoryStorageAdapter, id: string) {
  return storage.outbox.filter(
    (e) => e.eventType === "vector_upsert" && (e.payload as { id?: string }).id === id
  );
}

describe("remember(): outbox vector_upsert dedup (CORE-5)", () => {
  it("enqueues exactly ONE vector_upsert outbox entry for a fact write", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const res = await remember(
      ctx,
      { workspaceId: "ws-outbox-dedup", kind: "fact", content: "the sky is blue" },
      auth
    );

    expect(vectorUpsertEntriesFor(storage, res.id)).toHaveLength(1);
  });

  it("still enqueues a vector_upsert outbox entry for a non-fact kind (decision)", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const res = await remember(
      ctx,
      { workspaceId: "ws-outbox-dedup", kind: "decision", content: "use Postgres" },
      auth
    );

    expect(vectorUpsertEntriesFor(storage, res.id)).toHaveLength(1);
  });
});

describe("remember(): vectorSearchable response field (CORE-6)", () => {
  it("reports vectorSearchable: true for a fact (synchronous embedding write)", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const res = await remember(
      ctx,
      { workspaceId: "ws-outbox-dedup", kind: "fact", content: "the sky is blue" },
      auth
    );

    expect(res.vectorSearchable).toBe(true);
  });

  it("reports vectorSearchable: true for a decision (recallable kind, indexed asynchronously)", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const res = await remember(
      ctx,
      { workspaceId: "ws-outbox-dedup", kind: "decision", content: "use Postgres" },
      auth
    );

    expect(res.vectorSearchable).toBe(true);
  });

  it("reports vectorSearchable: false for a kind outside RECALLABLE_KINDS (never indexed)", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    // P65: this used `episode`, which IS recallable now — the assertion was
    // pinning a fact about the registry's contents, not about the mechanism.
    // `entity` is the durable example: it stays out of RECALLABLE_KINDS on
    // purpose because it has its own pre-existing similarity path
    // (findSimilarEntities, P16), so it exercises the "not in the registry"
    // branch without depending on which kinds happen to be in it today.
    expect(RECALLABLE_KINDS as readonly string[]).not.toContain("entity");

    const res = await remember(
      ctx,
      { workspaceId: "ws-outbox-dedup", kind: "entity", content: "Acme Corp" },
      auth
    );

    expect(res.vectorSearchable).toBe(false);
  });
});
