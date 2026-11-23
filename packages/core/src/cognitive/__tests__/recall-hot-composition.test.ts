import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// ─── Mock compositionality module before importing recall-hot ─────────────────
vi.mock("../compositionality.js", () => ({
  composeInferences: vi.fn(async () => []),
}));

// Import after mock is registered
const { tryHotTier } = await import("../recall-hot.js");
const { composeInferences } = await import("../compositionality.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCache(factIds: string[] = []) {
  const zsets = new Map<string, Map<string, number>>();
  // Pre-populate with the given fact IDs so zrangeByScore returns them
  if (factIds.length > 0) {
    const m = new Map<string, number>();
    factIds.forEach((id, i) => m.set(id, i + 1));
    zsets.set(`mnemo:ws1:hot:facts`, m);
  }
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

// §17: the hot tier now scores on ACT-R activation from the recall log and only
// serves when ≥3 hits have activation > 0.7. Give every fact several recent
// recalls so each clears the 0.7 bar (recency boost +0.3 + high tanh(petrov)).
function recentRecallLog(): Array<{ id: string; recalledAt: string; recallScore: number }> {
  const now = Date.now(); // determinism-ok: only relative offsets (0–4s) matter for ACT-R activation, not absolute value
  return [0, 1000, 2000, 3000, 4000].map((ago, i) => ({
    id: `r-${i}`,
    recalledAt: new Date(now - ago).toISOString(),
    recallScore: 1,
  }));
}

function makeStorage(
  facts: Record<
    string,
    {
      id: string;
      statement: string;
      sensitivity: string;
      worth?: number;
      worthAlpha?: number;
      worthBeta?: number;
      createdAt: string;
      validFrom: Date;
      validTo: null;
      status: "active";
    }
  >
) {
  return {
    async getFact(id: string, _workspaceId: string) {
      return facts[id] ?? null;
    },
    async getRecallLog(_ws: string, memoryId: string, _n: number) {
      return facts[memoryId] ? recentRecallLog() : [];
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

const authOpen = { scopes: [] } as unknown as AuthContext;

const FACT_A = {
  id: "f-a",
  statement: "Paris is the capital city of France",
  sensitivity: "internal",
  worth: 0.9,
  worthAlpha: 20,
  worthBeta: 5,
  createdAt: "2026-01-01T00:00:00Z",
  validFrom: new Date("2026-01-01T00:00:00Z"),
  validTo: null,
  status: "active" as const,
};
const FACT_B = { ...FACT_A, id: "f-b", statement: "Berlin is the capital city of Germany" };
const FACT_C = { ...FACT_A, id: "f-c", statement: "Rome is the capital city of Italy" };

// ≥3 hot facts, all with recent recall history → clears the §17 sufficiency gate.
const SUFFICIENT_IDS = ["f-a", "f-b", "f-c"];
const SUFFICIENT_FACTS = { "f-a": FACT_A, "f-b": FACT_B, "f-c": FACT_C };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("tryHotTier — composition hook (Wave J2)", () => {
  beforeEach(() => {
    vi.mocked(composeInferences).mockClear();
    vi.mocked(composeInferences).mockResolvedValue([]);
  });

  it("calls composeInferences with materialise:false when hot-tier returns hits", async () => {
    const cache = makeCache(SUFFICIENT_IDS);
    const storage = makeStorage(SUFFICIENT_FACTS);
    const ctx = makeCtx(cache, storage);

    const query = { workspaceId: "ws1", text: "capital city", limit: 10, offset: 0 };
    const result = await tryHotTier(ctx, query, authOpen);

    expect(result).not.toBeNull();
    expect(vi.mocked(composeInferences)).toHaveBeenCalledOnce();

    const [, , , opts] = vi.mocked(composeInferences).mock.calls[0]!;
    expect(opts).toMatchObject({ materialise: false });
  });

  it("does NOT call composeInferences when hits is empty", async () => {
    const cache = makeCache([]); // empty ZSet
    const storage = makeStorage({});
    const ctx = makeCtx(cache, storage);

    const query = { workspaceId: "ws1", text: "something", limit: 10, offset: 0 };
    const result = await tryHotTier(ctx, query, authOpen);

    expect(result).toBeNull();
    expect(vi.mocked(composeInferences)).not.toHaveBeenCalled();
  });

  it("passes triggeredByQuery from query.text to composeInferences", async () => {
    const cache = makeCache(SUFFICIENT_IDS);
    const storage = makeStorage(SUFFICIENT_FACTS);
    const ctx = makeCtx(cache, storage);

    const query = { workspaceId: "ws1", text: "the capital city", limit: 10, offset: 0 };
    await tryHotTier(ctx, query, authOpen);

    const [, , , opts] = vi.mocked(composeInferences).mock.calls[0]!;
    expect(opts).toMatchObject({ triggeredByQuery: "the capital city" });
  });

  it("passes conversationId when present in query", async () => {
    const cache = makeCache(SUFFICIENT_IDS);
    const storage = makeStorage(SUFFICIENT_FACTS);
    const ctx = makeCtx(cache, storage);

    const query = {
      workspaceId: "ws1",
      text: "capital city",
      conversationId: "conv-42",
      limit: 10,
      offset: 0,
    };
    await tryHotTier(ctx, query, authOpen);

    const [, , , opts] = vi.mocked(composeInferences).mock.calls[0]!;
    expect(opts).toMatchObject({ conversationId: "conv-42" });
  });

  it("swallows composeInferences errors and still returns a result", async () => {
    vi.mocked(composeInferences).mockRejectedValueOnce(new Error("composition exploded"));

    const cache = makeCache(SUFFICIENT_IDS);
    const storage = makeStorage(SUFFICIENT_FACTS);
    const ctx = makeCtx(cache, storage);

    const query = { workspaceId: "ws1", text: "capital city", limit: 10, offset: 0 };
    const result = await tryHotTier(ctx, query, authOpen);

    // Should not throw and should still return hits
    expect(result).not.toBeNull();
    expect(result!.hits).toHaveLength(3);
    // inferences should be empty (error was swallowed)
    expect(result!.inferences).toBeUndefined();
  });

  it("includes inferences in response when composeInferences returns results", async () => {
    const mockInference = {
      id: "inf-1",
      ruleId: "r-1",
      workspaceId: "ws1",
      derivedStatement: "France is a country",
      confidence: 0.85,
      sensitivity: "internal",
      premiseFactIds: ["f-a"],
      materialisedFactId: undefined,
    };
    vi.mocked(composeInferences).mockResolvedValueOnce([mockInference] as any);

    const cache = makeCache(SUFFICIENT_IDS);
    const storage = makeStorage(SUFFICIENT_FACTS);
    const ctx = makeCtx(cache, storage);

    const query = { workspaceId: "ws1", text: "capital city", limit: 10, offset: 0 };
    const result = await tryHotTier(ctx, query, authOpen);

    expect(result).not.toBeNull();
    expect(result!.inferences).toHaveLength(1);
    expect(result!.inferences![0]!.derivedStatement).toBe("France is a country");
  });

  it("marks response as fromHotTier: true", async () => {
    const cache = makeCache(SUFFICIENT_IDS);
    const storage = makeStorage(SUFFICIENT_FACTS);
    const ctx = makeCtx(cache, storage);

    const query = { workspaceId: "ws1", text: "capital city", limit: 10, offset: 0 };
    const result = await tryHotTier(ctx, query, authOpen);

    expect(result!.fromHotTier).toBe(true);
  });

  it("does NOT compose (no rule counters, no inference history) when runEffects is false", async () => {
    const ctx = makeCtx(makeCache(SUFFICIENT_IDS), makeStorage(SUFFICIENT_FACTS));
    const query = { workspaceId: "ws1", text: "capital city", limit: 10, offset: 0 };
    const result = await tryHotTier(ctx, query, authOpen, undefined, false);

    expect(result).not.toBeNull();
    expect(result!.hits).toHaveLength(3);
    expect(vi.mocked(composeInferences)).not.toHaveBeenCalled();
  });
});
