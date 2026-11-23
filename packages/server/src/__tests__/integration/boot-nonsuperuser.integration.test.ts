/**
 * Proves that the server boots with a NOSUPERUSER/NOBYPASSRLS role and that
 * workspace RLS isolation holds under that role.
 *
 * Two sub-tests:
 *   1. assertSafeDbRole({databaseUrl: appUrl}) does NOT throw.
 *   2. Workspace A's facts are invisible to workspace B (RLS isolation).
 *
 * Requires Docker (testcontainers).
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
const APP_PASS = "mnemo_app_test";

// Two separate workspaces — each bound to its own API key via the DB row.
const WS_A = "aaaa0001-0001-0001-0001-000000000001";
const WS_B = "bbbb0002-0002-0002-0002-000000000002";
const KEY_A = "mns_live_nonsuperuserbootkeya001";
const KEY_B = "mns_live_nonsuperuserbootkeyb002";

let container: StartedTestContainer;
let superUrl: string;
let appUrl: string;
let app: ReturnType<typeof createApp>;
let apiKeyClose: (() => Promise<void>) | undefined;

beforeAll(async () => {
  // 1. pgvector container — same image as production.
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  // Enable the vector extension (migrations assume it exists).
  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  // 2. Run both migration streams (core/public schema first, then v3/mnemosyne).
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

  // 3. Create the NOSUPERUSER NOBYPASSRLS login role (mirrors provision-app-role.mjs).
  const admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
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
    `);

    // 4. Seed API keys into mnemosyne.mnemo_api_keys (where createApiKeyLookup reads).
    // The v3 baseline creates mnemosyne.mnemo_api_keys with FORCE RLS + a workspace
    // policy. createApiKeyLookup uses search_path='mnemosyne,public', so it resolves
    // mnemo_api_keys to the mnemosyne table. The auth lookup must use a superuser
    // connection to bypass FORCE RLS (see step 5 below — createApiKeyLookup uses superUrl).
    const hashA = await bcrypt.hash(KEY_A, BCRYPT_COST);
    const hashB = await bcrypt.hash(KEY_B, BCRYPT_COST);
    await admin`
      INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
      VALUES
        (${"key_nonsuperuser_a"}, ${WS_A}, ${hashA}, ${"ws-a-key"}, ${"ws-a-key"}, ARRAY['memory:read','memory:write']::text[]),
        (${"key_nonsuperuser_b"}, ${WS_B}, ${hashB}, ${"ws-b-key"}, ${"ws-b-key"}, ARRAY['memory:read','memory:write']::text[])
    `;
  } finally {
    await admin.end();
  }

  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;

  // 5. Build the app: data operations use the non-superuser appUrl (tests RLS isolation);
  // auth lookup uses superUrl because mnemosyne.mnemo_api_keys has FORCE RLS with a
  // workspace policy — a non-superuser connection cannot read any row without the
  // workspace GUC set, which creates a chicken-and-egg: auth identifies the workspace,
  // but the workspace is needed to bypass RLS for auth. Production resolves this by
  // using a privileged connection exclusively for the auth path.
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyClose = apiKeys.close;

  // v3 cognitive core — required so POST /remember (the sole write path
  // since flatten-legacy-dual-core PR8 deleted POST /facts) actually runs
  // end-to-end, not just the auth/RLS layer under test. Fake embed adapter,
  // no LLM — mirrors purge-facts-hard-delete.integration.test.ts.
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
    apiKeys,
    cognitive,
    storage: v3Storage,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  app = createApp({ deps, version: "2.0.0-nonsuperuser-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("assertSafeDbRole", () => {
  it("passes (no throw) for the NOSUPERUSER application role", async () => {
    const coreMod = await import("@mnemo-ai/core");
    // assertSafeDbRole throws if role is superuser/bypassrls — must not throw here.
    await expect(coreMod.assertSafeDbRole({ databaseUrl: appUrl })).resolves.toBeUndefined();
  });
});

describe("workspace RLS isolation", () => {
  it("POST /remember as workspace A succeeds", async () => {
    // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the
    // sole write path is now POST /remember, lossless-remapped
    // {content} -> {statement}.
    const res = await app.request("/remember", {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY_A}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ statement: "workspace A secret fact" }),
    });
    expect(res.status).toBe(201);
  });

  it("GET /facts as workspace B does NOT see workspace A's fact", async () => {
    const res = await app.request("/facts", {
      method: "GET",
      headers: {
        authorization: `Bearer ${KEY_B}`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ statement: string }> };
    const statements = body.items.map((f) => f.statement);
    expect(statements).not.toContain("workspace A secret fact");
  });

  it("GET /facts as workspace A DOES see its own fact", async () => {
    const res = await app.request("/facts", {
      method: "GET",
      headers: {
        authorization: `Bearer ${KEY_A}`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ statement: string }> };
    const statements = body.items.map((f) => f.statement);
    expect(statements).toContain("workspace A secret fact");
  });
});
