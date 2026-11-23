import { describe, it, expect } from "vitest";
import type { CacheAdapter } from "@mnemo-ai/types";
import { WorkingMemory, workKey } from "../working-memory.js";
import { preinjectAnticipation, ANTICIPATION_SLOT } from "../anticipation-preinject.js";
import { computeAnticipationAccuracy, type AnticipationSlot } from "../anticipation-accuracy.js";

// Redis-contract-faithful double: serialize once on set, parse once on get.
class FakeCache implements CacheAdapter {
  readonly id = "fake";
  readonly capabilities = { sortedSets: false, pubSub: false, patterns: true, atomic: true };
  store = new Map<string, { value: string; expiresAt: number }>();
  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e || e.expiresAt < Date.now()) { this.store.delete(key); return null; } // determinism-ok: internal cache helper, not asserted
    return JSON.parse(e.value) as T;
  }
  async set<T>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void> {
    if (!opts?.ttlMs) throw new Error("ttlMs required");
    this.store.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + opts.ttlMs }); // determinism-ok: internal cache helper, not asserted
  }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async deletePattern(): Promise<number> { return 0; }
  async healthCheck() { return { status: "ok" as const, latencyMs: 0 }; }
  async close(): Promise<void> {}
}

const WS = "11111111-1111-1111-1111-111111111111";
const AGENT = "agent-7";

// Stage N anticipated ids, then simulate recall of one of them, and compute
// accuracy through the SAME read path collapse uses (ctx.cache.get at workKey).
async function stageAndScore(
  recalledFactIds: string[],
): Promise<number | null> {
  const cache = new FakeCache();
  const wm = new WorkingMemory(cache);
  const storage = {
    // Two sequential successors → two staged anticipated memories: fact-1, fact-2.
    getSequentialPatterns: async () => [
      { workspaceId: WS, predecessorId: "cue", successorId: "fact-1", support: 9, avgLagSeconds: 5, confidence: 0.9 },
      { workspaceId: WS, predecessorId: "cue", successorId: "fact-2", support: 8, avgLagSeconds: 7, confidence: 0.8 },
    ],
    getPeriodicPatterns: async () => [],
    getConditionalPatterns: async () => [],
    getCoOccurrencePatterns: async () => [],
  } as any;

  await preinjectAnticipation({
    storage, workingMemory: wm, workspaceId: WS, agentId: AGENT,
    recentlyRecalledId: "cue", topN: 3, lookAheadMinutes: 30, nowMs: Date.UTC(2026, 5, 15, 10),
  });

  // Read back the way collapse.ts does: ctx.cache.get<AnticipationSlot>(workKey(...)).
  const slot = await cache.get<AnticipationSlot>(workKey(WS, AGENT, ANTICIPATION_SLOT));
  return computeAnticipationAccuracy(slot, recalledFactIds);
}

describe("anticipation accuracy end-to-end (F1 — non-zero gauge)", () => {
  it("is > 0 and equals hits/staged when a staged id is recalled", async () => {
    // 2 staged (fact-1, fact-2); recall fact-1 only → 1/2 = 0.5.
    const acc = await stageAndScore(["fact-1", "unrelated-fact"]);
    expect(acc).not.toBeNull();
    expect(acc!).toBeGreaterThan(0);
    expect(acc!).toBe(0.5);
  });

  it("is 0 when no staged id is recalled (slot still parses as an object)", async () => {
    const acc = await stageAndScore(["unrelated-1", "unrelated-2"]);
    expect(acc).toBe(0);
  });

  it("is 1 when every staged id is recalled", async () => {
    const acc = await stageAndScore(["fact-1", "fact-2"]);
    expect(acc).toBe(1);
  });
});
