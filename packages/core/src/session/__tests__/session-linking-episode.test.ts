import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext } from "@mnemo-ai/types";

const auth = { actorId: "system", actorType: "system", workspaceId: "ws", scopes: [] } as unknown as AuthContext;

function makeCtx() {
  const createEpisode = vi.fn(async (i: Record<string, unknown>) => ({ id: "ep-1", ...i }));
  const zincrby = vi.fn(async () => 1);
  const zrangeByScore = vi.fn(async () => [] as string[]);
  const updateSessionSummary = vi.fn(async () => {});
  let factSeq = 0;
  const summary = {
    goal: "fix DNS", outcome: "resolved",
    facts: [{ content: "DNS TTL was 0", confidence: 0.9 }, { content: "resolver cached NXDOMAIN", confidence: 0.8 }],
    decisions: [], strategies: [],
    discoveries: ["TTL misconfig"], nextSteps: ["add TTL monitor"], relevantEntities: ["dns", "resolver"],
    llmTokensUsed: 0,
  };
  const ctx = {
    config: { surpriseThreshold: 0.3, maxHotTierSize: 1000 },
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    embed: { embed: async (xs: string[]) => xs.map(() => [1, 0, 0]) },
    vector: { search: async () => [] },
    llm: { generate: async () => ({ content: JSON.stringify(summary), tokensUsed: { input: 10, output: 10 } }) },
    cache: { zincrby, zrangeByScore, capabilities: { sortedSets: true } },
    outbox: { append: async () => {} },
    storage: {
      getWorkspaceMode: async () => ({ workspaceId: "ws", mode: "production" as const, sessionCount: 50, promoteAt: null }),
      getSession: async () => ({ id: "s1", workspaceId: "ws", agentId: "a", status: "active", turnCount: 4, tokenCount: 50, openedAt: new Date(), metadata: {} }), // determinism-ok: throwaway fixture date, not asserted
      listTurns: async () => ([0,1,2,3].map((i) => ({ id: `t${i}`, workspaceId: "ws", sessionId: "s1", turnIndex: i, role: "user", content: "dns dns dns", createdAt: new Date(), pinned: i === 0 }))), // determinism-ok: throwaway fixture date, not asserted
      createFact: async (inp: Record<string, unknown>) => ({ id: `f-${factSeq++}`, ...inp }),
      createDecision: async () => ({ id: "d" }),
      createStrategy: async () => ({ id: "st" }),
      createRelation: async () => ({ id: "r" }),
      createEpisode,
      updateSessionSummary,
      closeSession: async () => {},
    },
  } as unknown as CoreContext;
  return { ctx, createEpisode, zincrby, updateSessionSummary };
}

describe("collapse linking episode + hot-promote + summary persist (spec §7)", () => {
  it("creates a linking episode citing all created facts, promotes them to hot, persists summary", async () => {
    const { ctx, createEpisode, zincrby, updateSessionSummary } = makeCtx();
    const res = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "a", reason: "max_turns" },
      ctx, auth,
    );
    expect(res.status).toBe("completed");
    expect(res.factsCreated).toBe(2);
    expect(res.episodeId).toBe("ep-1");

    expect(createEpisode).toHaveBeenCalledTimes(1);
    const epArg = createEpisode.mock.calls[0]![0];
    expect(epArg.linkedFactIds).toEqual(["f-0", "f-1"]);
    expect(epArg.sourceConversationId).toBe("s1");

    const bumped = zincrby.mock.calls.map((c) => c[2]);
    expect(bumped).toContain("f-0");
    expect(bumped).toContain("f-1");

    const sumArg = updateSessionSummary.mock.calls[0]![0];
    expect(sumArg.summary.nextSteps).toEqual(["add TTL monitor"]);
    expect(sumArg.factCount).toBe(2);
  });
});
