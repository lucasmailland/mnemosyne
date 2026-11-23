/**
 * GET /recall/metrics and GET /facts/stats against a real Postgres, through a
 * non-superuser `mnemo_app_role` connection (NOSUPERUSER NOBYPASSRLS), over HTTP
 * with real API keys. Ground truth is seeded as the superuser.
 *
 *   /recall/metrics: calls are the `recall` audit entries (one per call, whatever
 *   it returned, so a call that served nothing still counts); the zero-hit share
 *   is over the entries whose detail is readable (an encrypted detail is a JSON
 *   string); latency is per call, from the recall log's `hit_rank = 0` rows.
 *   Other workspaces, other actions and rows before the window are not counted.
 *
 *   /facts/stats: live facts only (closed, forgotten and merged ones are out),
 *   and nothing above the key's sensitivity ceiling is counted.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_ROLE = "aggregates_app";
const APP_PASSWORD = "aggregates_app_pass";

const TENANT_ID = "tenant-aggregates";
const WS = "9b1f9c00-0000-4000-8000-0000000000a1";
const OTHER = "9b1f9c00-0000-4000-8000-0000000000a2";
const KEY_ALL = "mns_live_aggregatesreadallkey001";
const KEY_INTERNAL = "mns_live_aggregatesinternalkey01";
const KEY_ADMIN = "mns_live_aggregatesadminkey00001";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

const get = async (path: string, key = KEY_ALL) => {
  const res = await app.request(path, { headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.json()) as any };
};

// The process ceiling defaults to `internal`; raise it so a key without its own grant reads all.
const ENV_CEILING = process.env.MNEMO_SENSITIVITY_CEILING;

beforeAll(async () => {
  process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }
  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, 'Aggregates')`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, 'Aggregates', 'aggregates', ${TENANT_ID}),
           (${OTHER}, 'Other', 'aggregates-other', ${TENANT_ID})
  `;
  const [hashAll, hashInternal, hashAdmin] = await Promise.all([
    bcrypt.hash(KEY_ALL, BCRYPT_COST),
    bcrypt.hash(KEY_INTERNAL, BCRYPT_COST),
    bcrypt.hash(KEY_ADMIN, BCRYPT_COST),
  ]);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes, max_sensitivity)
    VALUES
      ('key_agg_all', ${WS}, ${hashAll}, 'all', 'all', ARRAY['memory:read']::text[], NULL),
      ('key_agg_int', ${WS}, ${hashInternal}, 'internal', 'internal', ARRAY['memory:read']::text[], 'internal'),
      ('key_agg_adm', ${WS}, ${hashAdmin}, 'admin', 'admin', ARRAY['memory:read', 'memory:admin']::text[], NULL)
  `;

  // Facts. Live: p1 (preference, public, pinned, recalled), p2 (preference, internal),
  // a1 (architecture, internal, episodic), r1 (policy, restricted, pinned).
  // Not live: c1 closed, x1 forgotten, m1 merged; o1 lives in the other workspace.
  await admin`
    INSERT INTO mnemosyne.mnemo_fact
      (id, workspace_id, scope, kind, subject, statement, status, sensitivity, memory_type,
       pinned, hit_count, valid_to)
    VALUES
      ('p1', ${WS}, 'global', 'preference', 's', 'p1', 'active', 'public', 'semantic', true, 4, NULL),
      ('p2', ${WS}, 'global', 'preference', 's', 'p2', 'active', 'internal', 'semantic', false, 0, NULL),
      ('a1', ${WS}, 'global', 'architecture', 's', 'a1', 'active', 'internal', 'episodic', false, 0, NULL),
      ('r1', ${WS}, 'global', 'policy', 's', 'r1', 'active', 'restricted', 'semantic', true, 0, NULL),
      ('c1', ${WS}, 'global', 'preference', 's', 'c1', 'active', 'public', 'semantic', false, 0, now()),
      ('x1', ${WS}, 'global', 'preference', 's', 'x1', 'forgotten', 'public', 'semantic', false, 0, now()),
      ('m1', ${WS}, 'global', 'preference', 's', 'm1', 'merged', 'public', 'semantic', false, 0, NULL),
      ('o1', ${OTHER}, 'global', 'preference', 's', 'o1', 'active', 'public', 'semantic', false, 0, NULL)
  `;

  // Graph. Entities: e1 person, e2 project, e3 concept (no live link), e4 person but
  // restricted; e9 lives elsewhere. Relations: e1→e2 related, e1→e4 part_of, a dismissed
  // e2→e3 and a closed e3→e1 (neither counts); p1 conflicts with p2. One active decision.
  await admin`
    INSERT INTO mnemosyne.mnemo_entity (id, workspace_id, name, kind, sensitivity)
    VALUES ('e1', ${WS}, 'Ada', 'person', 'internal'),
           ('e2', ${WS}, 'Atlas', 'project', 'internal'),
           ('e3', ${WS}, 'Caching', 'concept', 'internal'),
           ('e4', ${WS}, 'Root', 'person', 'restricted'),
           ('e9', ${OTHER}, 'Elsewhere', 'person', 'internal')
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_relation
      (id, workspace_id, source_kind, source_id, target_kind, target_id, relation, judgment_status, confidence, valid_to)
    VALUES
      ('r1', ${WS}, 'entity', 'e1', 'entity', 'e2', 'related', 'judged', 0.9, NULL),
      ('r2', ${WS}, 'entity', 'e1', 'entity', 'e4', 'part_of', 'judged', 0.8, NULL),
      ('r3', ${WS}, 'entity', 'e2', 'entity', 'e3', 'related', 'dismissed', 0.5, NULL),
      ('r4', ${WS}, 'entity', 'e3', 'entity', 'e1', 'related', 'judged', 0.5, now()),
      ('r5', ${WS}, 'fact', 'p1', 'fact', 'p2', 'conflicts_with', 'pending', 0.7, NULL)
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_decision (id, workspace_id, kind, title, body, normalized_hash, status)
    VALUES ('d1', ${WS}, 'architecture', 'Use Postgres', 'b', 'h1', 'active')
  `;

  // Sessions: today a collapsed one (6 turns) and an active one (2); an archived one
  // 10 days ago; one elsewhere. Episodes today: ep1 internal (links p1 and the
  // restricted r1), ep2 public (links p2), ep3 restricted, and a synthetic one.
  await admin`
    INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status, started_at, collapsed_at, turn_count)
    VALUES ('s1', ${WS}, 'collapsed', now(), now(), 6),
           ('s2', ${WS}, 'active', now(), NULL, 2),
           ('s3', ${WS}, 'archived', now() - interval '10 days', NULL, 1),
           ('s9', ${OTHER}, 'active', now(), NULL, 50)
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_episode
      (id, workspace_id, title, narrative, occurred_at, topics, linked_fact_ids, sensitivity, is_synthetic)
    VALUES ('ep1', ${WS}, 't', 'n', now(), '{checkout,promo}', '{p1,r1}', 'internal', false),
           ('ep2', ${WS}, 't', 'n', now(), '{checkout}', '{p2}', 'public', false),
           ('ep3', ${WS}, 't', 'n', now(), '{hidden}', '{}', 'restricted', false),
           ('ep4', ${WS}, 't', 'n', now(), '{synthetic}', '{p1}', 'public', true)
  `;

  // Health snapshots: two today (the later one wins), one three days ago, one elsewhere.
  const snap = (
    id: string,
    ws: string,
    ago: string,
    active: number,
    zero: number,
    embedded: number
  ) =>
    admin`
      INSERT INTO mnemosyne.mnemo_health
        (id, workspace_id, snapshot_at, fact_count_active, fact_count_archived, fact_count_embedded,
         fact_count_unembedded, decision_count_active, relation_count_conflicts, facts_with_zero_hits,
         recall_hit_rate_30d, extraction_jobs_failed_7d, extraction_jobs_deferred, computed_in_ms)
      VALUES (${id}, ${ws}, now() - ${ago}::interval, ${active}, 0, ${embedded}, ${active - embedded},
              0, 0, ${zero}, 0.5, 2, 0, 1)
    `;
  await snap("h1", WS, "2 hours", 10, 9, 1);
  await snap("h2", WS, "1 minute", 10, 4, 8);
  await snap("h3", WS, "3 days", 4, 1, 4);
  await snap("h9", OTHER, "1 minute", 1, 1, 0);

  // Undo log: x1 (forgotten, public, seeded above) today; a restricted forget today; an
  // archive two days ago; an archive 40 days ago (outside 30 days); one elsewhere.
  await admin`
    INSERT INTO mnemosyne.mnemo_fact
      (id, workspace_id, scope, kind, subject, statement, status, sensitivity, valid_to)
    VALUES ('xr', ${WS}, 'global', 'other', 's', 'xr', 'forgotten', 'restricted', now())
  `;
  const archive = (id: string, ws: string, ago: string) => admin`
    INSERT INTO mnemosyne.mnemo_fact_archive
      (id, workspace_id, scope, kind, subject, statement, confidence, relevance, original_status,
       archive_reason, created_at, updated_at, sensitivity, archived_at)
    VALUES (${id}, ${ws}, 'global', 'other', 's', ${id}, 0.5, 0.5, 'active', 'decay',
            now() - interval '60 days', now() - interval '60 days', 'internal', now() - ${ago}::interval)
  `;
  await archive("ar1", WS, "2 days");
  await archive("ar2", WS, "40 days");
  await archive("ar9", OTHER, "0 days");

  // Recall calls (audit entries). Today: three readable (2 with hits, 1 empty) and one
  // encrypted detail. Yesterday: one empty. Out: 10 days ago, another workspace, a create.
  const audit = (ws: string, action: string, metadata: unknown, ago: string) => admin`
    INSERT INTO mnemosyne.mnemo_audit_log
      (workspace_id, actor_type, actor_id, action, resource, metadata, merkle_hash, created_at)
    VALUES (${ws}, 'agent', 'key:k', ${action}, 'recall', ${admin.json(metadata as never)},
            '\\x00'::bytea, now() - ${ago}::interval)
  `;
  await audit(WS, "recall", { resultCount: 3, topK: 5 }, "0 hours");
  await audit(WS, "recall", { resultCount: 1, topK: 5 }, "0 hours");
  await audit(WS, "recall", { resultCount: 0, topK: 5 }, "0 hours");
  await audit(WS, "recall", "enc:v1:opaque", "0 hours");
  await audit(WS, "recall", { resultCount: 0, topK: 5 }, "1 day");
  await audit(WS, "recall", { resultCount: 0, topK: 5 }, "10 days");
  await audit(OTHER, "recall", { resultCount: 0, topK: 5 }, "0 hours");
  await audit(WS, "create", { resultCount: 0 }, "0 hours");

  // Recall log: two serving calls today (latency 10 and 30: ranks 1+ repeat the call's
  // latency and are not counted again), one yesterday (50), one 10 days ago, one elsewhere.
  await admin`
    INSERT INTO mnemosyne.mnemo_recall_log (workspace_id, fact_id, hit_rank, latency_ms, recalled_at)
    VALUES
      (${WS}, 'p1', 0, 10, now()),
      (${WS}, 'p2', 1, 10, now()),
      (${WS}, 'p1', 0, 30, now()),
      (${WS}, 'p2', 1, 30, now()),
      (${WS}, 'a1', 2, 30, now()),
      (${WS}, 'p1', 0, 50, now() - interval '1 day'),
      (${WS}, 'p1', 0, 9999, now() - interval '10 days'),
      (${OTHER}, 'o1', 0, 7777, now())
  `;

  // Meter events: this month's usage, and one last month that /usage must not count.
  await admin`
    INSERT INTO mnemosyne.mnemo_meter_event (workspace_id, operation, units, idempotency_key, occurred_at)
    VALUES
      (${WS}, 'recall', 1, 'm1', now()),
      (${WS}, 'recall', 1, 'm2', now()),
      (${WS}, 'write', 3, 'm3', now()),
      (${WS}, 'recall', 5, 'm4', date_trunc('month', now()) - interval '1 day'),
      (${OTHER}, 'recall', 9, 'm5', now())
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;
  const adapterPgMod = await import("@mnemo-ai/adapter-postgres");
  const { db, pgClient } = adapterPgMod.createDrizzleClient(appUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient, undefined);
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys,
    storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "aggregates-test" });
}, 180_000);

afterAll(async () => {
  if (ENV_CEILING === undefined) delete process.env.MNEMO_SENSITIVITY_CEILING;
  else process.env.MNEMO_SENSITIVITY_CEILING = ENV_CEILING;
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("GET /recall/metrics (real DB, non-superuser role)", () => {
  it("counts calls, the zero-hit share over readable details and per-call latency, per UTC day", async () => {
    const { status, body } = await get("/recall/metrics?days=7");
    expect(status).toBe(200);
    expect(body.days).toHaveLength(7);
    const [{ d: today }] = await admin<Array<{ d: string }>>`
      SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d
    `;
    expect(body.days[6]).toEqual({
      day: today,
      queries: 4,
      zeroHitShare: 1 / 3,
      p50Ms: 20,
      p95Ms: 29,
    });
    expect(body.days[5]).toMatchObject({ queries: 1, zeroHitShare: 1, p50Ms: 50, p95Ms: 50 });
    expect(body.days.slice(0, 5).every((d: { queries: number }) => d.queries === 0)).toBe(true);
    expect(body.days[0]).toMatchObject({ zeroHitShare: null, p50Ms: null, p95Ms: null });
    // The window: 5 calls, 2 of the 4 readable ones empty; latencies 10, 30, 50.
    expect(body.totals).toEqual({ queries: 5, zeroHitShare: 0.5, p50Ms: 30, p95Ms: 48 });
  });

  it("defaults to 30 days and refuses a window outside 7–90", async () => {
    const { body } = await get("/recall/metrics");
    expect(body.days).toHaveLength(30);
    // The call ten days ago is inside a 30-day window.
    expect(body.totals.queries).toBe(6);
    expect((await get("/recall/metrics?days=6")).status).toBe(400);
    expect((await get("/recall/metrics?days=91")).status).toBe(400);
  });
});

describe("GET /facts/stats (real DB, non-superuser role)", () => {
  it("counts the live facts by kind, sensitivity and memory type", async () => {
    const { status, body } = await get("/facts/stats");
    expect(status).toBe(200);
    expect(body).toEqual({
      live: 4,
      pinned: 2,
      neverRecalled: 3,
      lastWriteAt: expect.any(String),
      byKind: [
        { kind: "preference", count: 2 },
        { kind: "architecture", count: 1 },
        { kind: "policy", count: 1 },
      ],
      bySensitivity: [
        { sensitivity: "internal", count: 2 },
        { sensitivity: "public", count: 1 },
        { sensitivity: "restricted", count: 1 },
      ],
      byMemoryType: [
        { memoryType: "semantic", count: 3 },
        { memoryType: "episodic", count: 1 },
      ],
    });
  });

  it("does not count facts above the caller's ceiling", async () => {
    // r1 (restricted) is written last: its timestamp must not show through lastWriteAt.
    await admin`UPDATE mnemosyne.mnemo_fact SET created_at = now() - interval '1 day' WHERE id <> 'r1'`;
    await admin`UPDATE mnemosyne.mnemo_fact SET created_at = now() WHERE id = 'r1'`;
    const [p1] = await admin<Array<{ created_at: Date }>>`
      SELECT max(created_at) AS created_at FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND id IN ('p1', 'p2', 'a1')`;
    const { body } = await get("/facts/stats", KEY_INTERNAL);
    expect(body.lastWriteAt).toBe(p1!.created_at.toISOString());
    expect(body.live).toBe(3);
    expect(body.pinned).toBe(1);
    expect(body.byKind.find((k: { kind: string }) => k.kind === "policy")).toBeUndefined();
    expect(body.bySensitivity.map((s: { sensitivity: string }) => s.sensitivity)).toEqual([
      "internal",
      "public",
    ]);
  });
});

describe("GET /graph/stats (real DB, non-superuser role)", () => {
  it("counts the open graph: nodes, typed relations, conflicts, isolated entities and hubs", async () => {
    const { status, body } = await get("/graph/stats");
    expect(status).toBe(200);
    expect(body).toEqual({
      entities: 4,
      decisions: 1,
      episodes: 3, // ep1–ep3 (the session seed); the synthetic one is left out
      relations: 2,
      conflicts: 1,
      isolated: 1,
      entitiesByKind: [
        { kind: "person", count: 2 },
        { kind: "concept", count: 1 },
        { kind: "project", count: 1 },
      ],
      relationsByType: [
        { relation: "part_of", count: 1 },
        { relation: "related", count: 1 },
      ],
      hubs: [
        { id: "e1", label: "Ada", degree: 2 },
        { id: "e2", label: "Atlas", degree: 1 },
        { id: "e4", label: "Root", degree: 1 },
      ],
    });
  });

  it("does not count entities above the caller's ceiling, nor their relations", async () => {
    const { body } = await get("/graph/stats", KEY_INTERNAL);
    expect(body).toMatchObject({ entities: 3, relations: 1, isolated: 1 });
    expect(body.hubs.map((h: { id: string }) => h.id)).toEqual(["e1", "e2"]);
  });
});

describe("GET /session/stats (real DB, non-superuser role)", () => {
  it("counts the window's sessions by status and its episodes, topics and readable facts", async () => {
    const { status, body } = await get("/session/stats?days=7");
    expect(status).toBe(200);
    expect(body.days).toHaveLength(7);
    expect(body.days[6]).toMatchObject({ active: 1, collapsed: 1, archived: 0 });
    expect(body.totals).toEqual({
      sessions: 2,
      collapsed: 1,
      avgTurns: 4,
      episodes: 3,
      factsPerEpisode: 1,
    });
    expect(body.topics).toEqual([
      { topic: "checkout", count: 2 },
      { topic: "hidden", count: 1 },
      { topic: "promo", count: 1 },
    ]);
    expect((await get("/session/stats")).body.totals.sessions).toBe(3);
    expect((await get("/session/stats?days=91")).status).toBe(400);
  });

  it("does not count episodes or linked facts above the caller's ceiling", async () => {
    const { body } = await get("/session/stats?days=7", KEY_INTERNAL);
    expect(body.totals).toMatchObject({ episodes: 2, factsPerEpisode: 1 });
    expect(body.topics.map((t: { topic: string }) => t.topic)).toEqual(["checkout", "promo"]);
  });
});

describe("GET /health/snapshots (real DB, non-superuser role)", () => {
  it("is refused to a key without memory:admin", async () => {
    expect((await get("/health/snapshots?days=7")).status).toBe(403);
  });

  it("gives each day's latest snapshot as shares, null on a day without one", async () => {
    const { status, body } = await get("/health/snapshots?days=7", KEY_ADMIN);
    expect(status).toBe(200);
    expect(body.days).toHaveLength(7);
    expect(body.days[6]).toMatchObject({
      recallHitRate30d: 0.5,
      zeroHitShare: 0.4,
      embeddedShare: 0.8,
      failedJobs7d: 2,
    });
    expect(body.days[3]).toMatchObject({ zeroHitShare: 0.25, embeddedShare: 1 });
    expect(body.days[0]).toMatchObject({
      recallHitRate30d: null,
      zeroHitShare: null,
      embeddedShare: null,
      failedJobs7d: null,
    });
  });
});

describe("GET /audit/stats (real DB, non-superuser role)", () => {
  it("counts user forgets and system archives per UTC day, under the ceiling", async () => {
    const { status, body } = await get("/audit/stats?days=30");
    expect(status).toBe(200);
    expect(body.days).toHaveLength(30);
    expect(body.days[29]).toMatchObject({ user: 2, system: 0 });
    expect(body.days[27]).toMatchObject({ user: 0, system: 1 });
    expect(body.totals).toEqual({ user: 2, system: 1 });
    const internal = await get("/audit/stats?days=30", KEY_INTERNAL);
    expect(internal.body.totals).toEqual({ user: 1, system: 1 });
  });
});

describe("GET /me/activity (real DB, non-superuser role)", () => {
  it("counts the caller's own audit entries per day and by action, nobody else's", async () => {
    // This key's own entries: two updates today, one create ten days ago (outside 7 days).
    const own = (action: string, ago: string) => admin`
      INSERT INTO mnemosyne.mnemo_audit_log
        (workspace_id, actor_type, actor_id, action, resource, metadata, merkle_hash, created_at)
      VALUES (${WS}, 'agent', 'key:key_agg_all', ${action}, 'fact', '{}'::jsonb,
              '\\x00'::bytea, now() - ${ago}::interval)
    `;
    await own("update", "0 hours");
    await own("update", "0 hours");
    await own("create", "10 days");
    const { status, body } = await get("/me/activity?days=7");
    expect(status).toBe(200);
    expect(body.days).toHaveLength(7);
    expect(body.byAction).toContainEqual({ action: "update", count: 2 });
    // The seeded 'key:k' entries and the old create are not this window's or this key's.
    expect(body.byAction.find((a: { action: string }) => a.action === "create")).toBeUndefined();
    expect(body.lastAt).not.toBeNull();
    const other = await get("/me/activity?days=7", KEY_INTERNAL);
    expect(
      other.body.byAction.find((a: { action: string }) => a.action === "update")
    ).toBeUndefined();
  });
});

describe("GET /usage (real DB, non-superuser role)", () => {
  it("reads this month's metered use from the durable table, under the workspace's RLS", async () => {
    const { status, body } = await get("/usage");
    expect(status).toBe(200);
    expect(body.metrics.recall).toMatchObject({ used: 2, limit: 1000 });
    expect(body.metrics.write).toMatchObject({ used: 3, limit: 500 });
  });
});
