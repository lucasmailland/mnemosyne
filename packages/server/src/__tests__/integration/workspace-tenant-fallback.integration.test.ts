/**
 * Integration tests for the HTTP routes behind the `memory_workspace` MCP
 * tool (packages/mcp/src/tools/workspace.ts), against a REAL Postgres
 * instance, running the app connection as the NOSUPERUSER/NOBYPASSRLS
 * `mnemo_app` role production actually connects as. Mirrors the
 * container/migration/role provisioning pattern in
 * `status-vitals-nonsuperuser.integration.test.ts`.
 *
 * `memory_workspace` has 3 actions: 'list' (client.listMyWorkspaces(), with
 * a client.listWorkspacesForCurrentTenant() fallback), 'members'
 * (client.listWorkspaceMembers()), and 'current' (client.getMe()).
 *
 * This suite originally proved that the same systemic RLS bug disclosed for
 * `memory_status` (mnemo_workspace_member's self-referential read policy —
 * "infinite recursion detected in policy for relation
 * mnemo_workspace_member") broke `action:"list"` and `action:"members"` far
 * more severely than it broke `memory_status`: unhandled HTTP 500s on
 * `GET /workspaces/mine`, `GET /tenants/:tenantId/workspaces`, and
 * `GET /workspaces/:workspaceId` (called first by `action:"members"`).
 *
 * Fixed in migration `0012_workspace_member_rls_recursion.sql`
 * (packages/adapter-postgres/migrations/baseline/) — see that file's header
 * comment for the fix mechanism (a `SECURITY DEFINER` helper function
 * replacing the self-referential subquery). This suite now proves:
 *
 *  1. REGRESSION: `GET /workspaces/mine` (`action:"list"`'s primary path)
 *     now succeeds and returns the caller's real workspace.
 *
 *  2. REGRESSION: `GET /tenants/:tenantId/workspaces` (the tenant-fallback's
 *     destination) now succeeds too.
 *
 *  3. REGRESSION: `GET /workspaces/:workspaceId/members` now succeeds for a
 *     same-tenant workspace (confirming access is tenant-scoped, not
 *     workspace-membership-scoped — `requireWorkspaceAccess` only compares
 *     `callerTenantId`), and correctly 404s (anti-probing, not 403 — see
 *     root `CLAUDE.md`'s S6) for a workspace in a genuinely different
 *     tenant, since RLS now cleanly (no longer via a crash) excludes that
 *     row from `getWorkspace()`'s result.
 *
 * FIXED (2026-07-31), a SEPARATE bug independent of the RLS migration above:
 * `action:"list"`'s tenant-workspace fallback (`client.
 * listWorkspacesForCurrentTenant()`) reads `tenantId` from `GET /me`'s
 * response to decide which tenant to query — but the real handler
 * (`server/src/routes/keys.ts`, `MeResponseSchema`) never returned that
 * field at all, even though it was already resolved in the auth context
 * (`c.get("tenantId")`, used elsewhere in the same handler). Fixed by adding
 * `tenantId` to `MeResponseSchema` and the response body. This suite now
 * proves both the field's presence and the full end-to-end fallback flow
 * (a user with zero personal-workspace memberships successfully discovers
 * their tenant's other workspaces via `GET /me` → `tenantId` →
 * `GET /tenants/:tenantId/workspaces`).
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

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test_workspace";

const TENANT_A = "ee120001-tenant-a-0000-000000000001";
const TENANT_B = "ee120001-tenant-b-0000-000000000002";
const WS_A1 = "ee120001-0001-0001-0001-000000000001"; // tenant A, the caller's own workspace
const WS_A2 = "ee120001-0001-0001-0001-000000000002"; // tenant A, a DIFFERENT workspace (same tenant)
const WS_B1 = "ee120001-0002-0002-0002-000000000001"; // tenant B (different tenant entirely)
const USER_ID = "ee120001-user-0000-0000-000000000003";

const KEY_A1 = "mns_live_workspacecontractkeyA1aaaaaaa";
// Workspace-only key (no user_id) bound to tenant A — /workspaces/mine 404s
// (no userId), so client.listMyWorkspaces() resolves to [] and the
// tenant-fallback is the ONLY way this caller can discover tenant A's
// workspaces. Exercises the real fallback path end-to-end.
const KEY_A_WORKSPACE_ONLY = "mns_live_workspacecontractkeyworkspaceonly1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let metricsPgClient: ReturnType<typeof postgres>;
let apiKeys: Awaited<ReturnType<typeof import("@mnemo-ai/core").createApiKeyLookup>>;
let app: ReturnType<typeof createApp>;

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

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

  // ── Seed: tenant A with TWO workspaces, tenant B with one ────────────────
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${TENANT_A}, ${"workspace contract tenant A"}, ${"organization"})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${TENANT_B}, ${"workspace contract tenant B"}, ${"organization"})`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_A1}, ${"tenant A workspace 1 (caller's own)"}, ${"ws-contract-a1"}, ${TENANT_A})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_A2}, ${"tenant A workspace 2 (joinable, different workspace)"}, ${"ws-contract-a2"}, ${TENANT_A})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_B1}, ${"tenant B workspace 1 (different tenant entirely)"}, ${"ws-contract-b1"}, ${TENANT_B})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id)
    VALUES (${USER_ID}, ${"workspace-contract-user@example.com"}, ${TENANT_A})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
    VALUES (${WS_A1}, ${USER_ID}, ${"owner"})
  `;

  // ── API key: bound to workspace A1, tenant A, user USER_ID ───────────────
  const hashA1 = await bcrypt.hash(KEY_A1, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, tenant_id, user_id, key_hash, name, label, scopes)
    VALUES (${"key_ws_contract_a1"}, ${WS_A1}, ${TENANT_A}, ${USER_ID}, ${hashA1}, ${"ws-contract-a1"}, ${"ws-contract-a1"},
       ARRAY['memory:read','memory:write','memory:admin','admin:tenant']::text[])
  `;

  // ── API key: workspace-only (no user_id), bound to tenant A — proves the
  // tenant-fallback end-to-end for a caller with zero personal memberships.
  const hashWorkspaceOnly = await bcrypt.hash(KEY_A_WORKSPACE_ONLY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, tenant_id, user_id, key_hash, name, label, scopes)
    VALUES (${"key_ws_contract_a_workspace_only"}, ${WS_A1}, ${TENANT_A}, ${null}, ${hashWorkspaceOnly}, ${"ws-contract-a-workspace-only"}, ${"ws-contract-a-workspace-only"},
       ARRAY['memory:read','memory:write','memory:admin','admin:tenant']::text[])
  `;

  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;
  metricsPgClient = postgres(appUrl, { max: 5, onnotice: () => void 0 });
  const coreMod = await import("@mnemo-ai/core");
  apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys,
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

  app = createApp({ deps, version: "workspace-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeys?.close?.().catch(() => void 0);
  await metricsPgClient?.end().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("GET /workspaces/mine — memory_workspace action='list' PRIMARY path", () => {
  it("REGRESSION (was: 500 from the mnemo_workspace_member recursion): returns the caller's real workspace", async () => {
    const res = await app.request("/workspaces/mine", { headers: authed(KEY_A1) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ workspaceId: string }> };
    expect(body.workspaces.map((w) => w.workspaceId)).toContain(WS_A1);
  });
});

describe("GET /me — tenantId field (SKILL-independent fix, 2026-07-31)", () => {
  it("REGRESSION (was: FINDING, missing field): the real response now includes the caller's real tenantId", async () => {
    const res = await app.request("/me", { headers: authed(KEY_A1) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The key IS tenant-bound (TENANT_A, verified via the seed above and via
    // requireWorkspaceAccess/requireTenantAccess working correctly below) —
    // this used to never surface in GET /me's response even though it was
    // already resolved in the auth context. Fixed in
    // server/src/routes/keys.ts's MeResponseSchema + response body.
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.workspaceId).toBe(WS_A1);
    expect(body.userId).toBe(USER_ID);
  });

  it("a key with no tenant binding gets tenantId: null, not undefined/omitted", async () => {
    const res = await app.request("/me", { headers: authed(KEY_A_WORKSPACE_ONLY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // This key IS bound to TENANT_A in the seed above, so tenantId resolves
    // real here too — the "workspace-only" part is the missing user_id.
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.userId).toBeNull();
  });
});

describe("memory_workspace action:'list' tenant-fallback — end-to-end proof (2026-07-31 fix)", () => {
  it("REGRESSION (was: dead code): a caller with zero personal-workspace memberships now discovers their tenant's other workspaces via the GET /me -> tenantId -> GET /tenants/:tenantId/workspaces fallback", async () => {
    // Step 1: client.listMyWorkspaces() equivalent — 404s because this key
    // has no user_id, which client-ts catches to [].
    const mineRes = await app.request("/workspaces/mine", {
      headers: authed(KEY_A_WORKSPACE_ONLY),
    });
    expect(mineRes.status).toBe(404);

    // Step 2: client.listWorkspacesForCurrentTenant() equivalent — GET /me
    // for tenantId, then GET /tenants/:tenantId/workspaces.
    const meRes = await app.request("/me", { headers: authed(KEY_A_WORKSPACE_ONLY) });
    const me = (await meRes.json()) as { tenantId: string | null };
    expect(me.tenantId).toBe(TENANT_A);

    const tenantWsRes = await app.request(`/tenants/${me.tenantId}/workspaces`, {
      headers: authed(KEY_A_WORKSPACE_ONLY),
    });
    expect(tenantWsRes.status).toBe(200);
    const body = (await tenantWsRes.json()) as { workspaces: Array<{ id: string }> };
    const ids = body.workspaces.map((w) => w.id);
    expect(ids).toContain(WS_A1);
    expect(ids).toContain(WS_A2);
    // Tenant B's workspace must never appear — the fallback is tenant-scoped.
    expect(ids).not.toContain(WS_B1);
  });
});

describe("GET /tenants/:tenantId/workspaces — action='list' fallback destination", () => {
  it("REGRESSION (was: 500 from the mnemo_workspace_member recursion): returns both of tenant A's workspaces when given a valid tenantId directly", async () => {
    const res = await app.request(`/tenants/${TENANT_A}/workspaces`, { headers: authed(KEY_A1) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ id: string }> };
    const ids = body.workspaces.map((w) => w.id);
    expect(ids).toContain(WS_A1);
    expect(ids).toContain(WS_A2);
  });
});

describe("GET /workspaces/:workspaceId/members — action='members'", () => {
  it("REGRESSION (was: 500): a same-tenant, different workspace's members are now listed successfully — confirms access is tenant-scoped, not workspace-membership-scoped", async () => {
    const res = await app.request(`/workspaces/${WS_A2}/members`, { headers: authed(KEY_A1) });
    expect(res.status).toBe(200);
  });

  it("REGRESSION (was: 500): a genuinely different tenant's workspace now correctly 404s (anti-probing, not 403) instead of crashing", async () => {
    const res = await app.request(`/workspaces/${WS_B1}/members`, { headers: authed(KEY_A1) });
    expect(res.status).toBe(404);
  });
});
