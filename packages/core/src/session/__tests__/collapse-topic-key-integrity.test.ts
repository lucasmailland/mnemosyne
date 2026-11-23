/**
 * LIFECYCLE-3 / LIFECYCLE-4 — the collapse must not lose knowledge to its own
 * topic-key handling.
 *
 * LIFECYCLE-3 (P153): every keyed fact went straight to `mergeFactByTopicKey`,
 * including rows the SAME pass had just written. Six distinct facts the model
 * put under one key became one live fact (the last), and three decisions under
 * one key became one. Measured on the real pipeline with a 4B model.
 *
 * LIFECYCLE-4 (P76 in collapse): the surprise gate ran BEFORE the topic merge.
 * "300 → 500 requests per minute" is the textbook low-PE, high-importance
 * update: cosine 0.92+, so PE ≈ 0.08 < 0.15 and the update was dropped while the
 * stale 300 stayed live. `remember()` was fixed for this; the collapse was not.
 */
import { describe, it, expect } from "vitest";
import { collapseSession, resolveTopicKeyCollisions } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

describe("LIFECYCLE-3 — a topicKey repeated inside one pass", () => {
  it("keeps three distinct facts that the model put under one key", async () => {
    const h = makeHarness({
      replies: [
        reply({
          facts: [
            { content: "ledger-api deploys only on Tuesdays", topicKey: "ledger-api-deploy" },
            { content: "ledger-api deploys need two approvals", topicKey: "ledger-api-deploy" },
            { content: "ledger-api deploys are frozen in December", topicKey: "ledger-api-deploy" },
          ],
        }),
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(result.factsCreated).toBe(3);
    expect(
      h
        .activeFacts()
        .map((f) => f.statement)
        .sort()
    ).toEqual([
      "ledger-api deploys are frozen in December",
      "ledger-api deploys need two approvals",
      "ledger-api deploys only on Tuesdays",
    ]);
    // The ambiguous key is dropped from all three, so none supersedes another.
    expect(h.storage.mergeFactByTopicKey).not.toHaveBeenCalled();
  });

  it("collapses an exact repeat of the same keyed fact into one row", async () => {
    const h = makeHarness({
      replies: [
        reply({
          facts: [
            { content: "Redis TTL is 15 minutes", topicKey: "redis-ttl" },
            { content: "redis ttl is 15  minutes ", topicKey: "Redis-TTL " },
          ],
        }),
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(1);
    expect(h.activeFacts()).toHaveLength(1);
    expect(h.activeFacts()[0]!.topicKey).toBe("redis-ttl");
  });

  it("does not supersede an existing row under an ambiguous key", async () => {
    const h = makeHarness({
      seedFacts: [{ statement: "auth-gateway signs JWTs with RS256", topicKey: "auth-gateway" }],
      replies: [
        reply({
          facts: [
            { content: "auth-gateway caches tokens in Redis", topicKey: "auth-gateway" },
            { content: "auth-gateway rejects tokens older than 1 h", topicKey: "auth-gateway" },
          ],
        }),
      ],
    });

    await collapseSession(input, h.ctx, auth);

    const statements = h.activeFacts().map((f) => f.statement);
    expect(statements).toContain("auth-gateway signs JWTs with RS256");
    expect(statements).toContain("auth-gateway caches tokens in Redis");
    expect(statements).toContain("auth-gateway rejects tokens older than 1 h");
    expect(h.activeFacts()).toHaveLength(3);
  });

  it("keeps distinct decisions whose keys differ only by case or whitespace", async () => {
    const h = makeHarness({
      replies: [
        reply({
          decisions: [
            { title: "Deploy with Argo", body: "GitOps", kind: "process", topicKey: "deploy-tool" },
            { title: "Pin Helm 3.14", body: "breaking", kind: "config", topicKey: " Deploy-Tool" },
            { title: "No Friday deploys", body: "risk", kind: "policy", topicKey: "DEPLOY-TOOL" },
          ],
        }),
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.decisionsCreated).toBe(3);
    expect(h.activeDecisions()).toHaveLength(3);
    expect(h.storage.mergeDecisionByTopicKey).not.toHaveBeenCalled();
  });

  it("resolveTopicKeyCollisions: exact repeats merge, distinct items lose the key", () => {
    const out = resolveTopicKeyCollisions(
      [
        { content: "a", topicKey: "k" },
        { content: "A ", topicKey: "K" },
        { content: "b", topicKey: "j" },
        { content: "c", topicKey: "j" },
        { content: "d" },
      ],
      (item) => item.content
    );
    expect(out).toEqual([
      { content: "a", topicKey: "k" },
      { content: "b" },
      { content: "c" },
      { content: "d" },
    ]);
  });
});

describe("LIFECYCLE-4 — a keyed value update is not 'already known'", () => {
  it("supersedes 300 with 500 even though the surprise gate scores it as known", async () => {
    const h = makeHarness({
      seedFacts: [
        {
          statement: "The orders-api rate limit is 300 requests per minute per API key.",
          topicKey: "orders-api-rate-limit",
        },
      ],
      // PE = 1 - 0.99 = 0.01, far below the 0.15 threshold.
      similarity: () => 0.99,
      replies: [
        reply({
          facts: [
            {
              content: "The orders-api rate limit is 500 requests per minute per API key.",
              topicKey: "orders-api-rate-limit",
            },
          ],
        }),
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(1);
    const live = h.activeFacts();
    expect(live).toHaveLength(1);
    expect(live[0]!.statement).toContain("500");
  });

  // WP-4 request to WP-5, applied at integration: the successor belongs to THIS
  // session (so this collapse links it to its episode), not to the session of
  // the fact it supersedes.
  it("hands the merge this session's id and the collapse provenance", async () => {
    const h = makeHarness({
      seedFacts: [
        {
          statement: "The orders-api rate limit is 300 requests per minute per API key.",
          topicKey: "orders-api-rate-limit",
          sessionId: "an-earlier-session",
        },
      ],
      similarity: () => 0.99,
      replies: [
        reply({
          facts: [
            {
              content: "The orders-api rate limit is 500 requests per minute per API key.",
              topicKey: "orders-api-rate-limit",
            },
          ],
        }),
      ],
    });

    await collapseSession(input, h.ctx, auth);

    expect(h.storage.mergeFactByTopicKey).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: input.sessionId, extractionSource: "collapse" })
    );
  });

  it("does not write a revision when the keyed statement is unchanged", async () => {
    const h = makeHarness({
      seedFacts: [{ statement: "Redis TTL is 15 minutes", topicKey: "redis-ttl" }],
      similarity: () => 1,
      replies: [reply({ facts: [{ content: "Redis TTL is 15 minutes", topicKey: "redis-ttl" }] })],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(0);
    expect(h.storage.mergeFactByTopicKey).not.toHaveBeenCalled();
    expect(h.activeFacts()).toHaveLength(1);
  });

  it("still applies the surprise gate to a keyed fact with nothing to supersede", async () => {
    const h = makeHarness({
      similarity: () => 0.99,
      replies: [reply({ facts: [{ content: "already said elsewhere", topicKey: "fresh-key" }] })],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(0);
    expect(h.storage.createFact).not.toHaveBeenCalled();
  });

  it("still applies the surprise gate to keyless facts", async () => {
    const h = makeHarness({
      similarity: () => 0.99,
      replies: [reply({ facts: [{ content: "a paraphrase of something known" }] })],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.factsCreated).toBe(0);
  });
});
