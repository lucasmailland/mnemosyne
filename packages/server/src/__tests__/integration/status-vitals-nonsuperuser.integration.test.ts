/**
 * Integration tests for the HTTP routes behind the `memory_status` MCP tool
 * (packages/mcp/src/tools/status.ts), against a REAL Postgres instance,
 * running the app connection as the NOSUPERUSER/NOBYPASSRLS `mnemo_app` role
 * production actually connects as. Mirrors the container/migration/role
 * provisioning pattern in `doctor-nonsuperuser.integration.test.ts` /
 * `boot-nonsuperuser.integration.test.ts`.
 *
 * `memory_status` calls four client methods in parallel:
 *   - `client.health()`      -> `GET /health`       (`mountVitals`, packages/server/src/routes/health.ts)
 *   - `client.getStats()`    -> `GET /admin/stats`   (packages/server/src/routes/admin.ts)
 *   - `client.getMe()`       -> `GET /me`            (packages/server/src/routes/keys.ts)
 *   - `client.healthReady()` -> `GET /health/ready`  (`mountProbes`, packages/server/src/routes/health.ts)
 *
 * This suite proves, against real Postgres:
 *
 *  1. FINDING (fixed 2026-07-31, see section 4): `GET /health` (what
 *     `client.health()` calls) does NOT return a `status`/`components`
 *     health field for db/embedder/queue — contrary to what the tool's
 *     (pre-fix) description and the client-ts `HealthSnapshot` type comment
 *     both claimed. It returns a workspace *vitals* snapshot: fact counts
 *     and embedding backlog. `deps.storage.getWorkspaceVitals()`
 *     (packages/adapter-postgres's FactRepository — was `deps.core.vitals()`
 *     until flatten-legacy-dual-core PR6 ported this route off `CoreLike`)
 *     is the sole source of this response and never queries embedder/queue
 *     subsystem health at all — there is no field it even COULD populate
 *     for that promise. `GET /admin/stats` (`client.getStats()`) and
 *     `GET /me`'s `personalFactsLive` field (`client.getMe()`) call the
 *     same `getWorkspaceVitals()` port method as of flatten-legacy-dual-core
 *     PR12 — both were still on the legacy `deps.core.vitals()` when this
 *     suite was first written. The real per-dependency probe lives at the
 *     separate, unauthenticated `GET /health/ready` / `GET /health/deep`
 *     routes — `memory_status` now calls `GET /health/ready` too (section 4
 *     below), so the tool's overall output IS accurate again, just via a
 *     second, additional upstream call rather than by `GET /health` itself
 *     changing shape.
 *
 *  2. The `facts.byScopeRef` breakdown returned by `GET /admin/stats` (what
 *     `memory_status` renders as "Facts by project (scopeRef)") accurately
 *     reflects real active, non-forgotten facts grouped by `scope_ref` —
 *     matching what a `GET /facts?scopeRef=...` (memory_recall/memory_search's
 *     underlying filter: `status='active' AND valid_to IS NULL`) would find.
 *     A forgotten fact and a null-scopeRef fact are correctly excluded.
 *
 *  3. The P10 personal-workspace section is correctly SKIPPED for a
 *     workspace-only key (no userId — the code never even attempts the
 *     downstream query), and now correctly APPEARS for a genuine user-bound
 *     key too. This was previously broken: `mnemo_workspace_read`'s RLS
 *     policy (packages/adapter-postgres migrations baseline) does an
 *     `EXISTS` subquery against `mnemo_workspace_member`, whose OWN read
 *     policy (`mnemo_workspace_member_read`) was self-referential (its
 *     `USING` clause queried `mnemo_workspace_member` again) — so ANY real,
 *     non-bypassing read of `mnemo_workspace` threw Postgres error
 *     `"infinite recursion detected in policy for relation
 *     \"mnemo_workspace_member\""`, unconditionally, regardless of which
 *     GUCs were set or what the WHERE clause was. `getUserPersonalWorkspaceId`
 *     (packages/server/src/recall/multi-level.ts) wraps its query in a
 *     blanket `try { ... } catch { return null; }`, so the error was
 *     silently indistinguishable from "this user genuinely has no personal
 *     workspace." Fixed in migration `0012_workspace_member_rls_recursion.sql`
 *     (packages/adapter-postgres/migrations/baseline/) by moving the
 *     self-referential membership check into a `SECURITY DEFINER` helper
 *     function (`mnemosyne.is_workspace_member`/`is_workspace_admin`), which
 *     evaluates the check with the migration-owner's (superuser) privileges
 *     instead of re-triggering the same RLS policy on itself. Note: the
 *     existing `api.integration.test.ts` and
 *     `doctor-nonsuperuser.integration.test.ts` suites never wire
 *     `deps.metricsPgClient` at all, so `GET /me`'s personal-workspace
 *     resolution was previously untested end-to-end against real Postgres —
 *     this suite was the first to exercise it and the first to surface (and
 *     now confirm the fix for) the bug.
 *
 *  4. FIXED (2026-07-31): `GET /health/ready` DOES return real per-dependency
 *     status — `{status: "ready"|"not_ready", degraded, checks: {postgres,
 *     vector, cache}}` — proven here against real Postgres (`postgres: "ok"`
 *     comes from an actual `deps.storage.healthCheck()` round-trip, not a
 *     stub — was `deps.core.ping()` until flatten-legacy-dual-core PR6). This
 *     route is unauthenticated and instance-wide (no `workspaceId` scoping,
 *     unlike `GET /health`), which `memory_status` now discloses via its
 *     `dependencyHealth` field. `memory_status`'s remaining gap (item 1) is
 *     closed: the combined 4-call output has both accurate workspace vitals
 *     (`GET /health`) and accurate per-dependency status (`GET /health/ready`).
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
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test_status";

const WS = "ee110001-0001-0001-0001-000000000001";
const PERSONAL_TENANT_ID = "ee110001-tenant-personal-0001";
const PERSONAL_WS = "ee110001-0002-0002-0002-000000000002";
const USER_ID = "ee110001-user-0000-0000-000000000003";

const KEY_WORKSPACE_ONLY = "mns_live_statuscontractworkspaceonly1";
const KEY_USER_BOUND = "mns_live_statuscontractuserbound0001";

let container: StartedTestContainer;
let host: string;
let port: number;
let superUrl: string;
let appUrl: string;
let admin: ReturnType<typeof postgres>;
let metricsPgClient: ReturnType<typeof postgres>;
let apiKeys: Awaited<ReturnType<typeof import("@mnemo-ai/core").createApiKeyLookup>>;
let storage: DrizzleStorageAdapter;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** Insert a fact directly into mnemo_fact via the superuser connection (test seeding only). */
async function seedFact(opts: {
  id: string;
  workspaceId: string;
  scopeRef?: string | null;
  status?: "active" | "forgotten";
}): Promise<void> {
  const status = opts.status ?? "active";
  // valid_from is set in the past so any valid_to (set "now", strictly later)
  // never inverts the tstzrange(valid_from, valid_to) GiST index constraint
  // (lower bound must be <= upper bound).
  const validFrom = new Date(Date.now() - 60_000); // determinism-ok: relative seed timestamp, not an assertion value
  const validTo = status === "forgotten" ? new Date() : null; // determinism-ok: seed timestamp, not an assertion value
  await admin`
    INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, scope_ref, kind, subject, statement, status, valid_from, valid_to)
    VALUES (${opts.id}, ${opts.workspaceId}, ${"global"}, ${opts.scopeRef ?? null}, ${"other"}, ${"workspace"}, ${"status contract test fact " + opts.id}, ${status}, ${validFrom}, ${validTo})
  `;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  host = container.getHost();
  port = container.getMappedPort(5432);
  superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

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

  admin = postgres(superUrl, { max: 5, onnotice: () => void 0 });

  await admin.unsafe(`
    DO $provision$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
        CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $provision$;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT app_user       TO ${APP_USER};
    GRANT app_org_user   TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public    TO ${APP_USER};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO mnemo_app_role;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public    TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mnemosyne TO mnemo_app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public    TO app_user;
  `);

  // ── Seed: tenant + workspace (scopeRef test) ──────────────────────────────
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${"tenant-status-main"}, ${"status contract tenant"}, ${"organization"})`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"status contract workspace"}, ${"status-contract-ws"}, ${"tenant-status-main"})
  `;

  // ── Seed: personal tenant + personal workspace + user (P10 test) ─────────
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${PERSONAL_TENANT_ID}, ${"personal tenant"}, ${"personal"})`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${PERSONAL_WS}, ${"personal workspace"}, ${"status-contract-personal-ws"}, ${PERSONAL_TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id)
    VALUES (${USER_ID}, ${"status-contract-user@example.com"}, ${PERSONAL_TENANT_ID})
  `;

  // ── Seed facts for scopeRef breakdown (WS) ────────────────────────────────
  await seedFact({ id: "fact_status_scoperef_a1", workspaceId: WS, scopeRef: "mnemosyne" });
  await seedFact({ id: "fact_status_scoperef_a2", workspaceId: WS, scopeRef: "mnemosyne" });
  await seedFact({ id: "fact_status_scoperef_b1", workspaceId: WS, scopeRef: "project:abc" });
  await seedFact({ id: "fact_status_scoperef_null", workspaceId: WS, scopeRef: null });
  await seedFact({
    id: "fact_status_scoperef_forgotten",
    workspaceId: WS,
    scopeRef: "mnemosyne",
    status: "forgotten",
  });

  // ── Seed facts in the personal workspace (personalFactsLive) ──────────────
  await seedFact({ id: "fact_status_personal_1", workspaceId: PERSONAL_WS, scopeRef: null });
  await seedFact({ id: "fact_status_personal_2", workspaceId: PERSONAL_WS, scopeRef: null });
  await seedFact({
    id: "fact_status_personal_forgotten",
    workspaceId: PERSONAL_WS,
    scopeRef: null,
    status: "forgotten",
  });

  // ── API keys ───────────────────────────────────────────────────────────────
  const [hashWorkspaceOnly, hashUserBound] = await Promise.all([
    bcrypt.hash(KEY_WORKSPACE_ONLY, BCRYPT_COST),
    bcrypt.hash(KEY_USER_BOUND, BCRYPT_COST),
  ]);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes, user_id)
    VALUES
      (${"key_status_ws_only"}, ${WS}, ${hashWorkspaceOnly}, ${"status-ws-only"}, ${"status-ws-only"},
       ARRAY['memory:read','memory:write','memory:admin']::text[], ${null}),
      (${"key_status_user_bound"}, ${WS}, ${hashUserBound}, ${"status-user-bound"}, ${"status-user-bound"},
       ARRAY['memory:read','memory:write','memory:admin']::text[], ${USER_ID})
  `;

  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;
  metricsPgClient = postgres(appUrl, { max: 5, onnotice: () => void 0 });

  const coreMod = await import("@mnemo-ai/core");
  apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  // Same nonsuperuser appUrl as `core` above — GET /health (vitals) and
  // GET /health/ready (connectivity) now go through this v3 StorageAdapter
  // instead of `core.vitals()`/`core.ping()` (flatten-legacy-dual-core PR6).
  const storageClient = createDrizzleClient(appUrl);
  storage = new DrizzleStorageAdapter(storageClient.db, storageClient.pgClient);

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  deps = {
    apiKeys,
    storage,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    cognitive: undefined,
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
    metricsPgClient,
  } as unknown as ServerDeps;

  app = createApp({ deps, version: "status-contract-test" });
}, 180_000);

afterAll(async () => {
  await storage?.close().catch(() => void 0);
  await apiKeys?.close?.().catch(() => void 0);
  await metricsPgClient?.end().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

// ─── 1. GET /health — promise vs reality ─────────────────────────────────────

describe("GET /health (mountVitals) — what client.health() actually returns", () => {
  it("FINDING: returns workspace vitals (fact counts + embeddings), with NO status/components field for db/embedder/queue", async () => {
    const res = await app.request("/health", { headers: authed(KEY_WORKSPACE_ONLY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // What the tool's (pre-fix) description / the client-ts HealthSnapshot
    // type comment claimed this endpoint exposes — it does not.
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("components");

    // What it actually returns: workspace vitals.
    expect(body.workspaceId).toBe(WS);
    expect(typeof body.factsLive).toBe("number");
    expect(typeof body.factsClosed).toBe("number");
    expect(typeof body.pinnedCount).toBe("number");
    expect(body.embeddings).toBeDefined();
    expect(typeof (body.embeddings as Record<string, unknown>).indexed).toBe("number");
    expect(typeof (body.embeddings as Record<string, unknown>).pending).toBe("number");

    // 4 active facts seeded in WS (2 "mnemosyne" + 1 "project:abc" + 1 null-scopeRef);
    // the forgotten one is excluded from factsLive.
    expect(body.factsLive).toBe(4);
    expect(body.factsClosed).toBe(1);
  });

  it("a real DB outage during the vitals query makes GET /health fail loudly (503/500), not silently report healthy", async () => {
    // Point the storage adapter's getWorkspaceVitals at a simulated outage —
    // the closest a real-Postgres suite gets to a genuine DB outage without
    // tearing down the shared container used by every other test in this
    // file. GET /health (mountVitals) reads deps.storage.getWorkspaceVitals
    // since flatten-legacy-dual-core PR6 (was core.vitals()).
    const badStorage = {
      ...storage,
      getWorkspaceVitals: async () => {
        throw new Error("ECONNREFUSED: simulated DB outage");
      },
    };
    const badDeps = { ...deps, storage: badStorage } as unknown as ServerDeps;
    const badApp = createApp({ deps: badDeps, version: "status-contract-test-bad" });
    const res = await badApp.request("/health", { headers: authed(KEY_WORKSPACE_ONLY) });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// ─── 2. GET /admin/stats — scopeRef breakdown accuracy ───────────────────────

describe("GET /admin/stats — facts.byScopeRef accuracy", () => {
  it("groups only ACTIVE, non-forgotten facts by scope_ref, excluding null and forgotten", async () => {
    const res = await app.request("/admin/stats", { headers: authed(KEY_WORKSPACE_ONLY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      facts: {
        live: number;
        closed: number;
        byScopeRef: Array<{ scopeRef: string; count: number }>;
      };
    };

    expect(body.facts.live).toBe(4);
    expect(body.facts.closed).toBe(1);

    const byRef = Object.fromEntries(body.facts.byScopeRef.map((r) => [r.scopeRef, r.count]));
    expect(byRef["mnemosyne"]).toBe(2);
    expect(byRef["project:abc"]).toBe(1);
    // The forgotten fact (scope_ref="mnemosyne", status="forgotten") must NOT
    // be counted — the breakdown should reflect only currently-active facts,
    // matching what memory_recall/memory_search with scopeRef="mnemosyne"
    // would find (3 facts exist with that scopeRef total, but only 2 active).
    expect(byRef["mnemosyne"]).not.toBe(3);
    // null-scopeRef fact is excluded entirely (no undefined/null key).
    expect(Object.keys(byRef)).not.toContain("null");
    expect(Object.keys(byRef)).not.toContain("undefined");
  });
});

// ─── 3. GET /me — P10 personal workspace gating ──────────────────────────────

describe("GET /me — personal workspace section respects key type (P10)", () => {
  it("workspace-scoped key (no userId) -> personalWorkspaceId is null (correct, and does not even attempt the broken query below)", async () => {
    const res = await app.request("/me", { headers: authed(KEY_WORKSPACE_ONLY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string | null;
      personalWorkspaceId: string | null;
      personalFactsLive: number | null;
    };
    expect(body.userId).toBeNull();
    expect(body.personalWorkspaceId).toBeNull();
    expect(body.personalFactsLive).toBeNull();
  });

  it("REGRESSION (was: root cause of infinite recursion): a real, non-bypassing read of mnemosyne.mnemo_workspace now succeeds — no GUCs, role-switching, or WHERE clause combination throws", async () => {
    // Previously, mnemo_workspace_read's policy (packages/adapter-postgres
    // migrations baseline) did an EXISTS subquery against
    // mnemo_workspace_member, whose OWN read policy (mnemo_workspace_member_read)
    // was self-referential — a policy on mnemo_workspace_member whose own
    // USING clause queried mnemo_workspace_member again. Postgres could not
    // resolve this and always errored. Fixed in migration
    // 0012_workspace_member_rls_recursion.sql. Proven 4 ways below: bare
    // SELECT with zero GUCs, with SET LOCAL ROLE app_user, with no role
    // switch, and with actor_user_id set + a tenant_id filter (the exact
    // shape getUserPersonalWorkspaceId uses). All four now resolve cleanly.
    const attempts: Array<() => Promise<unknown>> = [
      () => metricsPgClient`SELECT id FROM mnemosyne.mnemo_workspace LIMIT 1`,
      () =>
        metricsPgClient.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_user`;
          return tx`SELECT id FROM mnemosyne.mnemo_workspace WHERE id = ${WS} LIMIT 1`;
        }),
      () =>
        metricsPgClient.begin(
          (tx) => tx`SELECT id FROM mnemosyne.mnemo_workspace WHERE id = ${WS} LIMIT 1`
        ),
      () =>
        metricsPgClient.begin(async (tx) => {
          await tx`SELECT set_config('mnemosyne.actor_user_id', ${USER_ID}, true)`;
          return tx`SELECT id FROM mnemosyne.mnemo_workspace WHERE tenant_id = ${PERSONAL_TENANT_ID} LIMIT 1`;
        }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).resolves.not.toThrow();
    }
  });

  it("REGRESSION (was: silently swallowed to null): user-bound key -> personalWorkspaceId and personalFactsLive now correctly resolve to the real personal workspace and its live fact count", async () => {
    // Previously, getUserPersonalWorkspaceId (packages/server/src/recall/
    // multi-level.ts) wraps its query in a blanket try/catch that swallows
    // ANY error to `null`, so the "infinite recursion" error from
    // mnemo_workspace's RLS policy was never surfaced — it silently looked
    // like "no personal workspace registered for this user," identical to
    // the case where one genuinely doesn't exist. Now that the RLS
    // recursion is fixed (migration 0012), the query succeeds and the
    // catch-all no longer masks anything.
    const res = await app.request("/me", { headers: authed(KEY_USER_BOUND) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string | null;
      personalWorkspaceId: string | null;
      personalFactsLive: number | null;
    };
    expect(body.userId).toBe(USER_ID);
    // The real personal workspace (PERSONAL_WS, with 2 live facts seeded in
    // beforeAll) now correctly surfaces.
    expect(body.personalWorkspaceId).toBe(PERSONAL_WS);
    expect(body.personalFactsLive).toBe(2);
  });
});

