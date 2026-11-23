import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCronJobs, ALL_CRON_KEYS } from "../jobs.js";
import { msUntilNext } from "../schedule.js";
import { startCronRegistry } from "../registry.js";

const noopDeps = () => ({
  storage: {
    refreshMetacognitionViews: vi.fn().mockResolvedValue(undefined),
    refreshAnticipationViews: vi.fn().mockResolvedValue(undefined),
    decayKind: vi.fn().mockResolvedValue(0),
    normalizeHebbianWeights: vi.fn().mockResolvedValue(0),
    queryDriftCandidates: vi.fn().mockResolvedValue([]),
    enqueueReviewItem: vi.fn().mockResolvedValue(undefined),
    updateFact: vi.fn().mockResolvedValue(undefined),
    updateWorth: vi.fn().mockResolvedValue(undefined),
    createEvent: vi.fn().mockResolvedValue({ id: "e1" }),
    createFact: vi.fn().mockResolvedValue({ id: "f1" }),
    listAuditLog: vi.fn().mockResolvedValue([]),
  } as any,
  cache: undefined,
  llm: undefined,
  fileReader: undefined,
  listWorkspaceIds: vi.fn().mockResolvedValue([]),
  collapseStaleSessions: vi.fn().mockResolvedValue(undefined),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  telemetry: {
    counter: vi.fn(),
    histogram: vi.fn(),
    gauge: vi.fn(),
    startSpan: () => ({ end() {} }),
  } as any,
});

describe("cron jobs — §28 registry completeness", () => {
  it("registers every Wave-Y cron with the spec key + schedule", () => {
    const jobs = buildCronJobs(noopDeps());
    const byKey = Object.fromEntries(jobs.map((j) => [j.key, j]));
    expect(byKey["mnemo.governance.propagate"]!.schedule).toEqual({
      kind: "dailyUtc",
      hour: 2,
      minute: 0,
    });
    expect(byKey["mnemo.reasoning.decay"]!.schedule).toEqual({
      kind: "dailyUtc",
      hour: 3,
      minute: 0,
    });
    expect(byKey["mnemo.hot.rebuild"]!.schedule).toEqual({ kind: "dailyUtc", hour: 4, minute: 0 });
    expect(byKey["mnemo.verify.codebase"]!.schedule).toEqual({
      kind: "dailyUtc",
      hour: 5,
      minute: 30,
    });
    expect(byKey["mnemo.type.schedule"]!.schedule).toEqual({
      kind: "dailyUtc",
      hour: 6,
      minute: 0,
    });
    expect(byKey["mnemo.anticipate.mine"]!.schedule).toEqual({
      kind: "dailyUtc",
      hour: 6,
      minute: 30,
    });
    expect(byKey["mnemo.metacognition.refresh"]!.schedule).toEqual({
      kind: "dailyUtc",
      hour: 7,
      minute: 0,
    });
    expect(byKey["mnemo.session.collapse"]!.schedule).toEqual({ kind: "interval", ms: 300_000 });
    expect(byKey["mnemo.hot.decay"]!.schedule).toEqual({ kind: "interval", ms: 3_600_000 });
    expect(byKey["mnemo.reasoning.prune"]!.schedule).toEqual({
      kind: "weeklyUtc",
      weekday: 0,
      hour: 3,
      minute: 30,
    });
    expect(byKey["mnemo.hebbian.normalize"]!.schedule).toEqual({
      kind: "weeklyUtc",
      weekday: 0,
      hour: 4,
      minute: 30,
    });
    expect(byKey["mnemo.composition.validate"]!.schedule).toEqual({
      kind: "weeklyUtc",
      weekday: 0,
      hour: 5,
      minute: 0,
    });
    expect(byKey["mnemo.audit.merkle"]!.schedule).toEqual({
      kind: "weeklyUtc",
      weekday: 2,
      hour: 2,
      minute: 30,
    });
  });

  it("ALL_CRON_KEYS lists exactly 30 crons (29 prior + mnemo.session.retention)", () => {
    const jobs = buildCronJobs(noopDeps());
    expect(new Set(jobs.map((j) => j.key))).toEqual(new Set(ALL_CRON_KEYS));
    expect(ALL_CRON_KEYS).toHaveLength(30);
    // P74/P111: outbox retention. `purgeOutbox` existed in every adapter with
    // no caller, so mnemo_outbox only ever grew.
    expect(ALL_CRON_KEYS).toContain("mnemo.outbox.purge");
    expect(jobs.find((j) => j.key === "mnemo.outbox.purge")).toBeDefined();
    // SEC-4: Merkle root publication cron is registered (hourly)
    expect(ALL_CRON_KEYS).toContain("mnemo.audit.merkle.publish");
    const merklePublish = jobs.find((j) => j.key === "mnemo.audit.merkle.publish");
    expect(merklePublish).toBeDefined();
    expect(merklePublish!.schedule).toEqual({ kind: "interval", ms: 3_600_000 });
    // T4: stale-task cron is registered
    const stale = jobs.find((j) => j.key === "mnemo.task.stale");
    expect(stale).toBeDefined();
    expect(stale!.schedule).toEqual({ kind: "dailyUtc", hour: 8, minute: 0 });
    // Task 7.2: KEK rotation cron is registered
    expect(ALL_CRON_KEYS).toContain("mnemo.kek.rotate");
    const kek = jobs.find((j) => j.key === "mnemo.kek.rotate");
    expect(kek).toBeDefined();
    expect(kek!.schedule).toEqual({ kind: "weeklyUtc", weekday: 0, hour: 3, minute: 0 });
    // Task 7.3: audit partition lifecycle cron is registered
    expect(ALL_CRON_KEYS).toContain("mnemo.audit.partition");
    const auditPart = jobs.find((j) => j.key === "mnemo.audit.partition");
    expect(auditPart).toBeDefined();
    expect(auditPart!.schedule).toEqual({ kind: "weeklyUtc", weekday: 0, hour: 1, minute: 0 });
    // §21: plugin verify is a daily cron; plugin sync is one job per syncing
    // plugin (`mnemo.plugin.sync:<id>`, cron/pluginSync.ts), none without plugins.
    expect(ALL_CRON_KEYS).toContain("mnemo.plugin.verify");
    const pluginVerify = jobs.find((j) => j.key === "mnemo.plugin.verify");
    expect(pluginVerify!.schedule).toEqual({ kind: "dailyUtc", hour: 5, minute: 45 });
    // B1: SOC2 CF3 retention purge cron is registered
    expect(ALL_CRON_KEYS).toContain("mnemo.retention.purge");
    const retentionPurge = jobs.find((j) => j.key === "mnemo.retention.purge");
    expect(retentionPurge).toBeDefined();
    expect(retentionPurge!.schedule).toEqual({ kind: "dailyUtc", hour: 2, minute: 30 });
    // STATS-1: daily health-snapshot cron is registered (ports the cron
    // @mnemo-ai/core's health/index.ts always assumed the host app provided)
    expect(ALL_CRON_KEYS).toContain("mnemo.health.snapshot");
    const healthSnapshot = jobs.find((j) => j.key === "mnemo.health.snapshot");
    expect(healthSnapshot).toBeDefined();
    expect(healthSnapshot!.schedule).toEqual({ kind: "dailyUtc", hour: 3, minute: 0 });
  });
});

