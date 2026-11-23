// Dashboard redesign phase 2, task 3: recall latency percentiles and zero-filled
// daily writes, mirroring the Postgres definitions (RecallRepository.getRecallLatency,
// FactRepository.getWritesPerDay).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

async function hit(a: InMemoryStorageAdapter, ws: string, latencyMs?: number) {
  await a.recordRecall({ workspaceId: ws, factId: "f", hitRank: 0, latencyMs });
}

describe("InMemoryStorageAdapter.getRecallLatency", () => {
  it("returns nulls and zero samples when empty", async () => {
    const a = new InMemoryStorageAdapter();
    expect(await a.getRecallLatency(WS, 7)).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
  });

  it("computes interpolated, rounded percentiles inside the window, per workspace, skipping null latency", async () => {
    const a = new InMemoryStorageAdapter();
    // old row (outside 7d) must be ignored
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    await hit(a, WS, 9999);
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    for (const ms of [10, 20, 30, 40, 100]) await hit(a, WS, ms);
    await hit(a, WS, undefined);
    await hit(a, OTHER, 5000);
    // sorted 10,20,30,40,100: p50 = 30, p95 = 40 + 0.8*60 = 88
    expect(await a.getRecallLatency(WS, 7)).toEqual({ p50Ms: 30, p95Ms: 88, samples: 5 });
  });
});

describe("InMemoryStorageAdapter.getWritesPerDay", () => {
  it("returns exactly `days` zero-filled UTC days ending today, oldest first", async () => {
    const a = new InMemoryStorageAdapter();
    const out = await a.getWritesPerDay(WS, 14);
    expect(out).toHaveLength(14);
    expect(out[0]).toEqual({ day: "2026-06-02", count: 0 });
    expect(out[13]).toEqual({ day: "2026-06-15", count: 0 });
  });

  it("counts facts by created day for the workspace only", async () => {
    const a = new InMemoryStorageAdapter();
    const mk = (workspaceId: string, statement: string) =>
      a.createFact({
        workspaceId,
        statement,
        subject: "ws",
        kind: "trait",
        scope: "global",
        attribution: "objective_fact",
      });
    vi.setSystemTime(new Date("2026-06-13T23:59:00.000Z"));
    await mk(WS, "a");
    await mk(WS, "b");
    vi.setSystemTime(new Date("2026-06-15T00:01:00.000Z"));
    await mk(WS, "c");
    await mk(OTHER, "d");
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const out = await a.getWritesPerDay(WS, 14);
    expect(out.find((d) => d.day === "2026-06-13")?.count).toBe(2);
    expect(out.find((d) => d.day === "2026-06-14")?.count).toBe(0);
    expect(out.find((d) => d.day === "2026-06-15")?.count).toBe(1);
  });
});

describe("InMemoryStorageAdapter.getRecallMetrics", () => {
  const call = (a: InMemoryStorageAdapter, ws: string, detail?: Record<string, unknown>) =>
    a.appendAuditEntry({
      workspaceId: ws,
      action: "recall",
      resourceKind: "recall",
      isTerminal: false,
      detail,
    });

  it("zero-fills `days` UTC days ending today, with null shares and latencies", async () => {
    const out = await new InMemoryStorageAdapter().getRecallMetrics(WS, 7);
    expect(out.days).toHaveLength(7);
    expect(out.days[0]).toEqual({
      day: "2026-06-09",
      queries: 0,
      zeroHitShare: null,
      p50Ms: null,
      p95Ms: null,
    });
    expect(out.days[6]!.day).toBe("2026-06-15");
    expect(out.totals).toEqual({ queries: 0, zeroHitShare: null, p50Ms: null, p95Ms: null });
  });

  it("counts calls from audit entries, zero hits over readable details, latency per serving call", async () => {
    const a = new InMemoryStorageAdapter();
    vi.setSystemTime(new Date("2026-06-14T10:00:00.000Z"));
    await call(a, WS, { resultCount: 3 });
    await call(a, WS, { resultCount: 0 });
    await a.recordRecall({ workspaceId: WS, factId: "f", hitRank: 0, latencyMs: 40 });
    await a.recordRecall({ workspaceId: WS, factId: "g", hitRank: 1, latencyMs: 40 }); // same call
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    await call(a, WS, { resultCount: 0 });
    await call(a, WS); // unreadable detail: a call, but outside the share
    await call(a, OTHER, { resultCount: 0 });
    await a.appendAuditEntry({
      workspaceId: WS,
      action: "create",
      resourceKind: "fact",
      isTerminal: false,
    });
    for (const ms of [10, 20])
      await a.recordRecall({ workspaceId: WS, factId: "f", hitRank: 0, latencyMs: ms });
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    const out = await a.getRecallMetrics(WS, 7);
    expect(out.days[5]).toEqual({
      day: "2026-06-14",
      queries: 2,
      zeroHitShare: 0.5,
      p50Ms: 40,
      p95Ms: 40,
    });
    expect(out.days[6]).toEqual({
      day: "2026-06-15",
      queries: 2,
      zeroHitShare: 1,
      p50Ms: 15,
      p95Ms: 20,
    });
    // Window: 4 calls, 2 of 3 readable ones empty; latencies 10, 20, 40.
    expect(out.totals).toEqual({ queries: 4, zeroHitShare: 2 / 3, p50Ms: 20, p95Ms: 38 });
  });
});

