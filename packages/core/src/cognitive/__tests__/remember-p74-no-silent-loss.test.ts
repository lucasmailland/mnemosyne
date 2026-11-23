import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import { forget } from "../forget.js";
import type { AuthContext } from "@mnemo-ai/types";

// P74 — regression guards for the silent write loss on the surprise-gated path.
//
// The gate used to divert every low-prediction-error write into a
// `staging_evaluation` outbox job and return a fabricated crypto.randomUUID().
// Three independent breakages made that a total loss of the content:
//   1. the payload was written flat while OutboxWorker destructures
//      `{ job, data, opts }`, so `{}` was enqueued and the content never
//      travelled;
//   2. no consumer was ever registered for the job, and the in-memory queue
//      no-ops silently when no handler exists;
//   3. the returned id matched no row, so forget/relate reported success
//      against a phantom.
// No `staged` table exists in the schema either, so nothing could have
// promoted the content later.
//
// The old behaviour had ZERO test coverage — every existing remember() test
// sets `surpriseThreshold: 0`, which disables the gate outright. That is why
// these guards pin the low-PE path specifically.

const auth: AuthContext = {
  workspaceId: "ws-p74",
  actorId: "agent-p74",
  actorType: "agent",
  scopes: ["memory:write", "memory:delete"] as never,
};

/**
 * `neighbourScore` drives the gate: pe = 1 - maxSim. A 0.99 neighbour yields
 * pe = 0.01, comfortably under the 0.15 threshold, which is exactly the case
 * the old code discarded.
 */
function makeCtx(
  storage: InMemoryStorageAdapter,
  opts: { neighbourScore?: number; anomalyScoreThreshold?: number } = {}
) {
  const neighbourScore = opts.neighbourScore;
  return {
    storage,
    vector: {
      search: async () =>
        neighbourScore === undefined ? [] : [{ id: "neighbour-1", score: neighbourScore }],
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
      surpriseThreshold: 0.15,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: opts.anomalyScoreThreshold ?? 0.8,
    },
  } as never;
}

function queueJobs(storage: InMemoryStorageAdapter) {
  return storage.outbox.filter((e) => e.eventType === "queue_job");
}

describe("remember(): low prediction error no longer discards the write (P74)", () => {
  it("persists a real row whose id resolves, instead of returning a fabricated uuid", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbourScore: 0.99 });

    const res = await remember(
      ctx,
      { workspaceId: "ws-p74", kind: "fact", content: "we use Postgres" },
      auth
    );

    expect(res.staged).toBe(false);
    // The core of the bug: the returned id used to match no row at all.
    const saved = await storage.getFact(res.id, "ws-p74");
    expect(saved).not.toBeNull();
    expect(saved?.statement).toBe("we use Postgres");
  });

  it("never enqueues a staging_evaluation job — the producer is gone", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbourScore: 0.99 });

    await remember(ctx, { workspaceId: "ws-p74", kind: "fact", content: "we use Redis" }, auth);

    const staging = queueJobs(storage).filter(
      (e) => (e.payload as { job?: string }).job === "staging_evaluation"
    );
    expect(staging).toHaveLength(0);
  });

  it("records the prediction error on the audit entry, not on caller metadata", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbourScore: 0.99 });

    const res = await remember(
      ctx,
      { workspaceId: "ws-p74", kind: "fact", content: "we deploy on Fridays" },
      auth
    );

    const saved = await storage.getFact(res.id, "ws-p74");
    // metadata belongs to the caller and round-trips back to them.
    expect(saved?.metadata).not.toHaveProperty("predictionError");

    const created = storage.auditLog.filter(
      (a) => a.action === "create" && a.resourceId === res.id
    );
    expect(created).toHaveLength(1);
    const detail = created[0]!.detail as { pe: number; lowSurprise: boolean; staged: boolean };
    expect(detail.staged).toBe(false);
    expect(detail.lowSurprise).toBe(true);
    expect(detail.pe).toBeLessThan(0.15);
  });

  it("marks a genuinely novel write as high surprise", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage); // no neighbours at all → pe = 1.0

    const res = await remember(
      ctx,
      { workspaceId: "ws-p74", kind: "fact", content: "something nobody has said" },
      auth
    );

    const created = storage.auditLog.filter(
      (a) => a.action === "create" && a.resourceId === res.id
    );
    const detail = created[0]!.detail as { lowSurprise: boolean };
    expect(detail.lowSurprise).toBe(false);
  });
});

// P74 fixed this producer's payload shape; P111 removed the producer entirely.
// No `queue.process` handler was ever registered for `anomaly_review`, so a
// flagged anomaly went nowhere whatever shape it had. The flag now writes
// `mnemo_review_item`, the same durable queue the §33 contradiction review and
// the §34.7 abuse flag use. This test tracked the shape; it now tracks the
// destination, plus a guard against regressing to the orphaned job.
describe("remember(): a flagged anomaly reaches a queue someone reads (P111)", () => {
  it("writes a review item pointing at the created primitive", async () => {
    const storage = new InMemoryStorageAdapter();
    // threshold 0 forces the anomaly branch without depending on scorer internals.
    const ctx = makeCtx(storage, { neighbourScore: 0.99, anomalyScoreThreshold: 0 });

    const res = await remember(
      ctx,
      { workspaceId: "ws-p74", kind: "fact", content: "an anomalous statement" },
      auth
    );

    const reviews = storage.reviewItems.filter((r) => r.reason === "anomaly");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.primitiveId).toBe(res.id);
    expect((reviews[0]!.detail as { anomalyScore?: number }).anomalyScore).toBeGreaterThanOrEqual(
      0
    );
  });

  it("no longer enqueues the orphaned anomaly_review job", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { neighbourScore: 0.99, anomalyScoreThreshold: 0 });

    await remember(
      ctx,
      { workspaceId: "ws-p74", kind: "fact", content: "another anomalous statement" },
      auth
    );

    expect(
      queueJobs(storage).filter((e) => (e.payload as { job?: string }).job === "anomaly_review")
    ).toHaveLength(0);
  });
});

describe("forget(): stops confirming deletions that never happened (P74)", () => {
  it("throws NOT_FOUND for a primitive id that matches no row", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    await expect(
      forget(ctx, "00000000-0000-4000-8000-000000000000", "decision", "soft", auth)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("still archives a primitive that does exist", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const res = await remember(
      ctx,
      { workspaceId: "ws-p74", kind: "fact", content: "a fact worth forgetting" },
      auth
    );

    await expect(forget(ctx, res.id, "fact", "soft", auth)).resolves.toBeUndefined();
  });
});
