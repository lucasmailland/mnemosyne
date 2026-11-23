import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

// auto-trigger-scoped-consolidation (design.md D1-D3): remember() appends one
// extra `queue_job` outbox row — `scoped_semantic_conflict_check` — for fact
// writes with a write-time neighbour at cosine similarity >= 0.85, reusing
// the SAME vector.search call fetchNeighbours already runs (no second
// search). The payload MUST use the nested `data` envelope: OutboxWorker's
// `queue_job` case destructures `{ job, data, opts }` and enqueues
// `data ?? {}` — a flat payload would deliver `{}` to the handler.

const auth: AuthContext = {
  workspaceId: "ws-scoped-conflict",
  actorId: "agent-scoped-conflict",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

function makeCtx(
  storage: InMemoryStorageAdapter,
  opts: {
    neighbours?: Array<{ id: string; score: number }>;
    scopedConflictCheckEnabled?: boolean;
    writeConflictClassification?: boolean;
  } = {}
) {
  const neighbours = opts.neighbours ?? [];
  return {
    storage,
    vector: {
      search: async () => neighbours,
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
      ...(opts.scopedConflictCheckEnabled !== undefined
        ? { scopedConflictCheckEnabled: opts.scopedConflictCheckEnabled }
        : {}),
      ...(opts.writeConflictClassification !== undefined
        ? { writeConflictClassification: opts.writeConflictClassification }
        : {}),
    },
  } as never;
}

function scopedConflictJobsFor(storage: InMemoryStorageAdapter, factId: string) {
  return storage.outbox.filter(
    (e) =>
      e.eventType === "queue_job" &&
      (e.payload as { job?: string }).job === "scoped_semantic_conflict_check" &&
      (e.payload as { data?: { factId?: string } }).data?.factId === factId
  );
}

describe("remember(): scoped semantic conflict check outbox append", () => {
  it("fires with the nested data envelope when a qualifying neighbour exists", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbours: [{ id: "fact-neighbour-1", score: 0.9 }] });

    const res = await remember(
      ctx,
      { workspaceId: "ws-scoped-conflict", kind: "fact", content: "the sky is blue" },
      auth
    );

    const jobs = scopedConflictJobsFor(storage, res.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      job: "scoped_semantic_conflict_check",
      data: {
        factId: res.id,
        workspaceId: "ws-scoped-conflict",
        candidates: [{ id: "fact-neighbour-1", score: 0.9 }],
      },
    });
  });

  it("does not append when scopedConflictCheckEnabled is false", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, {
      neighbours: [{ id: "fact-neighbour-1", score: 0.9 }],
      scopedConflictCheckEnabled: false,
    });

    const res = await remember(
      ctx,
      { workspaceId: "ws-scoped-conflict", kind: "fact", content: "the sky is blue" },
      auth
    );

    expect(scopedConflictJobsFor(storage, res.id)).toHaveLength(0);
  });

  it("does not append for a non-fact primitive kind", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbours: [{ id: "fact-neighbour-1", score: 0.95 }] });

    const res = await remember(
      ctx,
      { workspaceId: "ws-scoped-conflict", kind: "decision", content: "use Postgres" },
      auth
    );

    expect(scopedConflictJobsFor(storage, res.id)).toHaveLength(0);
  });

  it("does not append when no neighbour clears the 0.85 threshold", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbours: [{ id: "fact-neighbour-1", score: 0.5 }] });

    const res = await remember(
      ctx,
      { workspaceId: "ws-scoped-conflict", kind: "fact", content: "the sky is blue" },
      auth
    );

    expect(scopedConflictJobsFor(storage, res.id)).toHaveLength(0);
  });

  it("carries the §33 candidates the write could not classify, next to the neighbours", async () => {
    // WP-7: with no LLM on the write path, a §33 candidate gets no verdict and
    // no conflict at write time. It rides to this job instead — the scoped
    // check is now the fallback classifier — alongside the close neighbours.
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, {
      neighbours: [{ id: "fact-neighbour-1", score: 0.9 }],
      writeConflictClassification: true,
    });

    // Seed an existing fact on the SAME subject so §33's findContradictingFacts
    // (same-subject / FTS lexical) fires and produces a conflict candidate — a
    // population disjoint from the vector neighbourhood mocked above.
    const existing = await storage.createFact({
      workspaceId: "ws-scoped-conflict",
      scope: "global",
      kind: "other",
      subject: "deploy-target",
      statement: "we deploy to AWS",
      attribution: "inferred",
    });

    const res = await remember(
      ctx,
      {
        workspaceId: "ws-scoped-conflict",
        kind: "fact",
        content: "we deploy to GCP",
        subject: "deploy-target",
        provenance: "objective_fact",
      },
      auth
    );

    // No verdict, so nothing to judge at write time.
    expect(res.conflict).toBeUndefined();
    const jobs = scopedConflictJobsFor(storage, res.id);
    expect(jobs).toHaveLength(1);
    const ids = (
      jobs[0]?.payload as { data: { candidates: Array<{ id: string }> } }
    ).data.candidates.map((c) => c.id);
    expect(ids).toEqual(["fact-neighbour-1", existing.id]);
  });

  it("with write-time classification off (the default), carries only the close neighbours", async () => {
    // Deferring the §33 candidates would only move the classifier's LLM calls
    // to this job; off means the write pays none of them.
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbours: [{ id: "fact-neighbour-1", score: 0.9 }] });
    await storage.createFact({
      workspaceId: "ws-scoped-conflict",
      scope: "global",
      kind: "other",
      subject: "deploy-target",
      statement: "we deploy to AWS",
      attribution: "inferred",
    });

    const res = await remember(
      ctx,
      {
        workspaceId: "ws-scoped-conflict",
        kind: "fact",
        content: "we deploy to GCP",
        subject: "deploy-target",
        provenance: "objective_fact",
      },
      auth
    );

    expect(res.conflict).toBeUndefined();
    const jobs = scopedConflictJobsFor(storage, res.id);
    expect(jobs).toHaveLength(1);
    const ids = (
      jobs[0]?.payload as { data: { candidates: Array<{ id: string }> } }
    ).data.candidates.map((c) => c.id);
    expect(ids).toEqual(["fact-neighbour-1"]);
  });
});
