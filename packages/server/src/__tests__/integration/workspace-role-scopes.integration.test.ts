/**
 * S7 — end-to-end proof of the role→scope narrowing story (S1-S4) against a
 * REAL Postgres instance, through the real non-superuser `mnemo_app_role`
 * connection production actually uses. Clones the testcontainers/migration/
 * role-provisioning pattern from `workspace-tenant-fallback.integration.test.ts`
 * and the cognitive-core/fake-embed wiring from
 * `purge-facts-hard-delete.integration.test.ts` (needed so POST /facts and
 * POST /recall actually work end-to-end, not just the auth/scope layer).
 *
 * Seed: 1 tenant, 3 workspaces, 1 user who is a member of all three with a
 * DIFFERENT `mnemo_workspace_member.role` in each (`read`/`write`/`admin`),
 * and ONE `uk_live_*` user token carrying the FULL scope set (proving the
 * narrowing genuinely comes from the workspace role, not from a
 * pre-restricted key). The token's home workspace is the `write` one, so
 * this also exercises BOTH narrowing paths in auth.ts: the home-workspace
 * branch (no X-Workspace-Id header) and the explicit-switch branch
 * (X-Workspace-Id pointed at a different workspace the same user belongs to).
 *
 * Proves:
 *  1. `read`-role workspace: POST /facts (memory:write) is 403; GET
 *     /workspaces/mine still works (memory:read survives narrowing — S2).
 *  2. `write`-role workspace (the key's own home workspace, reached with NO
 *     X-Workspace-Id header): POST /facts succeeds (201); DELETE
 *     /facts/purge (memory:hard_delete) is 403 — `write` narrows that scope
 *     away even though the underlying key has it.
 *  3. `admin`-role workspace: DELETE /facts/purge succeeds (200) — `admin`
 *     keeps memory:hard_delete.
 *  4. POST /recall (memory:read) succeeds on all three roles.
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

const PG_USER = "mnemo_super_wsrole";
const PG_PASSWORD = "mnemo_super_wsrole";
const PG_DB = "mnemo_test_wsrole";
const APP_ROLE = "wsrole_app";
const APP_PASSWORD = "wsrole_app_pass";

const TENANT_ID = "tenant-wsrole-contract";
const WS_READ = "9b2f9c00-0000-4000-8000-000000000001";
const WS_WRITE = "9b2f9c00-0000-4000-8000-000000000002";
const WS_ADMIN = "9b2f9c00-0000-4000-8000-000000000003";
const USER_ID = "9b2f9c00-user-0000-000000000009";

// Well-formed per auth.ts's API_KEY_PATTERN: uk_(live|test)_[a-z0-9]{20,64}
const KEY_USER = "uk_live_wsrolecontracttoken0011223344";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(workspaceId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${KEY_USER}`,
    "content-type": "application/json",
  };
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
  return headers;
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

  // ── Seed: 1 tenant, 3 workspaces, 1 user, 3 different workspace roles ────
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${TENANT_ID}, ${"workspace-role contract tenant"}, ${"organization"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id) VALUES (${WS_READ}, ${"read workspace"}, ${"wsrole-read"}, ${TENANT_ID})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id) VALUES (${WS_WRITE}, ${"write workspace"}, ${"wsrole-write"}, ${TENANT_ID})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id) VALUES (${WS_ADMIN}, ${"admin workspace"}, ${"wsrole-admin"}, ${TENANT_ID})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${USER_ID}, ${"wsrole-contract-user@example.com"}, ${TENANT_ID})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_READ}, ${USER_ID}, ${"read"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_WRITE}, ${USER_ID}, ${"write"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_ADMIN}, ${USER_ID}, ${"admin"})`;

  // Full scope set on the KEY itself — proves narrowing comes from the
  // workspace role, not from the key already being restricted. Home
  // workspace is WS_WRITE (no X-Workspace-Id header exercises that path).
  const keyHash = await bcrypt.hash(KEY_USER, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, tenant_id, user_id, key_kind, key_hash, name, label, scopes)
    VALUES (
      ${"key_wsrole_contract_user"}, ${WS_WRITE}, ${TENANT_ID}, ${USER_ID}, ${"user"}, ${keyHash},
      ${"wsrole-contract-user"}, ${"wsrole-contract-user"},
      ARRAY['memory:read','memory:write','memory:delete','memory:hard_delete','memory:admin','admin:tenant']::text[]
    )
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  // v3 cognitive core — required so POST /facts and POST /recall actually
  // run end-to-end (not just the auth/scope layer under test). Fake embed
  // adapter, no LLM — mirrors purge-facts-hard-delete.integration.test.ts.
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
  const v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
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
    // flatten-legacy-dual-core PR9b: DELETE /facts/purge ported off
    // deps.core.purgeClosedFacts onto deps.storage.purgeForgottenFacts
    // (D6.3) — this harness already builds a real DrizzleStorageAdapter
    // (v3Storage, used by `cognitive`/`outboxAdapter` above) but never wired
    // it onto `deps.storage` itself, so the ported route 400'd with "storage
    // adapter not available". Found via this PR's Node 22 integration run.
    storage: v3Storage,
    apiKeys,
    cognitive,
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
  };
  app = createApp({ deps, version: "wsrole-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("read-role workspace (X-Workspace-Id switch)", () => {
  it("POST /facts (memory:write) is 403 — write scope stripped by the read role", async () => {
    const res = await app.request("/facts", {
      method: "POST",
      headers: authed(WS_READ),
      body: JSON.stringify({ content: "should be blocked by read role" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /workspaces/mine still works — memory:read survives narrowing (proves S2)", async () => {
    const res = await app.request("/workspaces/mine", { headers: authed(WS_READ) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ workspaceId: string }> };
    const ids = body.workspaces.map((w) => w.workspaceId);
    expect(ids).toEqual(expect.arrayContaining([WS_READ, WS_WRITE, WS_ADMIN]));
  });

  it("POST /recall (memory:read) succeeds", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(WS_READ),
      body: JSON.stringify({ query: "anything" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("write-role workspace (the key's own home workspace — no X-Workspace-Id header)", () => {
  it("POST /remember succeeds (201)", async () => {
    // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the sole
    // write path is now POST /remember. The sibling 403 test above
    // ("POST /facts (memory:write) is 403") is untouched: it exercises
    // app-scope.ts's generic "any POST/PATCH/PUT requires memory:write"
    // scope derivation (not a route-specific check), so it still proves the
    // narrowing story on the literal /facts path without needing the route
    // to exist.
    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "write role can create facts" }),
    });
    expect(res.status).toBe(201);
  });

  it("DELETE /facts/purge (memory:hard_delete) is 403 — narrowed away even though the key has it", async () => {
    const res = await app.request("/facts/purge", { method: "DELETE", headers: authed() });
    expect(res.status).toBe(403);
  });

  it("POST /recall succeeds", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "anything" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("admin-role workspace (X-Workspace-Id switch)", () => {
  it("DELETE /facts/purge succeeds (200) — admin role keeps memory:hard_delete", async () => {
    const res = await app.request("/facts/purge", { method: "DELETE", headers: authed(WS_ADMIN) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: expect.any(Number) });
  });

  it("POST /recall succeeds", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(WS_ADMIN),
      body: JSON.stringify({ query: "anything" }),
    });
    expect(res.status).toBe(200);
  });
});
