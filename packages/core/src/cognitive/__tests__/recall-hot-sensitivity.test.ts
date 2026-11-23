import { describe, it, expect } from "vitest";
import { recallHot, hotTierKey } from "../recall-hot.js";
import type { AuthContext } from "@mnemo-ai/types";

// Minimal infra-free fakes (no Redis, no Postgres) ------------------------------
function makeCache() {
  const zsets = new Map<string, Map<string, number>>();
  return {
    id: "fake-cache",
    capabilities: { sortedSets: true, pubSub: false, patterns: false, atomic: false },
    async zincrby(key: string, by: number, member: string): Promise<void> {
      const m = zsets.get(key) ?? new Map<string, number>();
      m.set(member, (m.get(member) ?? 0) + by);
      zsets.set(key, m);
    },
    async zrangeByScore(key: string): Promise<string[]> {
      const m = zsets.get(key) ?? new Map<string, number>();
      return [...m.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    },
  } as any;
}

function makeStorage(
  facts: Record<string, { id: string; statement: string; sensitivity: string; worth?: number; worthAlpha?: number; worthBeta?: number; createdAt: string; attribution?: string; validFrom: Date; validTo: null; status: "active" }>,
) {
  return {
    async getFact(id: string, _workspaceId: string) {
      return facts[id] ?? null;
    },
  } as any;
}

const ctx = (cache: any, storage: any) =>
  ({ cache, storage, config: { maxHotTierSize: 1000 } } as any);

const authNonAdmin = { scopes: [] } as unknown as AuthContext;
const authAdmin = { scopes: ["memory:admin"] } as unknown as AuthContext;

describe("hot-tier sensitivity ceiling", () => {
  const ws = "ws_test";

  it("hides restricted facts from a non-admin caller", async () => {
    const cache = makeCache();
    await cache.zincrby(hotTierKey(ws), 5, "f_internal");
    await cache.zincrby(hotTierKey(ws), 5, "f_restricted");
    const storage = makeStorage({
      f_internal: { id: "f_internal", statement: "ok", sensitivity: "internal", worth: 0.8, worthAlpha: 20, worthBeta: 5, createdAt: "2026-01-01T00:00:00Z", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, status: "active" },
      f_restricted: { id: "f_restricted", statement: "secret", sensitivity: "restricted", worth: 0.8, worthAlpha: 20, worthBeta: 5, createdAt: "2026-01-01T00:00:00Z", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, status: "active" },
    });

    const hits = await recallHot(ctx(cache, storage), ws, authNonAdmin, 10);
    const ids = hits.map((h) => h.id);

    expect(ids).toContain("f_internal");
    expect(ids).not.toContain("f_restricted");
  });

  it("surfaces restricted facts to an admin caller", async () => {
    const cache = makeCache();
    await cache.zincrby(hotTierKey(ws), 5, "f_restricted");
    const storage = makeStorage({
      f_restricted: { id: "f_restricted", statement: "secret", sensitivity: "restricted", worth: 0.8, worthAlpha: 20, worthBeta: 5, createdAt: "2026-01-01T00:00:00Z", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, status: "active" },
    });

    const hits = await recallHot(ctx(cache, storage), ws, authAdmin, 10);
    expect(hits.map((h) => h.id)).toContain("f_restricted");
  });
});
