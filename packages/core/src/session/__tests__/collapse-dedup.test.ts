/**
 * RDD-4 — Hybrid per-turn/collapse dedup gate.
 *
 * In hybrid mode, collapse must skip any candidate fact whose topic_key already
 * exists among per-turn facts for the same session (extractionSource="per_turn").
 * This prevents double-writing: per-turn write + collapse write = duplicate.
 *
 * Spec ref: MEMORY_MODEL.md §Resolved Design Decisions ~line 3459-3483.
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext } from "@mnemo-ai/types";

const auth = {
  actorId: "system",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

function makeTurns(n = 4) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: i === n - 1 ? "thanks, that worked perfectly" : `message ${i}`,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    // First turn is pinned — required for hybrid mode (requirePin=true in hybrid)
    pinned: i === 0,
  }));
}

function makeCtx(
  opts: {
    perTurnTopicKeys?: string[];
    llmFacts?: Array<{ content: string; topicKey?: string; confidence?: number }>;
  } = {}
) {
  const perTurnTopicKeys = opts.perTurnTopicKeys ?? [];
  const llmFacts = opts.llmFacts ?? [
    { content: "deploy-region is us-east-1", topicKey: "deploy-region", confidence: 0.9 },
    { content: "redis version is 7.2", topicKey: "redis-version", confidence: 0.85 },
  ];

  const createFact = vi.fn(async (inp: Record<string, unknown>) => ({
    id: `f-${String(inp.topicKey ?? "anon")}`,
    ...inp,
  }));
  const listSessionTopicKeysBySource = vi.fn(async () => perTurnTopicKeys);

  const summary = {
    goal: "configure infra",
    outcome: "resolved",
    facts: llmFacts,
    decisions: [],
    strategies: [],
    llmTokensUsed: 10,
  };

  const ctx = {
    config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
    vector: { search: async () => [] },
    llm: {
      generate: async () => ({
        content: JSON.stringify(summary),
        tokensUsed: { input: 10, output: 10 },
      }),
    },
    cache: null,
    outbox: { append: async () => {} },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: "ws",
        agentId: "a",
        status: "active",
        turnCount: 4,
        tokenCount: 50,
        openedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        metadata: {},
      }),
      listTurns: async () => makeTurns(),
      createFact,
      // P125: collapse now routes a topicKey'd fact through the upsert before
      // inserting. `null` = nothing to merge into, i.e. this double keeps its
      // previous create-everything behaviour; it is here so the double covers
      // the port method the code actually calls.
      mergeFactByTopicKey: async () => null,
      createDecision: async () => ({ id: "d" }),
      createStrategy: async () => ({ id: "st" }),
      createRelation: async () => ({ id: "r" }),
      closeSession: async () => {},
      listSessionTopicKeysBySource,
    },
  } as unknown as CoreContext;

  return { ctx, createFact, listSessionTopicKeysBySource };
}

describe("RDD-4: hybrid collapse dedup gate", () => {
  it("in non-hybrid mode: does not call listSessionTopicKeysBySource", async () => {
    const { ctx, listSessionTopicKeysBySource } = makeCtx({
      perTurnTopicKeys: ["deploy-region"],
    });

    const result = await collapseSession(
      {
        sessionId: "s1",
        workspaceId: "ws",
        agentId: "a",
        reason: "max_turns",
        policy: { mode: "auto" },
      },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    expect(listSessionTopicKeysBySource).not.toHaveBeenCalled();
    // Both facts created (no dedup in auto mode)
    expect(result.factsCreated).toBe(2);
  });

  it("in hybrid mode: skips collapse fact whose topic_key is covered by per-turn", async () => {
    const { ctx, createFact } = makeCtx({
      // "deploy-region" already extracted per-turn
      perTurnTopicKeys: ["deploy-region"],
    });

    const result = await collapseSession(
      {
        sessionId: "s1",
        workspaceId: "ws",
        agentId: "a",
        reason: "max_turns",
        policy: { mode: "hybrid" },
      },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    // Only redis-version should be created; deploy-region is deduped
    expect(result.factsCreated).toBe(1);
    const createdKeys = createFact.mock.calls.map((c) => c[0].topicKey);
    expect(createdKeys).not.toContain("deploy-region");
    expect(createdKeys).toContain("redis-version");
  });

  it("in hybrid mode: creates fact with new topic_key not covered by per-turn", async () => {
    const { ctx, createFact } = makeCtx({
      // Neither fact covered per-turn
      perTurnTopicKeys: [],
    });

    const result = await collapseSession(
      {
        sessionId: "s1",
        workspaceId: "ws",
        agentId: "a",
        reason: "max_turns",
        policy: { mode: "hybrid" },
      },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    expect(result.factsCreated).toBe(2);
    const createdKeys = createFact.mock.calls.map((c) => c[0].topicKey);
    expect(createdKeys).toContain("deploy-region");
    expect(createdKeys).toContain("redis-version");
  });

  it("in hybrid mode with collapseSkipsExisting=false: does not skip even covered topics", async () => {
    const { ctx, createFact } = makeCtx({
      perTurnTopicKeys: ["deploy-region", "redis-version"],
    });

    const result = await collapseSession(
      {
        sessionId: "s1",
        workspaceId: "ws",
        agentId: "a",
        reason: "max_turns",
        policy: { mode: "hybrid", hybridPolicy: { collapseSkipsExisting: false } },
      },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    // collapseSkipsExisting=false → dedup gate disabled → both facts written
    expect(result.factsCreated).toBe(2);
    expect(createFact).toHaveBeenCalledTimes(2);
  });

  it("in hybrid mode: facts without topic_key are never skipped by dedup gate", async () => {
    const { ctx, createFact } = makeCtx({
      perTurnTopicKeys: ["deploy-region"],
      llmFacts: [
        // no topicKey — cannot be deduped
        { content: "some anonymous fact", confidence: 0.9 },
        { content: "deploy-region is eu-west-1", topicKey: "deploy-region", confidence: 0.8 },
      ],
    });

    const result = await collapseSession(
      {
        sessionId: "s1",
        workspaceId: "ws",
        agentId: "a",
        reason: "max_turns",
        policy: { mode: "hybrid" },
      },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    // anonymous fact created, deploy-region skipped
    expect(result.factsCreated).toBe(1);
    const createdContents = createFact.mock.calls.map((c) => c[0].statement);
    expect(createdContents).toContain("some anonymous fact");
  });
});
