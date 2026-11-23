/**
 * Regression test: search_path invariant for POST /session/start.
 *
 * flatten-legacy-dual-core Slice 3c pt.1 (PR10): `POST /session/start` now
 * requires `deps.storage` and creates the session via v3's
 * `DrizzleStorageAdapter.createSession` (was `deps.core.startSession`, the
 * legacy `factory.ts` raw-SQL path). `DrizzleStorageAdapter` sets its own
 * workspace-scoped search_path per transaction (`SessionRepository`'s
 * `setWorkspaceContext`) rather than relying on a connection-pool-level
 * `search_path` option — a different, independently-correct mechanism from
 * the legacy factory pool's. This test now proves THAT mechanism resolves
 * `mnemosyne.mnemo_session` correctly end-to-end through the real route,
 * which is the more relevant invariant now that this route no longer touches
 * the legacy factory pool at all. `core` (the legacy `CoreLike`) is still
 * wired below because `ServerDeps.core` remains a required field until
 * Slice 4 deletes `CoreLike` — it is not exercised by this route anymore.
 *
 * Setup:
 *   - Runs BOTH migration streams (public + mnemosyne schemas).
 *   - Seeds an API key with `memory:write` scope (session/start requires POST = memory:write).
 *   - Provides a FakeCache so the Redis-gate in /session/* does not block the test.
 *   - Calls POST /session/start and asserts 201 + sessionId.
 *   - Directly queries mnemosyne.mnemo_session to confirm the row was persisted.
 *
 * Hermetic & CI-safe: fresh container per run. Requires Docker.
 *
 * BUG ENCODED: if `DrizzleStorageAdapter`'s workspace-scoping stops applying
 * `search_path`/`mnemo_set_workspace` correctly, the INSERT into mnemo_session
 * will fail (or resolve the wrong schema) and this test will fail with a 5xx.
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
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

// Must be a valid UUID — mnemosyne RLS policies cast workspace_id to uuid.
const WS = "17e5f9a3-5ea7-5ea7-5ea7-000000000001";
const PLAINTEXT_KEY = "mns_live_searchpathsessiontestk001";
const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

// Minimal in-memory cache adapter — satisfies the Redis-gate so that
// POST /session/* does not immediately return 503.
class FakeCache implements CacheAdapter {
  readonly id = "fake-cache-search-path";
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

let container: StartedTestContainer;
let databaseUrl: string;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let pgClient: postgres.Sql;
let storage: DrizzleStorageAdapter;

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  // Stream 1: legacy core migrations → public schema (mnemo_api_keys auth path).
  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");

  // Stream 2: v3 adapter-postgres migrations → mnemosyne schema (mnemo_session etc.).
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  // Seed an API key. `memory:write` is the required scope for POST /session/start
  // (path `/session/start` does not match `/sessions`, falls through to POST → memory:write).
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  expect(BCRYPT_COST).toBe(12);
  // Schema-qualify to mnemosyne.mnemo_api_keys: createApiKeyLookup uses
  // search_path='mnemosyne,public', which resolves to mnemosyne.mnemo_api_keys
  // when the v3 baseline has run (mnemosyne takes precedence over public).
  pgClient = postgres(databaseUrl, { max: 2, onnotice: () => void 0 });
  await pgClient`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_search_path_01"}, ${WS}, ${keyHash}, ${"search-path-session-test"}, ${"search-path-session-test"},
            ARRAY['memory:read', 'memory:write', 'memory:session']::text[])
  `;

  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  apiKeyLookupClose = apiKeys.close;

  // flatten-legacy-dual-core Slice 3c pt.1 (PR10): POST /session/start now
  // requires deps.storage (see file header comment).
  const { db: v3Db, pgClient: v3PgClient } = createDrizzleClient(databaseUrl);
  storage = new DrizzleStorageAdapter(v3Db, v3PgClient);

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    apiKeys,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    storage,
    // Provide a fake cache so the session Redis-gate returns "up" rather than 503.
    cache: new FakeCache(),
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  app = createApp({ deps, version: "search-path-test" });
}, 180_000);

afterAll(async () => {
  await storage?.close().catch(() => void 0);
  await apiKeyLookupClose?.().catch(() => void 0);
  await pgClient?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("search_path invariant: POST /session/start resolves mnemosyne.mnemo_session", () => {
  let sessionId: string;

  it("returns 201 with a sessionId (mnemo_session INSERT succeeds via search_path)", async () => {
    const res = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ agentId: "test-agent" }),
    });

    // 503 = Redis gate blocked (FakeCache not wired correctly).
    // 500 = "relation does not exist" → search_path not applied on the pool.
    // 401/403 = auth/scope problem.
    // 201 = search_path is correct and mnemo_session row was inserted.
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe("string");
    expect((body.id as string).length).toBeGreaterThan(0);
    sessionId = body.id as string;
  });

  it("session row exists in mnemosyne.mnemo_session (schema-qualified query)", async () => {
    expect(sessionId).toBeDefined();

    // Schema-qualify the table name so this assertion is independent of search_path.
    const rows = await pgClient<{ id: string; workspace_id: string }[]>`
      SELECT id, workspace_id
      FROM mnemosyne.mnemo_session
      WHERE id = ${sessionId}
        AND workspace_id = ${WS}
    `;

    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(sessionId);
    expect(rows[0]!.workspace_id).toBe(WS);
  });
});
