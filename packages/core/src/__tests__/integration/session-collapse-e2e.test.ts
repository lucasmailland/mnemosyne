/**
 * W4: Session collapse E2E — LLM availability, turn count, decision extraction.
 *
 * Proves the behavioral gates that spec §28 requires:
 *   1. ctx.llm = null  → {status:"failed", skipReason:"llm_unavailable"}
 *   2. turns < minTurns → {status:"skipped", skipReason:"too_few_turns"}
 *   3. decisions in summary → decisionsCreated incremented
 *   4. policy.extractDecisions=false → decisions ignored even when present
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession, type CollapsePolicy } from "../../session/collapse.js";
import type { CoreContext } from "../../cognitive/context.js";

// Derive the auth parameter type from the function signature to avoid
// a cross-package import while keeping strict typing.
type CollapseAuth = Parameters<typeof collapseSession>[2];
const auth: CollapseAuth = {
  actorId: "system",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as CollapseAuth;

function makeTurns(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `turn content ${i}`,
    createdAt: new Date(), // determinism-ok: fixture date, not asserted
    pinned: false,
  }));
}

function makeStorage(
  turns: ReturnType<typeof makeTurns>,
  createDecision?: ReturnType<typeof vi.fn>,
) {
  return {
    getSession: async () => ({
      id: "s1",
      workspaceId: "ws",
      agentId: "agent-x",
      status: "active",
      turnCount: turns.length,
      tokenCount: 50,
      openedAt: new Date(), // determinism-ok: fixture date, not asserted
      metadata: {},
    }),
    listTurns: async () => turns,
    createFact: vi.fn(async (inp: Record<string, unknown>) => ({
      id: `f-${String(inp.topicKey ?? "anon")}`,
      ...inp,
    })),
    createDecision: createDecision ?? vi.fn(async () => ({ id: "d" })),
    createStrategy: async () => ({ id: "st" }),
    createRelation: async () => ({ id: "r" }),
    closeSession: async () => {},
  };
}

describe("collapseSession — E2E behavior gates (spec §28)", () => {
  it("returns {status:'failed', skipReason:'llm_unavailable'} when ctx.llm is null", async () => {
    const turns = makeTurns(5); // enough turns to pass the minTurns check (≥3)
    const ctx = {
      config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
      vector: { search: async () => [] },
      llm: null, // ← no LLM adapter available
      cache: null,
      outbox: { append: async () => {} },
      storage: makeStorage(turns),
    } as unknown as CoreContext;

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "explicit" },
      ctx,
      auth,
    );

    expect(result.status).toBe("failed");
    expect(result.skipReason).toBe("llm_unavailable");
  });

  it("returns {status:'skipped', skipReason:'too_few_turns'} when turn count < minTurnsForCollapse (default 3)", async () => {
    const turns = makeTurns(1); // 1 < 3 (default minTurnsForCollapse)
    const ctx = {
      config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
      vector: { search: async () => [] },
      llm: {
        generate: async () => ({
          content: JSON.stringify({ goal: "", outcome: "", facts: [], decisions: [], strategies: [] }),
          tokensUsed: { input: 5, output: 5 },
        }),
      },
      cache: null,
      outbox: { append: async () => {} },
      storage: makeStorage(turns),
    } as unknown as CoreContext;

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "inactivity" },
      ctx,
      auth,
    );

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("too_few_turns");
  });

  it("custom minTurnsForCollapse:2 allows collapse at 2 turns (policy override)", async () => {
    const turns = makeTurns(2);
    const summary = {
      goal: "set up monitoring", outcome: "resolved",
      facts: [], decisions: [], strategies: [],
    };
    const ctx = {
      config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
      vector: { search: async () => [] },
      llm: {
        generate: async () => ({ content: JSON.stringify(summary), tokensUsed: { input: 5, output: 5 } }),
      },
      cache: null,
      outbox: { append: async () => {} },
      storage: makeStorage(turns),
    } as unknown as CoreContext;

    const policy: CollapsePolicy = { minTurnsForCollapse: 2 };
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "explicit", policy },
      ctx,
      auth,
    );

    // With minTurns=2 and 2 turns, should not be skipped for too_few_turns
    expect(result.skipReason).not.toBe("too_few_turns");
  });

  it("extracts decisions from LLM summary and increments decisionsCreated", async () => {
    const turns = makeTurns(5);
    const createDecision = vi.fn(async () => ({ id: "d" }));
    const summary = {
      goal: "choose deployment region",
      outcome: "resolved",
      facts: [],
      decisions: [{ title: "use us-east-1", body: "lowest latency to our user base", kind: "decision" }],
      strategies: [],
    };
    const ctx = {
      config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
      vector: { search: async () => [] },
      llm: {
        generate: async () => ({ content: JSON.stringify(summary), tokensUsed: { input: 10, output: 10 } }),
      },
      cache: null,
      outbox: { append: async () => {} },
      storage: makeStorage(turns, createDecision),
    } as unknown as CoreContext;

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "max_turns" },
      ctx,
      auth,
    );

    expect(result.status).toBe("completed");
    expect(result.decisionsCreated).toBe(1);
    expect(createDecision).toHaveBeenCalledOnce();
  });

  it("policy.extractDecisions=false suppresses decision creation even when LLM returns decisions", async () => {
    const turns = makeTurns(5);
    const createDecision = vi.fn(async () => ({ id: "d" }));
    const summary = {
      goal: "choose deployment region",
      outcome: "resolved",
      facts: [],
      decisions: [{ title: "use us-east-1", body: "latency", kind: "decision" }],
      strategies: [],
    };
    const ctx = {
      config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
      vector: { search: async () => [] },
      llm: {
        generate: async () => ({ content: JSON.stringify(summary), tokensUsed: { input: 10, output: 10 } }),
      },
      cache: null,
      outbox: { append: async () => {} },
      storage: makeStorage(turns, createDecision),
    } as unknown as CoreContext;

    const policy: CollapsePolicy = { extractDecisions: false };
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "max_turns", policy },
      ctx,
      auth,
    );

    expect(result.status).toBe("completed");
    expect(result.decisionsCreated).toBe(0);
    expect(createDecision).not.toHaveBeenCalled();
  });
});

describe("collapseSession — session preserved on LLM failure (MNEMO_004)", () => {
  // Regression: factory.ts used to call closeSession() unconditionally on any
  // non-"completed" result, including llm_unavailable. The pipeline must NOT
  // call closeSession() so the factory can decide whether to preserve or close.
  it("does NOT call closeSession when LLM is null (llm_unavailable path)", async () => {
    const turns = makeTurns(5);
    const closeSession = vi.fn();
    const ctx = {
      config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
      vector: { search: async () => [] },
      llm: null,
      cache: null,
      outbox: { append: async () => {} },
      storage: { ...makeStorage(turns), closeSession },
    } as unknown as CoreContext;

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "explicit" },
      ctx,
      auth,
    );

    expect(result.status).toBe("failed");
    expect(result.skipReason).toBe("llm_unavailable");
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("does NOT call closeSession when LLM generate throws (llm_unavailable path)", async () => {
    const turns = makeTurns(5);
    const closeSession = vi.fn();
    const ctx = {
      config: { surpriseThreshold: 0.0, maxHotTierSize: 1000 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
      embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
      vector: { search: async () => [] },
      llm: { generate: async () => { throw new Error("LLM timeout"); } },
      cache: null,
      outbox: { append: async () => {} },
      storage: { ...makeStorage(turns), closeSession },
    } as unknown as CoreContext;

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "explicit" },
      ctx,
      auth,
    );

    expect(result.status).toBe("failed");
    expect(result.skipReason).toBe("llm_unavailable");
    expect(closeSession).not.toHaveBeenCalled();
  });
});
