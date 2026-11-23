import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// composeInferences is exercised elsewhere; stub it so these tests isolate the gate.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { recallHot, tryHotTier, hotTierSufficient, hotTierKey } = await import("../recall-hot.js");

// ─── Infra-free fakes ──────────────────────────────────────────────────────────

function makeCache(ids: string[]) {
  const m = new Map<string, number>();
  ids.forEach((id, i) => m.set(id, i + 1));
  const zsets = new Map<string, Map<string, number>>([[hotTierKey("ws"), m]]);
  return {
    id: "fake-cache",
    capabilities: { sortedSets: true, pubSub: false, patterns: false, atomic: false },
    async zincrby(key: string, by: number, member: string): Promise<void> {
      const z = zsets.get(key) ?? new Map<string, number>();
      z.set(member, (z.get(member) ?? 0) + by);
      zsets.set(key, z);
    },
    async zrangeByScore(key: string): Promise<string[]> {
      const z = zsets.get(key) ?? new Map<string, number>();
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    },
  } as any;
}

const FACT = (id: string) => ({
  id,
  status: "active",
  validTo: undefined,
  validFrom: new Date("2026-01-01T00:00:00Z"),
  statement: `hot statement ${id}`,
  sensitivity: "internal",
  worth: 0.9,
  worthAlpha: 20,
  worthBeta: 5,
  createdAt: "2026-01-01T00:00:00Z",
  attribution: "user_stated",
});

/**
 * Storage whose recall log is configurable per fact:
 *   - "recent": several recalls in the last seconds → high activation + boost
 *   - "old":    a single recall ~1h ago → low activation, no recency boost
 *   - "none":   empty log → activation 0
 */
function makeStorage(facts: string[], recencyByFact: Record<string, "recent" | "old" | "none">) {
  const now = Date.now(); // determinism-ok: only relative offsets (seconds/hours) matter for ACT-R recency scoring
  return {
    async getFact(id: string) {
      return facts.includes(id) ? FACT(id) : null;
    },
    async getRecallLog(_ws: string, id: string) {
      const mode = recencyByFact[id] ?? "none";
      if (mode === "none") return [];
      if (mode === "old") {
        return [{ id: "r", recalledAt: new Date(now - 3_600_000).toISOString(), recallScore: 1 }];
      }
      // recent: 5 recalls within the last 5 seconds
      return [0, 1000, 2000, 3000, 4000].map((ago, i) => ({
        id: `r-${i}`,
        recalledAt: new Date(now - ago).toISOString(),
        recallScore: 1,
      }));
    },
  } as any;
}

function makeCtx(cache: any, storage: any) {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };
  const telemetry = { startSpan: () => ({ end() {} }), histogram: () => {} };
  return { cache, storage, config: { maxHotTierSize: 1000 }, logger, telemetry } as any;
}

const auth = { scopes: [] } as unknown as AuthContext;

// ─── hotTierSufficient ──────────────────────────────────────────────────────────

describe("hotTierSufficient (§17 gate)", () => {
  it("true only when ≥3 hits exceed activation 0.7", () => {
    const hi = (s: number) => ({ score: s }) as any;
    expect(hotTierSufficient([hi(0.8), hi(0.75), hi(0.71)])).toBe(true);
    expect(hotTierSufficient([hi(0.8), hi(0.75)])).toBe(false); // only 2 above bar
    expect(hotTierSufficient([hi(0.8), hi(0.75), hi(0.5)])).toBe(false); // 3rd below bar
    expect(hotTierSufficient([])).toBe(false);
  });
});

// ─── recallHot scoring ───────────────────────────────────────────────────────────

