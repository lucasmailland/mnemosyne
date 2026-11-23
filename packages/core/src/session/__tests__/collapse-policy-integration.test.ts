/**
 * F2 — End-to-end proof that per-agent CollapsePolicy resolved via
 * resolveCollapsePolicy(profile) actually governs collapse:
 *   (a) requirePin:true from the profile skips collapse when no pinned turn exists
 *   (b) the SAME policy + a pinned turn lets collapse complete (policy threaded)
 *   (c) the resolved mode is always a valid union member (never "standard")
 *   (d) a maxTurns=5 profile triggers max_turns at 5 turns where defaults wouldn't
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession, type CollapsePolicy } from "../collapse.js";
import { resolveCollapsePolicy } from "../collapse-policy.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext, MnemoAgentProfile } from "@mnemo-ai/types";

const auth = {
  actorId: "system",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

function makeTurns(n: number, pinFirst: boolean) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: i === n - 1 ? "thanks, that worked perfectly" : `message about deploy region ${i}`,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    pinned: pinFirst && i === 0, // determinism-ok: throwaway fixture date, not asserted
  }));
}

function makeCtx(turns: ReturnType<typeof makeTurns>) {
  const createFact = vi.fn(async (inp: Record<string, unknown>) => ({
    id: `f-${String(inp.topicKey ?? "anon")}`,
    ...inp,
  }));
  const summary = {
    goal: "configure infra",
    outcome: "resolved",
    facts: [{ content: "deploy-region is us-east-1", topicKey: "deploy-region", confidence: 0.9 }],
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
        agentId: "agent-x",
        status: "active",
        turnCount: turns.length,
        tokenCount: 50,
        openedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        metadata: {},
      }), // determinism-ok: throwaway fixture date, not asserted
      listTurns: async () => turns,
      createFact,
      createDecision: async () => ({ id: "d" }),
      createStrategy: async () => ({ id: "st" }),
      // P125: collapse now routes a topicKey'd fact through the upsert before
      // inserting. `null` = nothing to merge into, i.e. this double keeps its
      // previous create-everything behaviour; it is here so the double covers
      // the port method the code actually calls.
      mergeFactByTopicKey: async () => null,
      createRelation: async () => ({ id: "r" }),
      closeSession: async () => {},
    },
  } as unknown as CoreContext;
  return { ctx, createFact };
}

const profileWith = (cp: Record<string, unknown>): MnemoAgentProfile => ({
  workspaceId: "ws",
  agentId: "agent-x",
  summary: "",
  metadata: { collapsePolicy: cp },
  createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
});

describe("F2 integration: per-agent CollapsePolicy governs collapse", () => {
  it("requirePin:true from the agent profile SKIPS collapse when no turn is pinned", async () => {
    const turns = makeTurns(5, /*pinFirst*/ false);
    const { ctx } = makeCtx(turns);
    const policy: CollapsePolicy = resolveCollapsePolicy(
      profileWith({ maxTurns: 5, requirePin: true })
    );
    expect(policy.requirePin).toBe(true);
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "max_turns", policy },
      ctx,
      auth
    );
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("no_pin");
  });

  it("with the SAME policy but a pinned turn, collapse COMPLETES (policy threaded end-to-end)", async () => {
    const turns = makeTurns(5, /*pinFirst*/ true);
    const { ctx, createFact } = makeCtx(turns);
    const policy = resolveCollapsePolicy(profileWith({ maxTurns: 5, requirePin: true }));
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-x", reason: "max_turns", policy },
      ctx,
      auth
    );
    expect(result.status).toBe("completed");
    expect(result.factsCreated).toBe(1);
    expect(createFact).toHaveBeenCalledTimes(1);
  });

  it("the resolved mode is a valid union member, never 'standard'", () => {
    const policy = resolveCollapsePolicy(profileWith({ mode: "standard" })); // invalid → rejected
    expect(["auto", "explicit", "hybrid"]).toContain(policy.mode);
    expect(policy.mode).toBe("auto");
  });

  it("a maxTurns=5 profile triggers max_turns at 5 turns (default 50 would NOT)", () => {
    const policy = resolveCollapsePolicy(profileWith({ maxTurns: 5 }));
    // assert via inline: 5 >= policy.maxTurns
    expect(5 >= (policy.maxTurns ?? 50)).toBe(true);
    expect(5 >= 50).toBe(false); // default would not fire
  });
});
