import { describe, it, expect } from "vitest";
import type { CacheAdapter } from "@mnemo-ai/types";
import { WorkingMemory } from "../working-memory.js";
import { workKey } from "../working-memory.js";
import { preinjectAnticipation, ANTICIPATION_SLOT } from "../anticipation-preinject.js";

// Faithful Redis-contract double: JSON.stringify on set, JSON.parse on get.
// (Same shape as the FakeCache in working-memory.test.ts — the adapter owns serialization.)
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
const AGENT = "agent-1";

describe("preinjectAnticipation — single-encode through the cache adapter (F1 Bug A)", () => {
  it("stores an OBJECT slot that reads back as an object with an items array", async () => {
    const cache = new FakeCache();
    const wm = new WorkingMemory(cache);
    const storage = {
      getSequentialPatterns: async () => [
        { workspaceId: WS, predecessorId: "p", successorId: "fact-1", support: 9, avgLagSeconds: 10, confidence: 0.9 },
      ],
      getPeriodicPatterns: async () => [],
      getConditionalPatterns: async () => [],
      getCoOccurrencePatterns: async () => [],
    } as any;

    await preinjectAnticipation({
      storage, workingMemory: wm, workspaceId: WS, agentId: AGENT,
      recentlyRecalledId: "p", topN: 3, lookAheadMinutes: 30, nowMs: Date.UTC(2026, 5, 15, 10),
    });

    // Read back exactly the way collapse does — via the cache adapter at the namespaced key.
    const slot = await cache.get<{ generatedAt: string; items: Array<{ id: string }> }>(
      workKey(WS, AGENT, ANTICIPATION_SLOT),
    );
    // Bug A guard: slot must be an OBJECT, not a JSON string.
    expect(typeof slot).toBe("object");
    expect(slot).not.toBeNull();
    expect(Array.isArray(slot!.items)).toBe(true);
    expect(slot!.items.map((i) => i.id)).toContain("fact-1");
  });
});
