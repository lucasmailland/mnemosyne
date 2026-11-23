/**
 * Integration test for F4: materialized views created WITH NO DATA in baseline 0001
 * crash preinjectAnticipation and any analytics query on a fresh install.
 *
 * The baseline (0001) performs the initial non-concurrent REFRESH. This test proves:
 *   1. After migrate(), all 5 views are populated (ispopulated = true).
 *   2. AnalyticsRepository queries (getPeriodicPatterns, getKnowledgeGaps, etc.)
 *      execute without "materialized view has not been populated" error.
 *
 * Requires Docker. Run with:
 *   pnpm --filter @mnemo-ai/adapter-postgres test:integration -- --run matview-init
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;
let storage: DrizzleStorageAdapter;
let raw: ReturnType<typeof postgres>;

const WS = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });

  raw = postgres(databaseUrl, { onnotice: () => void 0, max: 3 });
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  storage = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("F4 regression: materialized views initialised by the baseline (0001)", () => {
  it("all 5 views have ispopulated=true after migrate()", async () => {
    const rows = await raw`
      SELECT matviewname, ispopulated
      FROM pg_matviews
      WHERE schemaname = 'mnemosyne'
      ORDER BY matviewname
    ` as Array<{ matviewname: string; ispopulated: boolean }>;

    const map: Record<string, boolean> = {};
    for (const r of rows) { map[r.matviewname] = r.ispopulated; }

    for (const name of [
      "mv_confidence_map",
      "mv_conditional_patterns",
      "mv_knowledge_gaps",
      "mv_periodic_patterns",
      "mv_sequential_patterns",
    ]) {
      expect(map[name], `${name} should be populated`).toBe(true);
    }
  });

  it("getPeriodicPatterns returns empty array (not throws) on fresh workspace", async () => {
    const rows = await storage.getPeriodicPatterns({ workspaceId: WS, limit: 5 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("getKnowledgeGaps returns empty array (not throws) on fresh workspace", async () => {
    const rows = await storage.getKnowledgeGaps(WS, { limit: 5 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("getConfidenceMap returns empty array (not throws) on fresh workspace", async () => {
    const rows = await storage.getConfidenceMap(WS, { limit: 5 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("getSequentialPatterns returns empty array (not throws) on fresh workspace", async () => {
    const rows = await storage.getSequentialPatterns({ workspaceId: WS, limit: 5 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });
});
