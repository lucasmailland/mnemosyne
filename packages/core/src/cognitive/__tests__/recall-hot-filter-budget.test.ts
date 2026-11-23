import { describe, expect, it, vi } from "vitest";
import type { AuthContext, MnemoFact } from "@mnemo-ai/types";
import { createCore } from "../index.js";
import { tryHotTier } from "../recall-hot.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const AUTH = {
  workspaceId: "ws",
  actorId: "caller",
  actorType: "agent",
  scopes: ["memory:read"],
  maxSensitivity: "internal",
} as AuthContext;

function hotFact(id: string, tags: string[]): MnemoFact {
  return {
    id,
    workspaceId: "ws",
    scope: "global",
    // Two content terms per query (RECALL-8: one-term queries skip the hot tier).
    statement: `${id} memory`,
    subject: "hot",
    kind: "other",
    confidence: 0.9,
    relevance: 1,
    hitCount: 0,
    worthSuccess: 20,
    worthFailure: 1,
    worthAlpha: 20,
    worthBeta: 2,
    worth: 0.9,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "user_stated",
    sourceMessageIds: [],
    revisionCount: 1,
    protocolVersion: "3.0",
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "internal",
    validFrom: NOW,
    embeddingStale: false,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: { tags },
  };
}

describe("hot filtered recall under a Tier-1-only token budget", () => {
  it("falls through without reading the hot tier when archived facts are requested", async () => {
    const zrangeByScore = vi.fn(async () => []);
    const result = await tryHotTier(
      {
        cache: { zrangeByScore },
        telemetry: {
          startSpan: () => ({ end() {}, setAttribute() {} }),
          histogram() {},
          counter() {},
          gauge() {},
          async shutdown() {},
        },
      } as never,
      { workspaceId: "ws", text: "query", includeArchived: true },
      AUTH
    );

    expect(result).toBeNull();
    expect(zrangeByScore).not.toHaveBeenCalled();
  });

  it("inspects the complete bounded hot set before filtering and caps accepted hits", async () => {
    const ids = [
      "match-3",
      "match-2",
      "match-1",
      ...Array.from({ length: 60 }, (_, index) => `reject-${index + 1}`),
    ];
    const facts = new Map(
      ids.map((id) => [id, hotFact(id, id.startsWith("match") ? ["wanted"] : ["other"])])
    );
    const vectorSearch = vi.fn(async () => []);
    const pointerCandidates = vi.fn(async () => []);
    const core = createCore({
      storage: {
        getFact: vi.fn(async (id: string) => facts.get(id) ?? null),
        getRecallLog: vi.fn(async () =>
          Array.from({ length: 8 }, (_, i) => ({
            recalledAt: new Date(Date.now() - i * 1000).toISOString(), // determinism-ok: test date
          }))
        ),
        pointerCandidates,
      } as never,
      vector: { search: vectorSearch } as never,
      embed: { model: "test", embedSingle: vi.fn(async () => new Float32Array([1, 0])) } as never,
      cache: {
        zrangeByScore: vi.fn(async () => ids),
        zincrby: vi.fn(async () => 1),
      } as never,
      outbox: { append: vi.fn(async () => undefined) } as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return this;
        },
      } as never,
      telemetry: {
        startSpan: () => ({ end() {}, setAttribute() {} }),
        histogram() {},
        counter() {},
        gauge() {},
        async shutdown() {},
      } as never,
    });

    const result = await core.recall(
      {
        workspaceId: "ws",
        text: "match memory",
        tokenBudget: 1_000,
        filter: { tags: ["wanted"] },
      },
      AUTH
    );

    expect(result.fromHotTier).toBe(true);
    expect(result.hits.map((hit) => hit.id)).toEqual(["match-1", "match-2", "match-3"]);
    expect(result.hits).toHaveLength(3);
    expect(pointerCandidates).not.toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
  });

  it("hydrates hot candidates and recall histories in batches before slicing the second page", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `match-${index + 1}`);
    const facts = ids.map((id) => hotFact(id, ["wanted"]));
    const getRecallPrimitives = vi.fn(async () =>
      facts.map((value) => ({
        id: value.id,
        kind: "fact" as const,
        value,
      }))
    );
    const getRecallLogs = vi.fn(async () =>
      ids.flatMap((memoryId) =>
        Array.from({ length: 8 }, (_, index) => ({
          memoryId,
          id: `${memoryId}-${index}`,
          recalledAt: new Date(Date.now() - index * 1000).toISOString(), // determinism-ok: test date
          recallScore: 1,
        }))
      )
    );
    const getFact = vi.fn(async () => {
      throw new Error("per-candidate hydration");
    });
    const getRecallLog = vi.fn(async () => {
      throw new Error("per-candidate history");
    });
    const core = createCore({
      storage: {
        getRecallPrimitives,
        getRecallLogs,
        getFact,
        getRecallLog,
        pointerCandidates: vi.fn(async () => []),
      } as never,
      vector: { search: vi.fn(async () => []) } as never,
      embed: { model: "test", embedSingle: vi.fn(async () => new Float32Array([1, 0])) } as never,
      cache: {
        zrangeByScore: vi.fn(async () => [...ids].reverse()),
        zincrby: vi.fn(async () => 1),
      } as never,
      outbox: { append: vi.fn(async () => undefined) } as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return this;
        },
      } as never,
      telemetry: {
        startSpan: () => ({ end() {}, setAttribute() {} }),
        histogram() {},
        counter() {},
        gauge() {},
        async shutdown() {},
      } as never,
    });

    const result = await core.recall(
      {
        workspaceId: "ws",
        text: "match memory",
        tokenBudget: 1_000,
        filter: { tags: ["wanted"] },
        offset: 4,
        limit: 3,
      },
      AUTH
    );

    expect(result.fromHotTier).toBe(true);
    expect(result.hits.map((hit) => hit.id)).toEqual(["match-5", "match-6"]);
    expect(getRecallPrimitives).toHaveBeenCalledOnce();
    expect(getRecallLogs).toHaveBeenCalledOnce();
    expect(getFact).not.toHaveBeenCalled();
    expect(getRecallLog).not.toHaveBeenCalled();
  });
});
