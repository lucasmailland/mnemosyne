/**
 * EPISODE-1 — real-Postgres proof that `memory_episode_start`'s `label`
 * argument is actually persisted.
 *
 * `memory_episode_start` promises: "Etiqueta legible para el episodio ...
 * Facilita búsqueda y depuración posterior." The MCP tool forwards `label`
 * to `client.createSession()`, which sends it in the `POST /session/start`
 * body — and the route's Zod schema even accepts it (`label: z.string()
 * .optional()`) — but the handler never passed `body.label` to
 * `deps.core.startSession()`, `mnemo_session` had no `label` column, and the
 * response never echoed it back. The label was silently discarded end to
 * end.
 *
 * This suite proves, against a REAL Postgres instance under a genuine
 * NOSUPERUSER `mnemo_app_role`:
 *
 *  1. `POST /session/start` with a `label` persists it to `mnemo_session`
 *     and echoes it back in the response.
 *  2. `GET /session/{id}` returns the persisted label.
 *  3. `GET /session/list` returns the persisted label.
 *  4. Omitting `label` still works (nullable column, optional field) —
 *     regression guard for the existing no-label callers (grpc.ts,
 *     session-lifecycle-rls.integration.test.ts).
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CacheAdapter } from "@mnemo-ai/types";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

// Minimal in-memory cache adapter — satisfies the Redis-gate so that
// POST /session/* does not immediately return 503 (see
// search-path-session.integration.test.ts's identical FakeCache).
class FakeCache implements CacheAdapter {
  readonly id = "fake-cache-session-label";
  readonly capabilities = {
    sortedSets: false,
    pubSub: false,
    patterns: true,
    atomic: true,
    hashes: false,
  };
  private store = new Map<string, string>();
  async get<T>(k: string): Promise<T | null> {
    const v = this.store.get(k);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set<T>(k: string, v: T): Promise<void> {
    this.store.set(k, JSON.stringify(v));
  }
  async delete(k: string): Promise<void> {
    this.store.delete(k);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_ROLE = "sessionlabel_app";
const APP_PASSWORD = "sessionlabel_app_pass";

const TENANT_ID = "tenant-sessionlabel-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000022";
const API_KEY = "mns_live_sessionlabelcontracthasscop1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers };
}

async function sessionLabelRow(id: string): Promise<{ label: string | null } | undefined> {
  const rows = await admin<Array<{ label: string | null }>>`
    SELECT label FROM mnemosyne.mnemo_session WHERE id = ${id} AND workspace_id = ${WS}
  `;
  return rows[0];
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

  admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });

  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Session label contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Session label contract workspace"}, ${"sessionlabel-contract"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_sessionlabel_contract"}, ${WS}, ${hash}, ${"sessionlabel-contract"}, ${"sessionlabel-contract"},
       ARRAY['memory:read','memory:write']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

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
    cache: new FakeCache(),
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
  app = createApp({ deps, version: "sessionlabel-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_episode_start label persistence (EPISODE-1)", () => {
  it("REGRESSION (was: discarded end to end): persists label to mnemo_session and echoes it in the response", async () => {
    const res = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ label: "Reunión con cliente 2026-06-12" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; label: string | null };
    expect(body.label).toBe("Reunión con cliente 2026-06-12");

    const row = await sessionLabelRow(body.id);
    expect(row?.label).toBe("Reunión con cliente 2026-06-12");
  });

  it("GET /session/{id} returns the persisted label", async () => {
    const start = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ label: "fetch-by-id label" }),
    });
    const { id } = (await start.json()) as { id: string };

    const res = await app.request(`/session/${id}`, { method: "GET", headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string | null };
    expect(body.label).toBe("fetch-by-id label");
  });

  it("GET /session/list returns the persisted label", async () => {
    const start = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ label: "list label" }),
    });
    const { id } = (await start.json()) as { id: string };

    const res = await app.request("/session/list", { method: "GET", headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; label: string | null }> };
    const found = body.sessions.find((s) => s.id === id);
    expect(found?.label).toBe("list label");
  });

  it("omitting label still works — regression guard for existing no-label callers", async () => {
    const res = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; label: string | null };
    expect(body.label).toBeNull();

    const row = await sessionLabelRow(body.id);
    expect(row?.label).toBeNull();
  });
});