// ─── 4. End-to-end: the exact 3 calls memory_status makes ────────────────────

// ─── 4. GET /health/ready — real per-dependency status (2026-07-31 fix) ─────

describe("GET /health/ready — real per-dependency status against real Postgres", () => {
  it("FIXED: checks.postgres:ok comes from a real round-trip — no auth header needed; unwired probes report unknown, so degraded:true (P127)", async () => {
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      degraded: boolean;
      checks: { postgres: string; vector: string; cache: string; embed: string };
    };
    expect(body.status).toBe("ready");
    // checks.postgres comes from a real deps.storage.healthCheck() round-trip
    // (flatten-legacy-dual-core PR6 — was deps.core.ping()). This test wires no
    // healthAdapters.vector/cache/embed: since P127 an absent probe reports
    // "unknown", never "ok", and "unknown" counts as degraded.
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.vector).toBe("unknown");
    expect(body.checks.cache).toBe("unknown");
    expect(body.checks.embed).toBe("unknown");
    expect(body.degraded).toBe(true);
  });

  it("with every probe wired and healthy, /health/ready is ready and not degraded", async () => {
    const ok = { healthCheck: async () => ({ status: "ok", latencyMs: 0 }) };
    const wiredDeps = {
      ...deps,
      healthAdapters: { vector: ok, cache: ok, embed: ok },
    } as unknown as ServerDeps;
    const wiredApp = createApp({ deps: wiredDeps, version: "status-contract-test-wired" });
    const res = await wiredApp.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      degraded: boolean;
      checks: { postgres: string; vector: string; cache: string; embed: string };
    };
    expect(body.status).toBe("ready");
    expect(body.degraded).toBe(false);
    expect(body.checks).toEqual({ postgres: "ok", vector: "ok", cache: "ok", embed: "ok" });
  });

  it("a real DB outage makes /health/ready report not_ready:503 with reason postgres_unavailable, not a silent ready", async () => {
    const badStorage = {
      ...storage,
      healthCheck: async () => {
        throw new Error("ECONNREFUSED: simulated DB outage");
      },
    };
    const badDeps = { ...deps, storage: badStorage } as unknown as ServerDeps;
    const badApp = createApp({ deps: badDeps, version: "status-contract-test-bad" });
    const res = await badApp.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("not_ready");
    expect(body.reason).toBe("postgres_unavailable");
  });
});

