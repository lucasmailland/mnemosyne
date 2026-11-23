/**
 * Review round (Codex, high) — the surprise gate must not throw away a close
 * contradiction before the conflict check can see it.
 *
 * With the DEFAULT threshold (0.15), "auth-gateway now signs JWTs with EdDSA"
 * scores ~0.90 against "auth-gateway signs JWTs with RS256": PE 0.10, so the
 * new value was discarded as "already known" and the scoped conflict check
 * never ran. The earlier tests lowered the threshold and hid this.
 *
 * A low-PE fact is now a duplicate only if it says nothing its close
 * neighbours do not: when it carries value-like tokens (numbers, identifiers
 * such as RS256 or EdDSA) that a close neighbour lacks AND that neighbour
 * carries ones it lacks, the value changed — it is kept and checked.
 */
import { describe, it, expect } from "vitest";
import { collapseSession, isValueChange } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

const jobsOf = (outbox: Array<Record<string, unknown>>) =>
  outbox.filter((e) => (e.payload as { job?: string }).job === "scoped_semantic_conflict_check");

describe("default surprise gate vs close contradictions", () => {
  it("keeps a keyless value change and queues its conflict check", async () => {
    const h = makeHarness({
      seedFacts: [{ id: "rs256", statement: "auth-gateway signs JWTs with RS256" }],
      neighbourId: "rs256",
      similarity: () => 0.9,
      replies: [reply({ facts: [{ content: "auth-gateway now signs JWTs with EdDSA" }] })],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(1);
    const jobs = jobsOf(h.outbox);
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.payload as { data: { candidates: unknown } }).data.candidates).toEqual([
      { id: "rs256", score: 0.9 },
    ]);
  });

  it("keeps a keyed value change that has no predecessor under its key", async () => {
    const h = makeHarness({
      seedFacts: [{ id: "old", statement: "the orders-api rate limit is 300 requests per minute" }],
      neighbourId: "old",
      similarity: () => 0.95,
      replies: [
        reply({
          facts: [
            {
              content: "the orders-api rate limit is 500 requests per minute",
              topicKey: "orders-api-rate-limit",
            },
          ],
        }),
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(1);
    expect(jobsOf(h.outbox)).toHaveLength(1);
  });

  it("still discards a paraphrase that changes no value", async () => {
    const h = makeHarness({
      seedFacts: [{ id: "ttl", statement: "Tokens are cached in Redis for 1 hour" }],
      neighbourId: "ttl",
      similarity: () => 0.95,
      replies: [reply({ facts: [{ content: "Session tokens are cached in Redis for 1 hour." }] })],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(0);
    expect(jobsOf(h.outbox)).toHaveLength(0);
  });
});

describe("isValueChange", () => {
  it("sees replaced numbers and identifiers", () => {
    expect(isValueChange("signs with EdDSA", "signs with RS256")).toBe(true);
    expect(isValueChange("limit is 500/min", "limit is 300/min")).toBe(true);
    expect(isValueChange("corre en PostgreSQL 17", "corre en PostgreSQL 15")).toBe(true);
  });

  it("ignores rewording around the same values", () => {
    expect(isValueChange("Redis caches tokens for 1 hour", "tokens live 1 hour in Redis")).toBe(
      false
    );
    expect(isValueChange("added Node 20 support", "runs on Node 20 and Postgres")).toBe(false);
  });
});
