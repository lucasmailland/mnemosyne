/**
 * S8 — end-to-end proof of the user-token provisioning route family (S6:
 * POST/GET/DELETE /tenants/:tenantId/users/:userId/tokens) against a REAL
 * Postgres instance, through the real non-superuser `mnemo_app_role`
 * connection. Clones the testcontainers/migration/role-provisioning pattern
 * from `workspace-tenant-fallback.integration.test.ts`.
 *
 * Seed: 1 tenant, 1 workspace, 3 users —
 *   A: tenant owner (mints tokens)
 *   B: tenant member + workspace 'write' member (the token's target)
 *   C: tenant member ONLY (not owner/admin), but ALSO a workspace 'admin' —
 *      proves workspace-admin authority does not imply tenant-admin
 *      authority on this route (the whole reason S6 exists as its own
 *      route rather than an admin:keys extension).
 *
 * Proves:
 *  1. A (tenant owner) mints a uk_live_* token for B, scoped to B's
 *     workspace — 201.
 *  2. That freshly minted token genuinely authenticates and resolves to
 *     B's identity/workspace (GET /me).
 *  3. C (workspace admin, NOT tenant admin) gets 403 on the same route.
 *  4. Revoking the token (A, DELETE .../tokens/:keyId) makes it stop
 *     authenticating (401) — no longer just "still valid but scopeless".
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

const PG_USER = "mnemo_super_uktok";
const PG_PASSWORD = "mnemo_super_uktok";
const PG_DB = "mnemo_test_uktok";
const APP_ROLE = "uktok_app";
const APP_PASSWORD = "uktok_app_pass";

const TENANT_ID = "tenant-uktok-contract";
const WS_ID = "9b3f9c00-0000-4000-8000-000000000001";
const USER_A = "9b3f9c00-user-0000-00000000000a"; // tenant owner, mints tokens
const USER_B = "9b3f9c00-user-0000-00000000000b"; // target — gets minted a token
const USER_C = "9b3f9c00-user-0000-00000000000c"; // workspace admin, NOT tenant admin

// Well-formed per auth.ts's API_KEY_PATTERN.
const KEY_A = "uk_live_uktokcontractownerkey00112233";
const KEY_C = "uk_live_uktokcontractnonadminkey001122";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

beforeAll(async () => {
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
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT app_user       TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  // ── Seed: 1 tenant, 1 workspace, 3 users with different plane roles ──────
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${TENANT_ID}, ${"user-token contract tenant"}, ${"organization"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id) VALUES (${WS_ID}, ${"uktok workspace"}, ${"uktok-ws"}, ${TENANT_ID})`;

  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${USER_A}, ${"uktok-owner@example.com"}, ${TENANT_ID})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${USER_B}, ${"uktok-target@example.com"}, ${TENANT_ID})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${USER_C}, ${"uktok-wsadmin@example.com"}, ${TENANT_ID})`;

  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${TENANT_ID}, ${USER_A}, ${"owner"})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${TENANT_ID}, ${USER_B}, ${"member"})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${TENANT_ID}, ${USER_C}, ${"member"})`;

  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_ID}, ${USER_B}, ${"write"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_ID}, ${USER_C}, ${"admin"})`;

  const [hashA, hashC] = await Promise.all([
    bcrypt.hash(KEY_A, BCRYPT_COST),
    bcrypt.hash(KEY_C, BCRYPT_COST),
  ]);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, tenant_id, user_id, key_kind, key_hash, name, label, scopes)
    VALUES
      (${"key_uktok_owner"}, ${WS_ID}, ${TENANT_ID}, ${USER_A}, ${"user"}, ${hashA}, ${"uktok-owner"}, ${"uktok-owner"},
       ARRAY['admin:tenant','memory:read','memory:write']::text[]),
      (${"key_uktok_wsadmin"}, ${WS_ID}, ${TENANT_ID}, ${USER_C}, ${"user"}, ${hashC}, ${"uktok-wsadmin"}, ${"uktok-wsadmin"},
       ARRAY['admin:tenant','memory:read','memory:write','memory:admin']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    apiKeys,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
    metricsPgClient: postgres(appUrl, { max: 5, onnotice: () => void 0 }),
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "uktok-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("POST /tenants/:tenantId/users/:userId/tokens — S8 end-to-end", () => {
  it("a workspace admin who is NOT a tenant admin gets 403", async () => {
    const res = await app.request(`/tenants/${TENANT_ID}/users/${USER_B}/tokens`, {
      method: "POST",
      headers: authed(KEY_C),
      body: JSON.stringify({ label: "should be rejected", homeWorkspaceId: WS_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("the tenant owner mints a real token for B, and that token genuinely authenticates as B", async () => {
    const mintRes = await app.request(`/tenants/${TENANT_ID}/users/${USER_B}/tokens`, {
      method: "POST",
      headers: authed(KEY_A),
      body: JSON.stringify({
        label: "B's token",
        homeWorkspaceId: WS_ID,
        scopes: ["memory:read", "memory:write"],
      }),
    });
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as {
      id: string;
      key: string;
      userId: string;
      tenantId: string;
      workspaceId: string;
    };
    expect(minted.key).toMatch(/^uk_live_/);
    expect(minted.userId).toBe(USER_B);
    expect(minted.workspaceId).toBe(WS_ID);

    // The plaintext key genuinely authenticates and resolves to B's identity.
    const meRes = await app.request("/me", { headers: authed(minted.key) });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as Record<string, unknown>;
    expect(me.userId).toBe(USER_B);
    expect(me.workspaceId).toBe(WS_ID);
    expect(me.tenantId).toBe(TENANT_ID);
  });

  it("revoking a token stops it from authenticating (401)", async () => {
    // A SEPARATE, freshly minted token that is revoked BEFORE it is ever
    // used to authenticate — auth.ts caches a verified key's result for 60s
    // (see auth.ts's `cache` LRU), so reusing the token from the previous
    // test (already cached as valid there) would prove cache behavior, not
    // revocation. A never-before-seen token's very first lookup after
    // revocation genuinely hits the DB and finds no matching
    // revoked_at IS NULL row.
    const mintRes = await app.request(`/tenants/${TENANT_ID}/users/${USER_B}/tokens`, {
      method: "POST",
      headers: authed(KEY_A),
      body: JSON.stringify({ label: "B's second token", homeWorkspaceId: WS_ID }),
    });
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as { id: string; key: string };

    const revokeRes = await app.request(
      `/tenants/${TENANT_ID}/users/${USER_B}/tokens/${minted.id}`,
      {
        method: "DELETE",
        headers: authed(KEY_A),
      }
    );
    expect(revokeRes.status).toBe(200);

    const meAfterRevoke = await app.request("/me", { headers: authed(minted.key) });
    expect(meAfterRevoke.status).toBe(401);
  });
});