describe("InMemoryStorageAdapter.getFactStats", () => {
  it("counts live facts under the ceiling by kind, sensitivity and memory type", async () => {
    const a = new InMemoryStorageAdapter();
    let n = 0;
    const mk = (kind: string, sensitivity: string, pinned = false) =>
      a.createFact({
        workspaceId: WS,
        statement: `${kind} ${sensitivity} ${(n += 1)}`,
        subject: "ws",
        kind,
        scope: "global",
        sensitivity,
        pinned,
      } as never);
    await mk("preference", "public", true);
    await mk("preference", "internal");
    await mk("architecture", "internal");
    await mk("policy", "restricted");
    const closed = await mk("preference", "internal");
    await a.archiveFact(closed.id, WS);
    await a.recordRecall({
      workspaceId: WS,
      factId: (await mk("bugfix", "public")).id,
      hitRank: 0,
    });

    const all = await a.getFactStats({ workspaceId: WS });
    expect(all.live).toBe(5);
    expect(all.pinned).toBe(1);
    expect(all.neverRecalled).toBe(4);
    expect(all.byKind).toEqual([
      { kind: "preference", count: 2 },
      { kind: "architecture", count: 1 },
      { kind: "bugfix", count: 1 },
      { kind: "policy", count: 1 },
    ]);
    expect(all.byMemoryType).toEqual([{ memoryType: "semantic", count: 5 }]);

    const internal = await a.getFactStats({ workspaceId: WS, maxSensitivity: "internal" });
    expect(internal.live).toBe(4);
    expect(internal.bySensitivity).toEqual([
      { sensitivity: "internal", count: 2 },
      { sensitivity: "public", count: 2 },
    ]);
    expect(internal.byKind.find((k) => k.kind === "policy")).toBeUndefined();
    expect((await a.getFactStats({ workspaceId: OTHER })).live).toBe(0);
  });
});

describe("InMemoryStorageAdapter.getSessionStats", () => {
  it("counts the window's sessions by start day and status, and its readable episodes", async () => {
    const a = new InMemoryStorageAdapter();
    const state = (a as unknown as { state: { sessions: Map<string, Record<string, unknown>> } })
      .state;
    const s1 = await a.createSession({ workspaceId: WS } as never);
    Object.assign(state.sessions.get(s1.id)!, {
      status: "collapsed",
      collapsedAt: new Date(), // determinism-ok: fake timers pin the clock
      turnCount: 6,
    });
    const s2 = await a.createSession({ workspaceId: WS } as never);
    Object.assign(state.sessions.get(s2.id)!, { turnCount: 2 });
    await a.createSession({ workspaceId: OTHER } as never);
    const fact = await a.createFact({
      workspaceId: WS,
      kind: "other",
      subject: "s",
      statement: "linked",
      scope: "global",
      sensitivity: "internal",
    } as never);
    const secret = await a.createFact({
      workspaceId: WS,
      kind: "other",
      subject: "s",
      statement: "secret",
      scope: "global",
      sensitivity: "restricted",
    } as never);
    const episode = (topics: string[], sensitivity: string, isSynthetic = false) =>
      a.createEpisode({
        workspaceId: WS,
        title: "t",
        narrative: "n",
        occurredAt: new Date(), // determinism-ok: fake timers pin the clock
        topics,
        linkedFactIds: [fact.id, secret.id],
        sensitivity,
        isSynthetic,
      } as never);
    await episode(["checkout", "promo"], "internal");
    await episode(["checkout"], "public");
    await episode(["hidden"], "restricted");
    await episode(["synthetic"], "public", true);

    const stats = await a.getSessionStats({ workspaceId: WS, days: 7, maxSensitivity: "internal" });
    expect(stats.days).toHaveLength(7);
    expect(stats.days[6]).toEqual({ day: "2026-06-15", active: 1, collapsed: 1, archived: 0 });
    expect(stats.totals).toEqual({
      sessions: 2,
      collapsed: 1,
      avgTurns: 4,
      episodes: 2,
      factsPerEpisode: 1,
    });
    expect(stats.topics).toEqual([
      { topic: "checkout", count: 2 },
      { topic: "promo", count: 1 },
    ]);
  });
});

