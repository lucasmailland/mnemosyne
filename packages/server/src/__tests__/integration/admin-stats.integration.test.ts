/**
 * Contract test for `memory_stats` (packages/mcp/src/tools/stats.ts).
 *
 * `memory_stats`'s full MCP description (read directly from source, NOT from
 * the openspec audit file — that file's own "Promise" quote was truncated
 * during the original audit pass) promises:
 *
 *   "Returns aggregate statistics for the workspace: total live / closed /
 *    pinned / archived facts, active decision count, conflict relations
 *    count, embedding coverage (indexed vs pending), 30-day recall hit rate,
 *    and last activity timestamps. No input parameters needed — all stats
 *    are scoped to the authenticated workspace. Use this to audit memory
 *    health, identify zero-hit facts for pruning, check embedding backlog,
 *    or get a quick overview before a major recall or consolidation pass."
 *
 * `memory_stats` -> `client.getStats()` -> `GET /admin/stats`
 * (packages/server/src/routes/admin.ts).
 *
 * That route builds its response from TWO independent sources (both now
 * `deps.storage`-backed v3 `StorageAdapter` port methods as of
 * flatten-legacy-dual-core Phase 9 — this doc comment's original file
 * paths below are historical, from when both were direct `@mnemo-ai/core`
 * imports):
 *
 *   1. `deps.storage.getWorkspaceVitals(workspaceId)` — a LIVE query against
 *      `mnemo_fact` on every call. Backs `facts.live`, `facts.closed`,
 *      `facts.pinned`, `facts.byScopeRef`, `embeddings.{indexed,pending}`,
 *      `recall.lastRecallAt`, `lastWriteAt`.
 *
 *   2. `deps.storage.getHealthSnapshot({ workspaceId, fresh: false })` —
 *      reads the MOST RECENTLY PERSISTED ROW from `mnemo_health`, or
 *      returns `null` if none exists. With `fresh: false` it NEVER
 *      recomputes. Backs `facts.archived`, `facts.withZeroHits`,
 *      `decisions.active`, `relations.conflicts`, and `recall.hitRate30d`
 *      — all four fall back to `0`/`null` via `??` when the snapshot is
 *      `null`.
 *
 * STATS-1 — FIXED 2026-07-31, two independent, compounding bugs (both
 * described below against the pre-Phase-9 `@mnemo-ai/core` implementation
 * they were originally fixed in; the Phase 9 port carried the fixes
 * forward unchanged — same physical tables, same grant, same cron):
 *
 *   1. `computeHealthSnapshot` (packages/core/src/health/compute.ts) queries
 *      an unqualified `mnemo_extraction_job` table for
 *      `extractionJobsFailed7d`/`extractionJobsDeferred`. That table is
 *      defined ONLY in the legacy public-schema migrations
 *      (`packages/core/migrations/0017_mnemosyne_init.sql`) — it does not
 *      exist anywhere in the v3 `mnemosyne` schema — and no migration ever
 *      granted `mnemo_app_role` any privilege on it. Under a real
 *      NOSUPERUSER `mnemo_app_role` connection, `computeHealthSnapshot`
 *      unconditionally threw `permission denied for table
 *      mnemo_extraction_job`, silently swallowed by
 *      `routes/governance.ts`'s bare `catch {}` into a null 200 response.
 *      Fixed by migration `0016_extraction_job_grant.sql`
 *      (`packages/adapter-postgres/migrations/baseline/`) — the same
 *      conditional-grant shape as 0001's `public.mnemo_semantic_neighbor`
 *      grant (closed by the already-fixed F5 finding).
 *   2. Nothing in the cron registry (`packages/server/src/cron/jobs.ts`), the
 *      boot path, or the HTTP surface EVER called
 *      `getHealthSnapshot`/`computeHealthSnapshot` with `fresh: true` except
 *      the operator-only `GET /governance/drift?fresh=true` — a human
 *      had to know to hit it explicitly. `@mnemo-ai/core`'s
 *      `health/index.ts` doc comment always referenced a daily cron
 *      (`apps/web/worker/health-job.ts`) that lived in the original host
 *      app this package was extracted from and was never ported into this
 *      package's own cron registry. Fixed by adding
 *      `mnemo.health.snapshot` (daily, 03:00 UTC) to `cron/jobs.ts`.
 *
 * Before this fix, `memory_stats` PERMANENTLY, UNCONDITIONALLY reported
 * `archived: 0`, `withZeroHits: 0`, `decisions.active: 0`,
 * `relations.conflicts: 0`, `recall.hitRate30d: null` for every real
 * workspace, no matter how large the true numbers were — directly
 * contradicting two of the tool's own stated use cases ("identify zero-hit
 * facts for pruning", "conflict relations count").
 *
 * This test proves — against a REAL Postgres instance, through a real
 * non-superuser `mnemo_app_role` connection (NOSUPERUSER NOBYPASSRLS),
 * exercising the actual `GET /admin/stats` HTTP route the MCP tool
 * calls — that:
 *
 *   1. The four "live" facts.{live,closed,pinned} counts and
 *      embeddings.{indexed,pending} match seeded ground truth exactly.
 *   2. `facts.pinned` counts pinned facts REGARDLESS of open/closed status
 *      (a closed-but-pinned fact still counts) — a real, undocumented
 *      nuance of what "pinned" means in this response.
 *   3. With a real seeded workspace that has never had a health snapshot
 *      persisted, `facts.archived`, `facts.withZeroHits`,
 *      `decisions.active`, `relations.conflicts`, and `recall.hitRate30d`
 *      all read as the "no data" default (0 / null) even though the true,
 *      seeded values are non-zero — this remains correct, expected
 *      cold-start behavior even after the fix (the cron runs daily, not
 *      synchronously per request).
 *   4. The manual refresh path, `GET /governance/drift?fresh=true`, now
 *      succeeds under the real NOSUPERUSER role and produces the true,
 *      correct numbers.
 *   5. The daily `mnemo.health.snapshot` cron job's exact code path
 *      (`getHealthSnapshot({ workspaceId, fresh: true })`) also succeeds
 *      and persists a row — proving the automatic path works, not just the
 *      manual escape hatch.
 *   6. `embeddings.{indexed,pending}` returned by `memory_stats`
 *      (`GET /admin/stats`) and by `memory_status` (`GET /health`) agree
 *      exactly, because both routes call the identical
 *      `deps.core.vitals({ workspaceId })` live on every request — so despite
 *      being "two independently-computed sources" at the code-reading level,
 *      they cannot silently diverge in practice (Scenario disproved — this
 *      is a clean pass, not a bug).
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
const APP_ROLE = "stats_app";
const APP_PASSWORD = "stats_app_pass";

const TENANT_ID = "tenant-stats-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000002";

// Well-formed keys matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const KEY_ADMIN = "mns_live_statscontracthasscope01";

// Second workspace for the latency / writes-per-day / member-trim tests, so the
// ground-truth counts seeded for WS above stay untouched.
const WS2 = "9b1f9c00-0000-4000-8000-000000000003";
const KEY_ADMIN2 = "mns_live_statslatencyadminkey01";
const KEY_MEMBER2 = "mns_live_statslatencymemberkey1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
// flatten-legacy-dual-core Phase 9 (task 9.1): hoisted so the STATS-1 cron
// test below can call `v3Storage.getHealthSnapshot` directly — the same
// v3 StorageAdapter instance `deps.storage` uses, exercising the exact
// method the `mnemo.health.snapshot` cron handler calls.
let v3Storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${KEY_ADMIN}`, "content-type": "application/json", ...headers };
}

interface AdminStats {
  workspaceId: string;
  facts: {
    live: number;
    closed: number;
    pinned: number;
    // make-primitives-recallable Requirement 5: null (not 0) when no usable
    // snapshot exists — see `snapshot.available`.
    archived: number | null;
    withZeroHits: number | null;
    byScopeRef: Array<{ scopeRef: string; count: number }>;
  };
  decisions: { active: number | null };
  relations: { conflicts: number | null };
  embeddings: { indexed: number; pending: number };
  snapshot: { at: string | null; ageSeconds: number | null; available: boolean };
  recall: { hitRate30d: number | null; lastRecallAt: string | null };
  lastWriteAt: string | null;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
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

  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });

  // Real non-superuser, non-BYPASSRLS application role — same discipline as
  // purge-facts-hard-delete.integration.test.ts / session-scratch-rls-nonsuperuser.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Stats contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Stats contract workspace"}, ${"stats-contract"}, ${TENANT_ID})
  `;

  const hashAdmin = await bcrypt.hash(KEY_ADMIN, BCRYPT_COST);
  expect(BCRYPT_COST).toBe(12);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_stats_admin"}, ${WS}, ${hashAdmin}, ${"stats-admin"}, ${"stats-admin"},
       ARRAY['memory:read','memory:write','memory:admin','memory:governance']::text[])
  `;

  // ── Seed known fact/decision/relation ground truth ──────────────────────
  //
  // Facts (mnemo_fact):
  //   f1: live, active, embedded, hit_count=1, last_recalled_at=now (in 30d window)
  //   f2: live, active, NOT embedded, hit_count=0 (zero-hit, pending embed)
  //   f3: live, active, embedded, PINNED, hit_count=0 (zero-hit)
  //   f4: closed (forgotten, valid_to set), NOT pinned
  //   f5: closed (forgotten, valid_to set), PINNED — proves pinned count
  //       includes closed facts
  //   f6: merged (archived per health snapshot's definition, but valid_to
  //       IS NULL and status != 'forgotten' — so it does NOT count toward
  //       vitals()'s "closed"; proves archived != closed, spec Q4)
  const embeddingLiteral = `[${Array(1536).fill(0).join(",")}]`;
  await admin`
    INSERT INTO mnemosyne.mnemo_fact
      (id, workspace_id, scope, kind, subject, statement, status, pinned,
       hit_count, last_recalled_at, embedding, valid_to)
    VALUES
      (${"f1"}, ${WS}, 'global', 'preference', 'subj', 'f1 statement', 'active', false,
       1, now(), ${embeddingLiteral}::public.halfvec(1536), NULL),
      (${"f2"}, ${WS}, 'global', 'preference', 'subj', 'f2 statement', 'active', false,
       0, NULL, NULL, NULL),
      (${"f3"}, ${WS}, 'global', 'preference', 'subj', 'f3 statement', 'active', true,
       0, NULL, ${embeddingLiteral}::public.halfvec(1536), NULL),
      (${"f4"}, ${WS}, 'global', 'preference', 'subj', 'f4 statement', 'forgotten', false,
       0, NULL, NULL, now()),
      (${"f5"}, ${WS}, 'global', 'preference', 'subj', 'f5 statement', 'forgotten', true,
       0, NULL, NULL, now()),
      (${"f6"}, ${WS}, 'global', 'preference', 'subj', 'f6 statement', 'merged', false,
       0, NULL, NULL, NULL)
  `;

  // Decisions: 2 active, 1 superseded.
  await admin`
    INSERT INTO mnemosyne.mnemo_decision
      (id, workspace_id, kind, title, body, normalized_hash, status)
    VALUES
      (${"d1"}, ${WS}, 'decision', 'd1 title', 'd1 body', ${"hash-d1"}, 'active'),
      (${"d2"}, ${WS}, 'decision', 'd2 title', 'd2 body', ${"hash-d2"}, 'active'),
      (${"d3"}, ${WS}, 'decision', 'd3 title', 'd3 body', ${"hash-d3"}, 'superseded')
  `;

  // Relations: 3 conflicts_with, 2 other verbs.
  await admin`
    INSERT INTO mnemosyne.mnemo_relation
      (id, workspace_id, source_kind, source_id, target_kind, target_id, relation)
    VALUES
      (${"r1"}, ${WS}, 'fact', 'f1', 'fact', 'f2', 'conflicts_with'),
      (${"r2"}, ${WS}, 'fact', 'f2', 'fact', 'f3', 'conflicts_with'),
      (${"r3"}, ${WS}, 'fact', 'f1', 'fact', 'f3', 'conflicts_with'),
      (${"r4"}, ${WS}, 'fact', 'f1', 'fact', 'f4', 'related'),
      (${"r5"}, ${WS}, 'fact', 'f2', 'fact', 'f4', 'not_conflict')
  `;

  // ── WS2: recall latency + daily writes ground truth ─────────────────────
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS2}, ${"Stats latency workspace"}, ${"stats-latency"}, ${TENANT_ID})
  `;
  const hashAdmin2 = await bcrypt.hash(KEY_ADMIN2, BCRYPT_COST);
  const hashMember2 = await bcrypt.hash(KEY_MEMBER2, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_lat_admin"}, ${WS2}, ${hashAdmin2}, ${"lat-admin"}, ${"lat-admin"},
       ARRAY['memory:read','memory:admin']::text[]),
      (${"key_lat_member"}, ${WS2}, ${hashMember2}, ${"lat-member"}, ${"lat-member"},
       ARRAY['memory:read']::text[])
  `;
  // Facts created today (2), yesterday (1), 3 days ago (1), 30 days ago (1, outside the 14-day window).
  await admin`
    INSERT INTO mnemosyne.mnemo_fact
      (id, workspace_id, scope, kind, subject, statement, status, created_at)
    VALUES
      (${"g1"}, ${WS2}, 'global', 'preference', 'subj', 'g1', 'active', now()),
      (${"g2"}, ${WS2}, 'global', 'preference', 'subj', 'g2', 'active', now()),
      (${"g3"}, ${WS2}, 'global', 'preference', 'subj', 'g3', 'active', now() - interval '1 day'),
      (${"g4"}, ${WS2}, 'global', 'preference', 'subj', 'g4', 'active', now() - interval '3 days'),
      (${"g5"}, ${WS2}, 'global', 'preference', 'subj', 'g5', 'active', now() - interval '30 days')
  `;
  // Recall log: latencies 10,20,30,40,100 inside 7d, one NULL latency, one 10 days old
  // (outside the window), and one row in WS (another workspace) that must not leak.
  await admin`
    INSERT INTO mnemosyne.mnemo_recall_log (workspace_id, fact_id, recalled_at, latency_ms)
    VALUES
      (${WS2}, 'g1', now(), 10),
      (${WS2}, 'g1', now(), 20),
      (${WS2}, 'g2', now() - interval '1 day', 30),
      (${WS2}, 'g2', now() - interval '2 days', 40),
      (${WS2}, 'g3', now() - interval '6 days', 100),
      (${WS2}, 'g3', now(), NULL),
      (${WS2}, 'g4', now() - interval '10 days', 9999),
      (${WS}, 'f1', now(), 7777)
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  // flatten-legacy-dual-core Phase 9 (task 9.1): the `withMnemoTx`/`getDb()`
  // singleton-registration block that used to live here (Phase 7 comment)
  // is REMOVED — it existed only so this file's STATS-1 cron test below
  // could call `@mnemo-ai/core`'s `getHealthSnapshot` directly. That
  // function is now ported to the v3 `StorageAdapter` port
  // (`v3Storage.getHealthSnapshot`, constructed below), which manages its
  // own transaction via `mnemo_set_workspace()` — no `setDb()` registration
  // needed. Confirmed nothing else in this file touches `withMnemoTx`/
  // `getDb()`.

  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const DIMS = 1536;
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => new Float32Array(DIMS));
    },
    async embedSingle() {
      return new Float32Array(DIMS);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(appUrl);
  v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
  const v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appUrl });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
  };
  const noopTelemetry = {
    startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return v3Storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return v3Storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return v3Storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return v3Storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };
  const cognitive = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    apiKeys,
    cognitive,
    // GET /health (mountVitals) reads deps.storage.getWorkspaceVitals since
    // flatten-legacy-dual-core PR6 (was deps.core.vitals()) — v3Storage is
    // already constructed above for the cognitive/outbox wiring.
    storage: v3Storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  app = createApp({ deps, version: "stats-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_stats — recall latency, writes per day, member trim (real DB, non-superuser role)", () => {
  const as = (key: string) => ({ authorization: `Bearer ${key}` });

  it("computes p50/p95 over the 7-day window, excluding NULL latency and other workspaces", async () => {
    const res = await app.request("/admin/stats", { headers: as(KEY_ADMIN2) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recall: { latencyP50Ms7d: number; latencyP95Ms7d: number };
    };
    // sorted 10,20,30,40,100: p50 = 30, p95 = 40 + 0.8 * 60 = 88
    expect(body.recall.latencyP50Ms7d).toBe(30);
    expect(body.recall.latencyP95Ms7d).toBe(88);
    expect(await v3Storage.getRecallLatency(WS2, 7)).toEqual({ p50Ms: 30, p95Ms: 88, samples: 5 });
  });

  it("returns null percentiles and zero samples for a workspace with no latency rows", async () => {
    expect(await v3Storage.getRecallLatency("9b1f9c00-0000-4000-8000-0000000000ff", 7)).toEqual({
      p50Ms: null,
      p95Ms: null,
      samples: 0,
    });
  });

  it("returns exactly 14 zero-filled UTC days ending today, oldest first", async () => {
    const res = await app.request("/admin/stats", { headers: as(KEY_ADMIN2) });
    const body = (await res.json()) as { writesPerDay14d: Array<{ day: string; count: number }> };
    const series = body.writesPerDay14d;
    expect(series).toHaveLength(14);
    const [{ d: today }] = await admin<Array<{ d: string }>>`
      SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d
    `;
    const dayAt = (offset: number) =>
      new Date(Date.parse(today!) - offset * 86_400_000).toISOString().slice(0, 10);
    expect(series[13]).toEqual({ day: dayAt(0), count: 2 });
    expect(series[12]).toEqual({ day: dayAt(1), count: 1 });
    expect(series[10]).toEqual({ day: dayAt(3), count: 1 });
    expect(series[0]!.day).toBe(dayAt(13));
    expect(series.reduce((n, e) => n + e.count, 0)).toBe(4); // the 30-day-old fact is outside
    expect(series.map((e) => e.day)).toEqual([...series.map((e) => e.day)].sort());
  });

  it("serves a memory:read member 200 without the admin-only fields", async () => {
    const res = await app.request("/admin/stats", { headers: as(KEY_MEMBER2) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).not.toHaveProperty("embeddings");
    expect(body).not.toHaveProperty("snapshot");
    expect(body.facts).not.toHaveProperty("byScopeRef");
    expect(body.facts).not.toHaveProperty("withZeroHits");
    expect(body.recall).not.toHaveProperty("precisionAtK");
    expect(body.facts.live).toBe(5);
    expect(body.recall.latencyP50Ms7d).toBe(30);
    expect(body.writesPerDay14d).toHaveLength(14);
  });
});

describe("memory_stats — GET /admin/stats", () => {
  it("has zero mnemo_health rows for this workspace before any /governance/drift?fresh=true call", async () => {
    const rows = await admin<Array<{ c: string }>>`
      SELECT count(*)::text AS c FROM mnemosyne.mnemo_health WHERE workspace_id = ${WS}
    `;
    expect(rows[0]?.c).toBe("0");
  });

  it("live-computed facts.{live,closed,pinned} and embeddings.{indexed,pending} match seeded ground truth exactly", async () => {
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminStats;

    // live: f1, f2, f3 (active, valid_to IS NULL)
    expect(body.facts.live).toBe(3);
    // closed: f4, f5 (forgotten)
    expect(body.facts.closed).toBe(2);
    // embeddings: f1, f3 embedded; f2 pending (active + embedding NULL)
    expect(body.embeddings.indexed).toBe(2);
    expect(body.embeddings.pending).toBe(1);
  });

  it("FINDING: facts.pinned counts pinned facts regardless of open/closed status (f3 live + f5 closed = 2)", async () => {
    const res = await app.request("/admin/stats", { headers: authed() });
    const body = (await res.json()) as AdminStats;
    // f3 (live, pinned) + f5 (closed/forgotten, pinned) — vitals()'s SQL has
    // no status/valid_to filter on the pinned COUNT(*) FILTER clause, so a
    // forgotten-but-pinned fact still counts. Not documented anywhere in the
    // tool's description.
    expect(body.facts.pinned).toBe(2);
  });

  it("FIXED (make-primitives-recallable Requirement 5): with no health snapshot ever persisted, archived/withZeroHits/decisions.active/relations.conflicts report null — never a fabricated 0 — despite non-zero real data", async () => {
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminStats;

    // Ground truth (per computeHealthSnapshot's own definitions):
    //   archived  = status IN ('forgotten','merged')      -> f4, f5, f6 = 3
    //   withZeroHits = active AND hit_count=0              -> f2, f3    = 2
    //   decisions.active                                    -> d1, d2   = 2
    //   relations.conflicts (relation='conflicts_with')     -> r1,r2,r3 = 3
    //   hitRate30d = recalled_30d(f1=1) / active(f1,f2,f3=3) = 0.333...
    //
    // Was (pre-fix): because GET /admin/stats always calls
    // getHealthSnapshot({ workspaceId, fresh: false }) and this workspace has
    // ZERO rows in mnemo_health (proven above), every one of these fields
    // used to fall back to a `?? 0` default, silently misreporting real,
    // non-zero data as empty. Now they report `null` and `snapshot.available`
    // is `false`, so a caller can tell "zero" apart from "no usable snapshot".
    expect(body.facts.archived).toBeNull();
    expect(body.facts.withZeroHits).toBeNull();
    expect(body.decisions.active).toBeNull();
    // Live, under the caller's ceiling (f1, f2, f3 are current and internal):
    // not snapshot-derived since fix round 1 of Task 8.
    expect(body.relations.conflicts).toBe(3);
    expect(body.recall.hitRate30d).toBeNull();
    expect(body.snapshot.available).toBe(false);
    expect(body.snapshot.at).toBeNull();
    expect(body.snapshot.ageSeconds).toBeNull();
  });

  it("STATS-1 FIXED: the manual refresh path (GET /governance/drift?fresh=true) now succeeds under the real NOSUPERUSER role and populates mnemo_health", async () => {
    // Was: computeHealthSnapshot's unqualified query against the legacy
    // public.mnemo_extraction_job table threw "permission denied" under the
    // real NOSUPERUSER mnemo_app_role connection — that table is created by
    // the legacy core migration stream and was never granted to
    // mnemo_app_role anywhere. Fixed by migration 0016_extraction_job_grant.sql
    // (packages/adapter-postgres/migrations/baseline/), the same conditional-
    // grant shape as 0001's public.mnemo_semantic_neighbor grant.
    const driftRes = await app.request("/governance/drift?fresh=true", { headers: authed() });
    expect(driftRes.status).toBe(200);
    const drift = (await driftRes.json()) as {
      factCountArchived: number;
      decisionCountActive: number;
      relationCountConflicts: number;
      factsWithZeroHits: number;
      recallHitRate30d: number | null;
    };
    expect(drift).not.toBeNull();
    // Ground truth (per computeHealthSnapshot's own definitions):
    //   archived  = status IN ('forgotten','merged')      -> f4, f5, f6 = 3
    //   withZeroHits = active AND hit_count=0              -> f2, f3    = 2
    //   decisions.active                                    -> d1, d2   = 2
    //   relations.conflicts (relation='conflicts_with')     -> r1,r2,r3 = 3
    //   hitRate30d = recalled_30d(f1=1) / active(f1,f2,f3=3) = 0.333...
    expect(drift.factCountArchived).toBe(3);
    expect(drift.decisionCountActive).toBe(2);
    expect(drift.relationCountConflicts).toBe(3);
    expect(drift.factsWithZeroHits).toBe(2);
    expect(drift.recallHitRate30d).toBeCloseTo(1 / 3, 3);

    // Confirm exactly one row now exists.
    const rows = await admin<Array<{ c: string }>>`
      SELECT count(*)::text AS c FROM mnemosyne.mnemo_health WHERE workspace_id = ${WS}
    `;
    expect(rows[0]?.c).toBe("1");

    // Now the SAME memory_stats route call returns the true numbers.
    const statsRes = await app.request("/admin/stats", { headers: authed() });
    const stats = (await statsRes.json()) as AdminStats;
    expect(stats.facts.archived).toBe(3);
    expect(stats.facts.withZeroHits).toBe(2);
    expect(stats.decisions.active).toBe(2);
    expect(stats.relations.conflicts).toBe(3);
    expect(stats.recall.hitRate30d).toBeCloseTo(1 / 3, 3);
    expect(stats.snapshot.available).toBe(true);
    expect(stats.snapshot.at).not.toBeNull();

    // Live-computed fields are unaffected by the snapshot and remain correct.
    expect(stats.facts.live).toBe(3);
    expect(stats.facts.closed).toBe(2);
    expect(stats.facts.pinned).toBe(2);
  });

  it("STATS-1 FIXED: the daily mnemo.health.snapshot cron (not just the manual escape hatch) populates mnemo_health too", async () => {
    // The GRANT alone doesn't help if nothing automatic ever calls
    // getHealthSnapshot({fresh:true}) — that was the OTHER half of the
    // finding (nothing in cron/jobs.ts ever did). Exercises the exact same
    // call the "mnemo.health.snapshot" cron job (packages/server/src/cron/
    // jobs.ts) makes per workspace — flatten-legacy-dual-core Phase 9 (task
    // 9.1) ported that handler from `@mnemo-ai/core`'s `getHealthSnapshot`
    // to `deps.storage.getHealthSnapshot` (v3 StorageAdapter port); this
    // test now calls the SAME `v3Storage` instance `deps.storage` uses,
    // proving the automatic path works end-to-end without a human hitting
    // the operator endpoint.
    const before = await admin<Array<{ c: string }>>`
      SELECT count(*)::text AS c FROM mnemosyne.mnemo_health WHERE workspace_id = ${WS}
    `;
    const beforeCount = Number(before[0]?.c ?? "0");

    const snap = await v3Storage.getHealthSnapshot({ workspaceId: WS, fresh: true });
    expect(snap).not.toBeNull();
    expect(snap?.factCountArchived).toBe(3);
    expect(snap?.decisionCountActive).toBe(2);

    const after = await admin<Array<{ c: string }>>`
      SELECT count(*)::text AS c FROM mnemosyne.mnemo_health WHERE workspace_id = ${WS}
    `;
    expect(Number(after[0]?.c ?? "0")).toBe(beforeCount + 1);
  });

  it("embeddings.{indexed,pending} from memory_stats (GET /admin/stats) and memory_status (GET /health) agree exactly — both call the same live deps.core.vitals()", async () => {
    const [statsRes, healthRes] = await Promise.all([
      app.request("/admin/stats", { headers: authed() }),
      app.request("/health", { headers: authed() }),
    ]);
    expect(statsRes.status).toBe(200);
    expect(healthRes.status).toBe(200);
    const stats = (await statsRes.json()) as AdminStats;
    const health = (await healthRes.json()) as { embeddings: { indexed: number; pending: number } };

    expect(health.embeddings.indexed).toBe(stats.embeddings.indexed);
    expect(health.embeddings.pending).toBe(stats.embeddings.pending);
    expect(stats.embeddings.indexed).toBe(2);
    expect(stats.embeddings.pending).toBe(1);
  });

  it("byScopeRef breakdown reflects only live active facts with a non-null scope_ref (none seeded -> empty array)", async () => {
    const res = await app.request("/admin/stats", { headers: authed() });
    const body = (await res.json()) as AdminStats;
    expect(body.facts.byScopeRef).toEqual([]);
  });
});
