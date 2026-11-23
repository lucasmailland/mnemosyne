/**
 * §13 Reflection auto-cadence tests.
 *
 * Every `collapseSession` that reaches status="completed" must call
 * `incrementSessionsSinceReflection` and fire `runReflectionCycle` once the
 * counter reaches REFLECTION_CADENCE (10). Below the threshold or when the
 * port / agentId is absent, reflection must NOT fire and the collapse must NOT throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { collapseSession } from "../collapse.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext } from "@mnemo-ai/types";

// ─── vi.mock must be hoisted to module scope ──────────────────────────────────
vi.mock("../../cognitive/self-reflect.js", () => ({
  runReflectionCycle: vi.fn().mockResolvedValue({
    episodeId: "ep-reflect",
    strengthened: [],
    weakened: [],
  }),
  REFLECTION_CADENCE: 10,
}));

const auth = {
  actorId: "system",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

// ─── minimal ctx factory ──────────────────────────────────────────────────────

function makeTurns() {
  return Array.from({ length: 4 }, (_, i) => ({
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: i === 3 ? "thanks, that worked perfectly" : `message ${i}`,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    pinned: false,
  }));
}

function makeCtx(opts: { incrementResult?: number; omitIncrement?: boolean }) {
  const incrementSessionsSinceReflection = opts.omitIncrement
    ? undefined
    : vi.fn().mockResolvedValue(opts.incrementResult ?? 0);

  const llmSummary = {
    goal: "test goal",
    outcome: "resolved",
    facts: [{ content: "fact one", topicKey: "f1", confidence: 0.9 }],
    decisions: [],
    strategies: [],
    llmTokensUsed: 5,
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
        content: JSON.stringify(llmSummary),
        tokensUsed: { input: 5, output: 5 },
      }),
    },
    cache: null,
    outbox: { append: async () => {} },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: "ws",
        agentId: "agent-1",
        status: "active",
        turnCount: 4,
        tokenCount: 50,
        openedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        metadata: {},
      }),
      listTurns: async () => makeTurns(),
      createFact: async (inp: Record<string, unknown>) => ({
        id: `f-${inp.topicKey ?? "x"}`,
        ...inp,
      }),
      // P125: collapse now routes a topicKey'd fact through the upsert before
      // inserting. `null` = nothing to merge into, i.e. this double keeps its
      // previous create-everything behaviour; it is here so the double covers
      // the port method the code actually calls.
      mergeFactByTopicKey: async () => null,
      createDecision: async () => ({ id: "d1" }),
      createStrategy: async () => ({ id: "st1" }),
      createRelation: async () => ({ id: "r1" }),
      closeSession: async () => {},
      ...(incrementSessionsSinceReflection ? { incrementSessionsSinceReflection } : {}),
    },
  } as unknown as CoreContext;

  return { ctx, incrementSessionsSinceReflection };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("§13 collapse: reflection auto-cadence", () => {
  let selfReflectMod: typeof import("../../cognitive/self-reflect.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    selfReflectMod = await import("../../cognitive/self-reflect.js");
  });

  it("fires runReflectionCycle once when incrementSessionsSinceReflection returns 10", async () => {
    const { ctx, incrementSessionsSinceReflection } = makeCtx({ incrementResult: 10 });

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-1", reason: "max_turns" },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    expect(incrementSessionsSinceReflection).toHaveBeenCalledWith("ws", "agent-1");
    expect(selfReflectMod.runReflectionCycle).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire runReflectionCycle when count returns 9 (below REFLECTION_CADENCE)", async () => {
    const { ctx } = makeCtx({ incrementResult: 9 });

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: "agent-1", reason: "max_turns" },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    expect(selfReflectMod.runReflectionCycle).not.toHaveBeenCalled();
  });

  it("does not throw and does not invoke reflection when agentId is absent and port is missing", async () => {
    const { ctx } = makeCtx({ omitIncrement: true });
    // Override getSession to return no agentId
    (ctx.storage as Record<string, unknown>).getSession = async () => ({
      id: "s1",
      workspaceId: "ws",
      agentId: undefined,
      status: "active",
      turnCount: 4,
      tokenCount: 50,
      openedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      metadata: {},
    });

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", agentId: undefined, reason: "max_turns" },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    expect(selfReflectMod.runReflectionCycle).not.toHaveBeenCalled();
  });
});