describe("InMemoryStorageAdapter.getAuditActivity", () => {
  it("counts the actors' window by day and action, and keeps each one's latest entry", async () => {
    const a = new InMemoryStorageAdapter();
    const log = (ws: string, actorId: string, action: string) =>
      a.appendAuditEntry({
        workspaceId: ws,
        actorId,
        action,
        resourceKind: "x",
        isTerminal: false,
      } as never);
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    await log(WS, "user:a", "recall"); // before the window: only the latest-entry figure
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    await log(WS, "user:a", "recall");
    await log(WS, "user:a", "create");
    await log(WS, "user:b", "recall");
    await log(OTHER, "user:a", "recall");
    const act = await a.getAuditActivity({ workspaceId: WS, days: 7, actorIds: ["user:a"] });
    expect(act.days).toHaveLength(7);
    expect(act.days[6]).toEqual({ day: "2026-06-15", count: 2 });
    expect(act.byAction).toEqual([
      { action: "create", count: 1 },
      { action: "recall", count: 1 },
    ]);
    expect(act.lastAt).toEqual({ "user:a": "2026-06-15T12:00:00.000Z" });
  });
});

describe("InMemoryStorageAdapter.getHealthSnapshots", () => {
  it("gives each day's latest persisted snapshot as shares, null on a day without one", async () => {
    const a = new InMemoryStorageAdapter();
    await a.createFact({
      workspaceId: WS,
      kind: "other",
      subject: "s",
      statement: "never recalled",
      scope: "global",
    } as never);
    await a.getHealthSnapshot({ workspaceId: WS, fresh: true });
    const days = await a.getHealthSnapshots({ workspaceId: WS, days: 7 });
    expect(days).toHaveLength(7);
    expect(days[6]).toMatchObject({ day: "2026-06-15", zeroHitShare: 1, failedJobs7d: 0 });
    expect(days[0]).toEqual({
      day: "2026-06-09",
      recallHitRate30d: null,
      zeroHitShare: null,
      embeddedShare: null,
      failedJobs7d: null,
    });
  });
});

describe("InMemoryStorageAdapter.getAuditFeedStats", () => {
  it("counts the forgets of the window per UTC day, under the ceiling", async () => {
    const a = new InMemoryStorageAdapter();
    const forgotten = async (sensitivity: string) => {
      const f = await a.createFact({
        workspaceId: WS,
        kind: "other",
        subject: "s",
        statement: `forgotten ${sensitivity}`,
        scope: "global",
        sensitivity,
      } as never);
      Object.assign(
        (
          a as unknown as { state: { facts: Map<string, Record<string, unknown>> } }
        ).state.facts.get(f.id)!,
        { status: "forgotten", updatedAt: new Date() } // determinism-ok: fake timers pin the clock
      );
    };
    await forgotten("internal");
    await forgotten("restricted");
    const stats = await a.getAuditFeedStats({
      workspaceId: WS,
      days: 7,
      maxSensitivity: "internal",
    });
    expect(stats.days[6]).toEqual({ day: "2026-06-15", user: 1, system: 0 });
    expect(stats.totals).toEqual({ user: 1, system: 0 });
  });
});