describe("recallHot (§17 activation scoring + recency boost)", () => {
  it("rejects closed hot facts before activation and reinforcement", async () => {
    const cache = makeCache(["closed"]);
    const storage = makeStorage(["closed"], { closed: "recent" });
    storage.getFact = vi.fn(async () => ({
      ...FACT("closed"),
      validTo: new Date("2026-02-01T00:00:00Z"),
    })) as typeof storage.getFact;
    storage.getRecallLog = vi.fn(storage.getRecallLog);
    cache.zincrby = vi.fn(cache.zincrby);

    const hits = await recallHot(makeCtx(cache, storage), "ws", auth, 10, true);

    expect(hits).toEqual([]);
    expect(storage.getRecallLog).not.toHaveBeenCalled();
    expect(cache.zincrby).not.toHaveBeenCalled();
  });

  it("scores on ACT-R activation, not raw worth", async () => {
    const ids = ["f1"];
    const cache = makeCache(ids);
    const storage = makeStorage(ids, { f1: "old" });
    const hits = await recallHot(makeCtx(cache, storage), "ws", auth, 10, true);
    expect(hits).toHaveLength(1);
    // worth is 0.9; an old single recall yields low activation well below 0.9.
    expect(hits[0]!.score).toBeLessThan(0.9);
    expect(hits[0]!.worth).toBe(0.9); // worth still surfaced as metadata
  });

  it("applies +0.3 recency boost for a fact recalled in the last 5min", async () => {
    const ids = ["recent", "old"];
    const cache = makeCache(ids);
    const storage = makeStorage(ids, { recent: "recent", old: "old" });
    const hits = await recallHot(makeCtx(cache, storage), "ws", auth, 10, true);
    const recent = hits.find((h) => h.id === "recent")!;
    const old = hits.find((h) => h.id === "old")!;
    expect(recent.score).toBeGreaterThan(old.score);
    expect(recent.score).toBeGreaterThan(0.7); // recency-boosted past the gate bar
  });
});

// ─── tryHotTier sufficiency gate ─────────────────────────────────────────────────

describe("tryHotTier (§17 sufficiency gate)", () => {
  it("returns null (fall through) when fewer than 3 results exceed activation 0.7", async () => {
    const ids = ["a", "b"]; // only 2 recent → below the ≥3 requirement
    const cache = makeCache(ids);
    const storage = makeStorage(ids, { a: "recent", b: "recent" });
    const res = await tryHotTier(
      makeCtx(cache, storage),
      { workspaceId: "ws", text: "hot statement", limit: 10 } as any,
      auth
    );
    expect(res).toBeNull();
  });

  it("returns a hot result when ≥3 results exceed activation 0.7", async () => {
    const ids = ["a", "b", "c"];
    const cache = makeCache(ids);
    const storage = makeStorage(ids, { a: "recent", b: "recent", c: "recent" });
    const res = await tryHotTier(
      makeCtx(cache, storage),
      { workspaceId: "ws", text: "hot statement", limit: 10 } as any,
      auth
    );
    expect(res).not.toBeNull();
    expect(res!.fromHotTier).toBe(true);
    expect(res!.hits.length).toBeGreaterThanOrEqual(3);
  });

  it("serves synthetic traffic without reinforcing the facts it returns", async () => {
    const ids = ["a", "b", "c"];
    const cache = makeCache(ids);
    cache.zincrby = vi.fn(cache.zincrby);
    const storage = makeStorage(ids, { a: "recent", b: "recent", c: "recent" });
    const res = await tryHotTier(
      makeCtx(cache, storage),
      {
        workspaceId: "ws",
        text: "hot statement",
        limit: 10,
        effects: { trafficOrigin: "evaluation", applyOrganicEffects: false },
      } as any,
      auth
    );
    expect(res!.hits.length).toBeGreaterThanOrEqual(3);
    expect(cache.zincrby).not.toHaveBeenCalled();
  });

  it("returns null when the hot ZSet has only cold (no-recall) facts", async () => {
    const ids = ["a", "b", "c"]; // present in ZSet but no recall log → activation 0
    const cache = makeCache(ids);
    const storage = makeStorage(ids, {});
    const res = await tryHotTier(
      makeCtx(cache, storage),
      { workspaceId: "ws", text: "hot statement", limit: 10 } as any,
      auth
    );
    expect(res).toBeNull();
  });
});
