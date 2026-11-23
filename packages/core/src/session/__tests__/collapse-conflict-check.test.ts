/**
 * LIFECYCLE-11 (collapse half; raised by WP-7) — facts the collapse writes get
 * the same write-time conflict check as `remember()`.
 *
 * Measured: after a session said auth-gateway "now signs with EdDSA", the
 * seeded "signs JWTs with RS256" fact stayed active with no relation — the
 * collapse persists through createFact/mergeFactByTopicKey and never ran a
 * conflict check. `remember()` enqueues a `scoped_semantic_conflict_check`
 * job for its close neighbours (cosine ≥ 0.85, at most 3); the collapse now
 * enqueues the same job, in the same transaction as the fact.
 */
import { describe, it, expect } from "vitest";
import { collapseSession } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

const jobsOf = (outbox: Array<Record<string, unknown>>) =>
  outbox.filter(
    (e) =>
      e.eventType === "queue_job" &&
      (e.payload as { job?: string }).job === "scoped_semantic_conflict_check"
  );

describe("collapse → scoped semantic conflict check", () => {
  it("enqueues the check for a new fact with a close neighbour", async () => {
    const h = makeHarness({
      // Default threshold (0.15): the neighbour is a real, value-changing fact.
      seedFacts: [{ id: "neighbour", statement: "auth-gateway signs JWTs with RS256" }],
      similarity: () => 0.9,
      replies: [reply({ facts: [{ content: "auth-gateway now signs JWTs with EdDSA" }] })],
    });

    await collapseSession(input, h.ctx, auth);

    const jobs = jobsOf(h.outbox);
    expect(jobs).toHaveLength(1);
    const data = (jobs[0]!.payload as { data: Record<string, unknown> }).data;
    expect(data).toEqual({
      factId: h.activeFacts().find((f) => f.statement.includes("EdDSA"))!.id,
      workspaceId: "ws",
      candidates: [{ id: "neighbour", score: 0.9 }],
    });
  });

  it("enqueues it for a keyed value update too", async () => {
    const h = makeHarness({
      seedFacts: [{ statement: "rate limit is 300/min", topicKey: "orders-api-rate-limit" }],
      similarity: () => 0.99,
      replies: [
        reply({ facts: [{ content: "rate limit is 500/min", topicKey: "orders-api-rate-limit" }] }),
      ],
    });

    await collapseSession(input, h.ctx, auth);

    expect(jobsOf(h.outbox)).toHaveLength(1);
  });

  it("enqueues nothing without a close neighbour", async () => {
    const h = makeHarness({
      similarity: () => 0.5,
      replies: [reply({ facts: [{ content: "something unrelated" }] })],
    });

    await collapseSession(input, h.ctx, auth);

    expect(jobsOf(h.outbox)).toHaveLength(0);
  });

  it("honours the scopedConflictCheckEnabled kill switch", async () => {
    const h = makeHarness({
      // Default threshold (0.15): the neighbour is a real, value-changing fact.
      seedFacts: [{ id: "neighbour", statement: "auth-gateway signs JWTs with RS256" }],
      similarity: () => 0.9,
      replies: [reply({ facts: [{ content: "auth-gateway now signs JWTs with EdDSA" }] })],
    });
    (h.ctx.config as { scopedConflictCheckEnabled?: boolean }).scopedConflictCheckEnabled = false;

    await collapseSession(input, h.ctx, auth);

    expect(jobsOf(h.outbox)).toHaveLength(0);
  });

  it("rolls the job back with the fact when the collapse fails", async () => {
    const h = makeHarness({
      atomic: true,
      // Default threshold (0.15): the neighbour is a real, value-changing fact.
      seedFacts: [{ id: "neighbour", statement: "auth-gateway signs JWTs with RS256" }],
      similarity: () => 0.9,
      replies: [
        reply({
          facts: [{ content: "auth-gateway now signs JWTs with EdDSA" }],
          strategies: [{ trigger: "t", action: "a" }],
        }),
      ],
    });
    h.storage.createStrategy.mockRejectedValueOnce(new Error("injected"));

    await expect(collapseSession(input, h.ctx, auth)).rejects.toThrow();

    expect(jobsOf(h.outbox)).toHaveLength(0);
  });
});