describe("msUntilNext — UTC schedule math", () => {
  it("dailyUtc returns a positive ms ≤ 24h", () => {
    const ms = msUntilNext({ kind: "dailyUtc", hour: 7, minute: 0 }, new Date()); // determinism-ok: result is always in (0, 24h] regardless of when test runs
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 3600_000);
  });
  it("dailyUtc from 06:00 to 07:00 target is exactly 1h", () => {
    const now = new Date(Date.UTC(2026, 5, 16, 6, 0, 0));
    expect(msUntilNext({ kind: "dailyUtc", hour: 7, minute: 0 }, now)).toBe(3600_000);
  });
  it("weeklyUtc Sunday target from a Monday is 6 days away", () => {
    const monday = new Date(Date.UTC(2026, 5, 15, 0, 0, 0)); // 2026-06-15 is Monday
    const ms = msUntilNext({ kind: "weeklyUtc", weekday: 0, hour: 0, minute: 0 }, monday);
    expect(ms).toBe(6 * 24 * 3600_000);
  });
});

describe("startCronRegistry — fault isolation + metering", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a throwing job does not stop the registry and is metered as error", async () => {
    const deps = noopDeps();
    const jobs = [
      {
        key: "boom",
        schedule: { kind: "interval", ms: 1000 } as const,
        handler: async () => {
          throw new Error("x");
        },
      },
    ];
    const handle = startCronRegistry(jobs, { logger: deps.logger, telemetry: deps.telemetry });
    await vi.advanceTimersByTimeAsync(1100);
    expect(deps.telemetry.counter).toHaveBeenCalledWith(
      "mnemo_cron_runs_total",
      1,
      expect.objectContaining({ job: "boom", status: "error" })
    );
    handle.stop();
  });
});

it("runs managed recovery even when legacy collapse discovery fails", async () => {
  const deps = noopDeps();
  deps.collapseStaleSessions.mockRejectedValueOnce(new Error("legacy unavailable"));
  const runManagedSessions = vi.fn(async () => {});
  const job = buildCronJobs({ ...deps, runManagedSessions }).find(
    (j) => j.key === "mnemo.session.collapse"
  )!;
  // LIFECYCLE-14 review round: the tick now fails (after both workers ran).
  await expect(job.handler()).rejects.toThrow();
  expect(runManagedSessions).toHaveBeenCalledOnce();
});

describe("managed transcript retention cron", () => {
  it("runs nightly, apart from the 5-minute collapse sweep", () => {
    const jobs = buildCronJobs(noopDeps());
    const job = jobs.find((j) => j.key === "mnemo.session.retention");
    expect(job).toBeDefined();
    // Retention is a daily obligation, not a recovery loop: running it every five
    // minutes would delete on the same cadence it sweeps.
    expect(job!.schedule).toMatchObject({ kind: "dailyUtc" });
  });
});