// ─── 5. memory_status's 4 upstream calls, combined (end-to-end proof) ───────

describe("memory_status's 4 upstream calls, combined (end-to-end real-Postgres proof)", () => {
  it("workspace-only key: health has no status/components, stats has the scopeRef breakdown, me correctly has no personal section (no userId), healthReady has real per-dependency checks", async () => {
    const [healthRes, statsRes, meRes, readyRes] = await Promise.all([
      app.request("/health", { headers: authed(KEY_WORKSPACE_ONLY) }),
      app.request("/admin/stats", { headers: authed(KEY_WORKSPACE_ONLY) }),
      app.request("/me", { headers: authed(KEY_WORKSPACE_ONLY) }),
      app.request("/health/ready", { headers: authed(KEY_WORKSPACE_ONLY) }),
    ]);
    expect(healthRes.status).toBe(200);
    expect(statsRes.status).toBe(200);
    expect(meRes.status).toBe(200);
    expect(readyRes.status).toBe(200);

    const health = (await healthRes.json()) as Record<string, unknown>;
    const stats = (await statsRes.json()) as {
      facts: { byScopeRef: Array<{ scopeRef: string; count: number }> };
    };
    const me = (await meRes.json()) as { personalWorkspaceId: string | null };
    const ready = (await readyRes.json()) as { status: string; checks: { postgres: string } };

    expect(health).not.toHaveProperty("status");
    expect(stats.facts.byScopeRef.length).toBeGreaterThan(0);
    expect(me.personalWorkspaceId).toBeNull();
    expect(ready.status).toBe("ready");
    expect(ready.checks.postgres).toBe("ok");
  });

  it("REGRESSION (was: FINDING, RLS recursion): user-bound key -> me now correctly carries the real personal workspace id and its live fact count", async () => {
    const meRes = await app.request("/me", { headers: authed(KEY_USER_BOUND) });
    const me = (await meRes.json()) as {
      personalWorkspaceId: string | null;
      personalFactsLive: number | null;
    };
    expect(me.personalWorkspaceId).toBe(PERSONAL_WS);
    expect(me.personalFactsLive).toBe(2);
  });
});
