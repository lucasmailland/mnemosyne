import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";
import type { RecallHitObservation, RecallRequestObservation } from "../../recall.js";

const req = (o: Partial<RecallRequestObservation>): RecallRequestObservation => ({
  requestId: "r1",
  workspaceId: "w1",
  trafficOrigin: "production",
  clientVersion: "unknown",
  pluginVersion: "unknown",
  serverVersion: "unknown",
  sessionId: null,
  requestedFilters: {},
  effectiveFilters: {},
  tiers: [],
  cacheHit: false,
  resultCount: 0,
  nothingRelevant: true,
  status: "empty",
  queryHash: "h",
  totalDurationMs: 1,
  phaseDurationsMs: {},
  ...o,
});
const hit = (o: Partial<RecallHitObservation>): RecallHitObservation => ({
  workspaceId: "w1",
  requestId: "r1",
  primitiveKind: "fact",
  memoryId: "x",
  rank: 0,
  score: 1,
  ...o,
});
const mk = (a: InMemoryStorageAdapter, ws = "w1") =>
  a.createFact({
    workspaceId: ws,
    statement: "s",
    subject: "u",
    kind: "trait",
    scope: "global",
    attribution: "objective_fact",
  });

describe("InMemoryStorageAdapter.recordRecallObservation", () => {
  it("persists zero-result requests, per instance", async () => {
    const a = new InMemoryStorageAdapter();
    const b = new InMemoryStorageAdapter();
    await a.recordRecallObservation(req({}), []);
    expect(a.recallObservations.requests.size).toBe(1);
    expect(a.recallObservations.hits).toHaveLength(0);
    expect(b.recallObservations.requests.size).toBe(0);
  });

  it("timestamps fact log rows so latency and metrics readers see them", async () => {
    const a = new InMemoryStorageAdapter();
    const f = await mk(a);
    await a.recordRecallObservation(req({ totalDurationMs: 42, status: "ok", resultCount: 1 }), [
      hit({ memoryId: f.id, rank: 0 }),
    ]);
    expect(await a.getRecallLatency("w1", 1)).toEqual({ p50Ms: 42, p95Ms: 42, samples: 1 });
    expect((await a.getRecallMetrics("w1", 1)).totals.p50Ms).toBe(42);
  });

  it("keeps workspaces separate for the same requestId", async () => {
    const a = new InMemoryStorageAdapter();
    await a.recordRecallObservation(req({ workspaceId: "w1" }), []);
    await a.recordRecallObservation(req({ workspaceId: "w2" }), []);
    expect(a.recallObservations.requests.size).toBe(2);
  });

  it("preserves mixed prefixed hit ranks and bumps only organic facts, idempotently", async () => {
    const a = new InMemoryStorageAdapter();
    const f = await mk(a);
    const g = await mk(a);
    const hits = [
      hit({ memoryId: "mepi_1", primitiveKind: "episode", rank: 0 }),
      hit({ memoryId: f.id, rank: 1 }),
      hit({ memoryId: f.id, primitiveKind: "decision", rank: 2 }),
    ];
    await a.recordRecallObservation(req({ resultCount: 3 }), hits);
    await a.recordRecallObservation(req({ resultCount: 3 }), hits);
    expect(a.recallObservations.hits.map((h) => [h.memoryId, h.rank])).toEqual([
      ["mepi_1", 0],
      [f.id, 1],
      [f.id, 2],
    ]);
    expect((await a.getFact(f.id, "w1"))!.hitCount).toBe(1);
    await a.recordRecallObservation(req({ requestId: "r2", trafficOrigin: "synthetic" }), [
      hit({ requestId: "r2", memoryId: g.id }),
    ]);
    expect((await a.getFact(g.id, "w1"))!.hitCount).toBe(0);
  });

  it("never records a hit from another workspace (mirrors RLS on the Postgres adapter)", async () => {
    const a = new InMemoryStorageAdapter();
    const foreign = await mk(a, "w2");
    await a.recordRecallObservation(req({ workspaceId: "w1" }), [
      hit({ workspaceId: "w2", memoryId: foreign.id }),
    ]);
    expect(a.recallObservations.hits).toHaveLength(0);
    expect((await a.getFact(foreign.id, "w2"))!.hitCount).toBe(0);
  });

  it("feeds session recall history (governance + precision) for fact hits", async () => {
    const a = new InMemoryStorageAdapter();
    const f = await mk(a);
    await a.recordRecallObservation(req({ sessionId: "s1", status: "ok", resultCount: 2 }), [
      hit({ memoryId: f.id, rank: 0, tdCredit: 1 }),
      hit({ memoryId: "mepi_1", primitiveKind: "episode", rank: 1 }),
    ]);
    expect(await a.getRecalledFactIds("w1", "s1")).toEqual([f.id]);
    expect((await a.getRecallPrecision("w1")).totalHits).toBe(1);
  });

  it("a completed retry upgrades an error-only attempt with the same request id", async () => {
    const a = new InMemoryStorageAdapter();
    const f = await mk(a);
    await a.recordRecallObservation(req({ status: "error" }), []);
    await a.recordRecallObservation(req({ status: "ok", resultCount: 1 }), [
      hit({ memoryId: f.id }),
    ]);
    expect(a.recallObservations.hits).toHaveLength(1);
    expect((await a.getFact(f.id, "w1"))!.hitCount).toBe(1);
    await a.recordRecallObservation(req({ status: "error" }), []);
    expect([...a.recallObservations.requests.values()][0]!.status).toBe("ok");
  });

  it("synthetic hits never enter the activation history", async () => {
    const a = new InMemoryStorageAdapter();
    const f = await mk(a);
    await a.recordRecallObservation(req({ trafficOrigin: "synthetic", status: "ok" }), [
      hit({ memoryId: f.id }),
    ]);
    expect(await a.getRecallLog("w1", f.id, 10)).toHaveLength(0);
  });

  it("synthetic/test session hits never feed session feedback or governance", async () => {
    const a = new InMemoryStorageAdapter();
    const f = await mk(a);
    for (const trafficOrigin of ["synthetic", "test"] as const)
      await a.recordRecallObservation(
        req({ requestId: trafficOrigin, trafficOrigin, sessionId: "s1", status: "ok" }),
        [hit({ requestId: trafficOrigin, memoryId: f.id })]
      );
    expect(await a.getRecalledFactIds("w1", "s1")).toEqual([]);
  });

  it("keeps the query text on organic fact rows for replay, never on synthetic ones", async () => {
    const a = new InMemoryStorageAdapter();
    const f = await mk(a);
    await a.recordRecallObservation(req({ status: "ok", queryText: "deploy steps" }), [
      hit({ memoryId: f.id }),
    ]);
    await a.recordRecallObservation(
      req({ requestId: "r2", trafficOrigin: "test", status: "ok", queryText: "probe" }),
      [hit({ requestId: "r2", memoryId: f.id })]
    );
    expect(await a.getRecentQueriesForFacts("w1", [f.id], 10)).toEqual(["deploy steps"]);
  });
});
