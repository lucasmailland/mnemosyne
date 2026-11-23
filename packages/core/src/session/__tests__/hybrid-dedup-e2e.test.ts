/**
 * RDD-4 E2E test: Hybrid per-turn/collapse dedup gate end-to-end.
 *
 * This test verifies that:
 * 1. Per-turn extraction tags facts with extraction_source="per_turn"
 * 2. Collapse dedup gate skips facts whose topic_key exists in per-turn set
 * 3. Both per-turn and collapse extraction work together without duplicates
 *
 * Spec ref: MEMORY_MODEL.md §Resolved Design Decisions ~line 3459-3483.
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext, CreateFactInput } from "@mnemo-ai/types";

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
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: i === n - 1 ? "thanks, that worked perfectly" : `message ${i}`,
    createdAt: new Date(), // determinism-ok: throwaway fixture, not asserted
    pinned: i === 0, // First turn pinned for hybrid mode requirePin
  }));
}

describe("RDD-4: hybrid per-turn/collapse dedup E2E", () => {
  it("prevents duplicate facts when per-turn extraction runs before collapse", async () => {
    // Simulate per-turn facts already created
    const perTurnFacts: Array<CreateFactInput & { id: string; extractionSource: string }> = [
      {
        id: "f-per-turn-deploy",
        workspaceId: "ws",
        agentId: "a",
        scope: "global",
        statement: "deploy-region is us-east-1",
        subject: "general",
        kind: "other",
        confidence: 0.9,
        sessionId: "s1",
        topicKey: "deploy-region",
        extractionSource: "per_turn",
      },
    ];

    const createFactCalls: Array<CreateFactInput> = [];
    const createFact = vi.fn(async (inp: CreateFactInput) => {
      createFactCalls.push(inp);
      return {
        id: `f-${String(inp.topicKey ?? "anon")}`,
        ...inp,
      };
    });

    // Mock storage that simulates per-turn facts already existing
    const listSessionTopicKeysBySource = vi.fn(async (ws: string, sid: string, source: string) => {
      if (source === "per_turn") {
        return perTurnFacts
          .filter((f) => f.workspaceId === ws && f.sessionId === sid)
          .map((f) => f.topicKey)
          .filter((k): k is string => k !== undefined);
      }
      return [];
    });

    // Collapse will extract these 2 facts from LLM
    const collapseLlmFacts = [
      { content: "deploy-region is us-east-1", topicKey: "deploy-region", confidence: 0.9 },
      { content: "redis version is 7.2", topicKey: "redis-version", confidence: 0.85 },
    ];

    const summary = {
      goal: "configure infra",
      outcome: "resolved" as const,
      facts: collapseLlmFacts,
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
          status: "active" as const,
          turnCount: 4,
          tokenCount: 50,
          openedAt: new Date(), // determinism-ok: throwaway fixture, not asserted
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

    // Verify listSessionTopicKeysBySource was called
    expect(listSessionTopicKeysBySource).toHaveBeenCalledWith("ws", "s1", "per_turn");

    // Verify only redis-version was created (deploy-region was skipped due to dedup)
    expect(result.factsCreated).toBe(1);
    expect(createFactCalls.length).toBe(1);

    const createdTopicKeys = createFactCalls.map((c) => c.topicKey);
    expect(createdTopicKeys).not.toContain("deploy-region");
    expect(createdTopicKeys).toContain("redis-version");

    // Verify the created fact has extractionSource="collapse"
    expect(createFactCalls[0].extractionSource).toBe("collapse");
  });

  it("creates both facts when per-turn extraction did not cover them", async () => {
    const createFactCalls: Array<CreateFactInput> = [];
    const createFact = vi.fn(async (inp: CreateFactInput) => {
      createFactCalls.push(inp);
      return {
        id: `f-${String(inp.topicKey ?? "anon")}`,
        ...inp,
      };
    });

    // No per-turn facts exist
    const listSessionTopicKeysBySource = vi.fn(async () => []);

    const collapseLlmFacts = [
      { content: "deploy-region is us-east-1", topicKey: "deploy-region", confidence: 0.9 },
      { content: "redis version is 7.2", topicKey: "redis-version", confidence: 0.85 },
    ];

    const summary = {
      goal: "configure infra",
      outcome: "resolved" as const,
      facts: collapseLlmFacts,
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
          status: "active" as const,
          turnCount: 4,
          tokenCount: 50,
          openedAt: new Date(), // determinism-ok: throwaway fixture, not asserted
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
    expect(createFactCalls.length).toBe(2);

    const createdTopicKeys = createFactCalls.map((c) => c.topicKey);
    expect(createdTopicKeys).toContain("deploy-region");
    expect(createdTopicKeys).toContain("redis-version");
  });

  it("respects collapseSkipsExisting=false to allow duplicates", async () => {
    // Simulate per-turn facts already created
    const perTurnFacts = [
      {
        id: "f-per-turn-deploy",
        workspaceId: "ws",
        sessionId: "s1",
        topicKey: "deploy-region",
        extractionSource: "per_turn",
      },
      {
        id: "f-per-turn-redis",
        workspaceId: "ws",
        sessionId: "s1",
        topicKey: "redis-version",
        extractionSource: "per_turn",
      },
    ];

    const createFactCalls: Array<CreateFactInput> = [];
    const createFact = vi.fn(async (inp: CreateFactInput) => {
      createFactCalls.push(inp);
      return {
        id: `f-${String(inp.topicKey ?? "anon")}`,
        ...inp,
      };
    });

    const listSessionTopicKeysBySource = vi.fn(async (ws: string, sid: string, source: string) => {
      if (source === "per_turn") {
        return perTurnFacts
          .filter((f) => f.workspaceId === ws && f.sessionId === sid)
          .map((f) => f.topicKey)
          .filter((k): k is string => k !== undefined);
      }
      return [];
    });

    const collapseLlmFacts = [
      { content: "deploy-region is us-east-1", topicKey: "deploy-region", confidence: 0.9 },
      { content: "redis version is 7.2", topicKey: "redis-version", confidence: 0.85 },
    ];

    const summary = {
      goal: "configure infra",
      outcome: "resolved" as const,
      facts: collapseLlmFacts,
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
          status: "active" as const,
          turnCount: 4,
          tokenCount: 50,
          openedAt: new Date(), // determinism-ok: throwaway fixture, not asserted
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

    const result = await collapseSession(
      {
        sessionId: "s1",
        workspaceId: "ws",
        agentId: "a",
        reason: "max_turns",
        policy: {
          mode: "hybrid",
          hybridPolicy: { collapseSkipsExisting: false },
        },
      },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");

    // With collapseSkipsExisting=false, both facts should be created despite per-turn coverage
    expect(result.factsCreated).toBe(2);
    expect(createFactCalls.length).toBe(2);

    const createdTopicKeys = createFactCalls.map((c) => c.topicKey);
    expect(createdTopicKeys).toContain("deploy-region");
    expect(createdTopicKeys).toContain("redis-version");
  });
});
