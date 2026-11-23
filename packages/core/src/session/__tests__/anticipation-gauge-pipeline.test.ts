/**
 * F1 — Anticipation-accuracy gauge computes through the REAL collapseSession
 * pipeline when ctx.cache is wired.
 *
 * Regression guard for the boot bug: packages/server/src/index.ts built the
 * factory core WITHOUT collapse adapters, so buildCollapseContext left ctx.cache
 * undefined. The §30 block (collapse.ts step 8b) is `if (ctx.cache && agentId)`,
 * so anticipationAccuracy was structurally always null in production. No existing
 * test drove collapseSession end-to-end with a cache present — the helper tests
 * (anticipation-accuracy*.test.ts) exercise computeAnticipationAccuracy in
 * isolation, not the pipeline. This test closes that gap at the pipeline seam
 * (the identical code the factory's collapseSession runs).
 */
import { describe, it, expect, vi } from "vitest";
import type { AuthContext, CacheAdapter } from "@mnemo-ai/types";
import { collapseSession } from "../collapse.js";
import { workKey } from "../working-memory.js";
import { ANTICIPATION_SLOT } from "../anticipation-preinject.js";
import type { CoreContext } from "../../cognitive/context.js";

// Redis-contract-faithful cache double: serialize once on set, parse once on get
// (matches RedisCacheAdapter — the adapter owns serialization, F1 Bug A).
class FakeCache implements CacheAdapter {
  readonly id = "fake";
  readonly capabilities = {
    sortedSets: false,
    pubSub: false,
    patterns: true,
    atomic: true,
    hashes: false,
  };
  store = new Map<string, { value: string; expiresAt: number }>();
  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    // Pulled into a variable so the annotation sits on a line prettier will not
    // reflow. On the `if (...)` line it was a trailing comment, and reformatting
    // moved it onto a neighbouring statement — where the determinism guard,
    // which matches per LINE, stopped seeing it.
    const expired = !e || e.expiresAt < Date.now(); // determinism-ok: internal cache helper, not asserted
    if (expired) {
      this.store.delete(key);
      return null;
    }
    return JSON.parse(e.value) as T;
  }
  async set<T>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + (opts?.ttlMs ?? 60_000), // determinism-ok: internal cache helper, not asserted
    }); // determinism-ok: internal cache helper, not asserted
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

const WS = "ws";
const AGENT = "agent-x";
const auth = {
  actorId: "system",
  actorType: "system",
  workspaceId: WS,
  scopes: [],
} as unknown as AuthContext;

function makeTurns(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    workspaceId: WS,
    sessionId: "s1",
    turnIndex: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: i === n - 1 ? "thanks, that worked perfectly" : `message about deploy region ${i}`,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    pinned: false,
  }));
}

// ctx mirrors collapse-policy-integration.test.ts but with a real (or null) cache.
// createFact returns a deterministic id `f-<topicKey>` so a staged anticipation
// id can be made to match (a "hit") deterministically.
function makeCtx(cache: CacheAdapter | null) {
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
    cache,
    outbox: { append: async () => {} },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: WS,
        agentId: AGENT,
        status: "active",
        turnCount: 6,
        tokenCount: 50,
        openedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        metadata: {},
      }), // determinism-ok: throwaway fixture date, not asserted
      listTurns: async () => makeTurns(6),
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

describe("F1: anticipation-accuracy gauge through collapseSession (cache wired)", () => {
  it("returns a REAL fraction (hits/staged) when ctx.cache holds a pre-staged slot", async () => {
    const cache = new FakeCache();
    // Pre-stage the slot exactly as preinjectAnticipation does: an OBJECT (the
    // adapter serializes once) at the namespaced workKey, items keyed by `.id`.
    // One staged id matches the fact collapse extracts (f-deploy-region); one misses.
    await cache.set(
      workKey(WS, AGENT, ANTICIPATION_SLOT),
      {
        generatedAt: "2026-06-15T10:00:00.000Z",
        items: [{ id: "f-deploy-region" }, { id: "f-unrelated" }],
      },
      { ttlMs: 60_000 }
    );

    const { ctx, createFact } = makeCtx(cache);
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: WS, agentId: AGENT, reason: "explicit" },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    expect(createFact).toHaveBeenCalledTimes(1);
    // The gauge is a REAL NUMBER (not null) — the regression made it null.
    expect(result.anticipationAccuracy).not.toBeNull();
    expect(typeof result.anticipationAccuracy).toBe("number");
    // 1 of 2 staged ids (f-deploy-region) was extracted this session → 0.5.
    expect(result.anticipationAccuracy).toBe(0.5);
  });

  it("stays null when NO cache is wired (proves the gauge depends on collapse.cache)", async () => {
    const { ctx } = makeCtx(null);
    const result = await collapseSession(
      { sessionId: "s1", workspaceId: WS, agentId: AGENT, reason: "explicit" },
      ctx,
      auth
    );
    expect(result.status).toBe("completed");
    // This is the pre-fix production reality: cache undefined → gauge null.
    expect(result.anticipationAccuracy).toBeNull();
  });
});
