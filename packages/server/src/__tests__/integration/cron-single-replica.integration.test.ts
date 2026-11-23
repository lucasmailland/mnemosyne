/**
 * Two cron registries on one database stand in for two replicas: each tick of
 * a shared-state job must run on exactly one of them, while a per-replica job
 * runs on both.
 *
 * Requires Docker (testcontainers).
 */
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPgCronLock } from "../../cron/pgLock.js";
import { type CronRegistryHandle, startCronRegistry } from "../../cron/registry.js";

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const PERIOD_MS = 400;

let container: StartedTestContainer;
let url: string;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  url = `postgres://${PG.user}:${PG.password}@${container.getHost()}:${container.getMappedPort(5432)}/${PG.db}`;
}, 120_000);

afterAll(async () => {
  await container?.stop().catch(() => undefined);
});

const quietDeps = () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
  telemetry: {
    counter: vi.fn(),
    histogram: vi.fn(),
    startSpan: vi.fn(),
    gauge: vi.fn(),
    shutdown: vi.fn(),
  } as any,
});

describe("cron registry across two replicas", () => {
  it("runs each tick of a shared job once and a per-replica job on both", async () => {
    const pools = [postgres(url, { max: 4 }), postgres(url, { max: 4 })];
    const sharedTicks: number[] = [];
    const replicaRuns = [0, 0];
    const registries: CronRegistryHandle[] = pools.map((sql, i) =>
      startCronRegistry(
        [
          {
            key: "mnemo.webhook.deliver",
            schedule: { kind: "interval", ms: PERIOD_MS },
            handler: async () => {
              sharedTicks.push(Math.round(Date.now() / PERIOD_MS)); // determinism-ok: which wall-clock tick ran
            },
          },
          {
            key: "mnemo.meter.persist",
            schedule: { kind: "interval", ms: PERIOD_MS },
            handler: async () => {
              replicaRuns[i]!++;
            },
          },
        ],
        { ...quietDeps(), lock: createPgCronLock(sql) }
      )
    );
    try {
      await new Promise((r) => setTimeout(r, PERIOD_MS * 3 + 100));
    } finally {
      for (const r of registries) r.stop();
      // Let a tick still holding its lock finish before closing the pools.
      await new Promise((r) => setTimeout(r, PERIOD_MS));
      await Promise.all(pools.map((p) => p.end({ timeout: 1 })));
    }
    expect(sharedTicks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sharedTicks).size).toBe(sharedTicks.length);
    expect(replicaRuns[0]).toBeGreaterThanOrEqual(2);
    expect(replicaRuns[1]).toBeGreaterThanOrEqual(2);
  });

  it("the lock lets exactly one of two concurrent runs through", async () => {
    const a = postgres(url, { max: 1 });
    const b = postgres(url, { max: 1 });
    try {
      let runs = 0;
      const fn = async () => {
        runs++;
      };
      const results = await Promise.all([
        createPgCronLock(a).runExclusive("mnemo.outbox.purge", 300, fn),
        createPgCronLock(b).runExclusive("mnemo.outbox.purge", 300, fn),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(runs).toBe(1);
      // Released afterwards: the next run goes through.
      expect(await createPgCronLock(b).runExclusive("mnemo.outbox.purge", 0, fn)).toBe(true);
    } finally {
      await Promise.all([a.end({ timeout: 1 }), b.end({ timeout: 1 })]);
    }
  });
});
