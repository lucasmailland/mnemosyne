import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DrizzleStorageAdapter, createDrizzleClient } from "@mnemo-ai/adapter-postgres";
import { SessionBuffer } from "@mnemo-ai/core";
import type { CacheAdapter, HealthStatus } from "@mnemo-ai/types";
import bcrypt from "bcrypt";
import postgres, { type Sql } from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { IdempotencyStore } from "../../idempotency.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "appconn";
const APP_PASSWORD = "appconn";
const TENANT_ID = "tenant-session-scratch-rls";
const WS_A = "17e5f9a3-0aaa-0aaa-0aaa-00000000000a";
const WS_B = "17e5f9a3-0bbb-0bbb-0bbb-00000000000b";
const SESSION_A = "5e551011-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const KEY_A = "mns_live_sessionscratchrlskeya001";
const KEY_B = "mns_live_sessionscratchrlskeyb002";
const REQUEST_ID = "session-scratch-rls-test";

class RecordingCache implements CacheAdapter {
  readonly id: string;
  readonly capabilities = {
    sortedSets: true,
    pubSub: false,
    patterns: false,
    atomic: false,
    hashes: true,
  };
  readonly hashes = new Map<string, Record<string, string>>();
  readonly deletes: string[] = [];
  readonly zadds: Array<{ key: string; score: number; member: string }> = [];
  readonly hGetAllCalls: string[] = [];

  constructor(
    name: string,
    private readonly status: HealthStatus["status"] = "ok",
    private readonly failures: { delete?: boolean; zadd?: boolean } = {}
  ) {
    this.id = `recording-${name}`;
  }

  reset(): void {
    this.deletes.length = 0;
    this.zadds.length = 0;
    this.hGetAllCalls.length = 0;
  }

  async get<T>(): Promise<T | null> {
    return null;
  }
  async set<T>(): Promise<void> {}
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failures.delete) throw new Error("cache delete unavailable");
    this.hashes.delete(key);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async zadd(key: string, score: number, member: string): Promise<void> {
    this.zadds.push({ key, score, member });
    if (this.failures.zadd) throw new Error("cache zadd unavailable");
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    this.hGetAllCalls.push(key);
    return this.hashes.get(key) ?? {};
  }
  async healthCheck(): Promise<HealthStatus> {
    return { status: this.status, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

type TestApp = ReturnType<typeof createApp>;

let container: StartedTestContainer;
let admin: Sql;
let apiKeyClose: (() => Promise<void>) | undefined;
let storageClient: ReturnType<typeof createDrizzleClient>["pgClient"];
let sharedStorage: DrizzleStorageAdapter;
let healthy: { app: TestApp; cache: RecordingCache; buffer: SessionBuffer };
let redisDown: { app: TestApp; cache: RecordingCache; buffer: SessionBuffer };
let deleteFailure: { app: TestApp; cache: RecordingCache; buffer: SessionBuffer };
let zaddFailure: { app: TestApp; cache: RecordingCache; buffer: SessionBuffer };
let idempotencyOutage: {
  app: TestApp;
  cache: RecordingCache;
  buffer: SessionBuffer;
  store: IdempotencyStore;
};

function buildApp(
  cache: RecordingCache,
  storage: DrizzleStorageAdapter,
  apiKeys: ServerDeps["apiKeys"],
  idempotencyStore?: IdempotencyStore
) {
  // flatten-legacy-dual-core Phase 7: `storage` (a `StorageAdapter`) satisfies
  // `SessionScratchStore` directly — `replaceSessionScratch` was already a v3
  // port method, `getSessionScratch` is the read-side twin added this Phase
  // (`@mnemo-ai/types` ports.ts), replacing the legacy `CoreLike` pair.
  const buffer = new SessionBuffer(cache, storage, storage);
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    apiKeys,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    cognitive: makeMockCognitive(),
    storage,
    cache,
    sessionBuffer: buffer,
    idempotencyStore,
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  return { app: createApp({ deps, version: "session-scratch-rls-test" }), cache, buffer };
}

function request(
  app: TestApp,
  key: string,
  scratch: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return app.request(`/session/${SESSION_A}/scratch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ scratch }),
  });
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: PG.user,
      POSTGRES_PASSWORD: PG.password,
      POSTGRES_DB: PG.db,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

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
  const [hashA, hashB] = await Promise.all([
    bcrypt.hash(KEY_A, BCRYPT_COST),
    bcrypt.hash(KEY_B, BCRYPT_COST),
  ]);
  await admin.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_USER};
  `);
  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name)
    VALUES (${TENANT_ID}, ${"Session scratch RLS tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES
      (${WS_A}, ${"Workspace A"}, ${"session-scratch-a"}, ${TENANT_ID}),
      (${WS_B}, ${"Workspace B"}, ${"session-scratch-b"}, ${TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_session_scratch_a"}, ${WS_A}, ${hashA}, ${"workspace-a"}, ${"workspace-a"}, ARRAY['memory:read','memory:write']::text[]),
      (${"key_session_scratch_b"}, ${WS_B}, ${hashB}, ${"workspace-b"}, ${"workspace-b"}, ARRAY['memory:read','memory:write']::text[])
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_session (id, workspace_id, agent_id, status, scratch)
    VALUES (${SESSION_A}, ${WS_A}, ${"agent-session-scratch"}, ${"active"}, ${{ initial: true }})
  `;

  const appUrl = `postgres://${APP_USER}:${APP_PASSWORD}@${host}:${port}/${PG.db}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyClose = apiKeys.close;

  const drizzleClient = createDrizzleClient(appUrl);
  storageClient = drizzleClient.pgClient;
  const storage = new DrizzleStorageAdapter(drizzleClient.db);
  sharedStorage = storage;
  healthy = buildApp(new RecordingCache("healthy"), storage, apiKeys);
  redisDown = buildApp(new RecordingCache("down", "down"), storage, apiKeys);
  deleteFailure = buildApp(
    new RecordingCache("delete-failure", "ok", { delete: true }),
    storage,
    apiKeys
  );
  zaddFailure = buildApp(
    new RecordingCache("zadd-failure", "ok", { zadd: true }),
    storage,
    apiKeys
  );
  const unavailableStore = {
    begin: vi.fn(async () => {
      throw new Error("redis idempotency unavailable");
    }),
    complete: vi.fn(async () => {}),
    recordPhase: vi.fn(async () => {}),
    getRecoveryPoint: vi.fn(async () => null),
  } satisfies IdempotencyStore;
  idempotencyOutage = {
    ...buildApp(new RecordingCache("idempotency-outage"), storage, apiKeys, unavailableStore),
    store: unavailableStore,
  };
}, 180_000);

afterAll(async () => {
  const caches = [
    healthy?.cache,
    redisDown?.cache,
    deleteFailure?.cache,
    zaddFailure?.cache,
    idempotencyOutage?.cache,
  ].filter((cache): cache is RecordingCache => cache !== undefined);
  await Promise.all(caches.map((cache) => cache.close().catch(() => void 0)));
  await storageClient?.end().catch(() => void 0);
  await apiKeyClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("session scratch under a non-superuser RLS role", () => {
  it("replaces scratch exactly, removes stale fields, clears with {}, and ignores stale Redis", async () => {
    const legacyKey = `mnemo:${WS_A}:sess:${SESSION_A}`;
    healthy.cache.hashes.set(legacyKey, { stale: "redis", a: "0" });
    healthy.cache.reset();

    const first = await request(healthy.app, KEY_A, { a: 1, b: 2 });
    expect(first.status).toBe(204);
    const second = await request(healthy.app, KEY_A, { a: 3 });
    expect(second.status).toBe(204);
    await expect(healthy.buffer.getScratch(WS_A, SESSION_A)).resolves.toEqual({ a: 3 });
    expect(healthy.cache.hGetAllCalls).toEqual([]);

    const cleared = await request(healthy.app, KEY_A, {});
    expect(cleared.status).toBe(204);
    await expect(
      sharedStorage.getSessionScratch({ workspaceId: WS_A, sessionId: SESSION_A })
    ).resolves.toEqual({});
    expect(healthy.cache.hGetAllCalls).toEqual([]);
  });

  it("returns identical fixed-request-id 404s for cross-workspace and missing rows without cache mutation", async () => {
    await sharedStorage.replaceSessionScratch({
      workspaceId: WS_A,
      sessionId: SESSION_A,
      scratch: { owner: "a" },
    });
    healthy.cache.reset();

    const crossWorkspace = await request(
      healthy.app,
      KEY_B,
      { attacker: true },
      {
        "x-request-id": REQUEST_ID,
      }
    );
    const crossBody = await crossWorkspace.json();
    expect(crossWorkspace.status).toBe(404);
    await expect(
      sharedStorage.getSessionScratch({ workspaceId: WS_A, sessionId: SESSION_A })
    ).resolves.toEqual({ owner: "a" });
    expect(healthy.cache.deletes).toEqual([]);
    expect(healthy.cache.zadds).toEqual([]);

    await admin`DELETE FROM mnemosyne.mnemo_session WHERE id = ${SESSION_A}`;
    try {
      const missing = await request(
        healthy.app,
        KEY_A,
        { attacker: true },
        {
          "x-request-id": REQUEST_ID,
        }
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual(crossBody);
      expect(crossBody).toEqual({
        error: {
          type: "not_found_error",
          code: "not_found",
          message: `Session ${SESSION_A} not found.`,
          request_id: REQUEST_ID,
          // WP-9's envelope adds `retryable` to every error (additive).
          retryable: false,
        },
      });
      expect(healthy.cache.deletes).toEqual([]);
      expect(healthy.cache.zadds).toEqual([]);
    } finally {
      await admin`
        INSERT INTO mnemosyne.mnemo_session (id, workspace_id, agent_id, status, scratch)
        VALUES (${SESSION_A}, ${WS_A}, ${"agent-session-scratch"}, ${"active"}, ${{ owner: "a" }})
      `;
    }
  });

  it("persists scratch with Redis health down", async () => {
    redisDown.cache.reset();
    const response = await request(redisDown.app, KEY_A, { redis: "down" });
    expect(response.status).toBe(204);
    await expect(
      sharedStorage.getSessionScratch({ workspaceId: WS_A, sessionId: SESSION_A })
    ).resolves.toEqual({ redis: "down" });
  });

  it("keeps 204 when cache delete fails and still attempts zadd", async () => {
    deleteFailure.cache.reset();
    const response = await request(deleteFailure.app, KEY_A, { delete: "failed" });
    expect(response.status).toBe(204);
    expect(deleteFailure.cache.deletes).toHaveLength(1);
    expect(deleteFailure.cache.zadds).toHaveLength(1);
    await expect(
      sharedStorage.getSessionScratch({ workspaceId: WS_A, sessionId: SESSION_A })
    ).resolves.toEqual({ delete: "failed" });
  });

  it("keeps 204 when cache zadd fails after successful invalidation", async () => {
    zaddFailure.cache.reset();
    const response = await request(zaddFailure.app, KEY_A, { zadd: "failed" });
    expect(response.status).toBe(204);
    expect(zaddFailure.cache.deletes).toHaveLength(1);
    expect(zaddFailure.cache.zadds).toHaveLength(1);
    await expect(
      sharedStorage.getSessionScratch({ workspaceId: WS_A, sessionId: SESSION_A })
    ).resolves.toEqual({ zadd: "failed" });
  });

  it("bypasses an unavailable idempotency store for exact scratch requests", async () => {
    const response = await request(
      idempotencyOutage.app,
      KEY_A,
      { idempotency: "available" },
      {
        "idempotency-key": "scratch-idempotency-outage",
      }
    );
    expect(response.status).toBe(204);
    expect(idempotencyOutage.store.begin).not.toHaveBeenCalled();
    await expect(
      sharedStorage.getSessionScratch({ workspaceId: WS_A, sessionId: SESSION_A })
    ).resolves.toEqual({ idempotency: "available" });
  });

  it("returns exact canonical 500 and does not mutate cache when PostgreSQL rejects UPDATE", async () => {
    healthy.cache.reset();
    await admin.unsafe("REVOKE UPDATE ON TABLE mnemosyne.mnemo_session FROM mnemo_app_role");
    try {
      const response = await request(
        healthy.app,
        KEY_A,
        { should: "fail" },
        {
          "x-request-id": REQUEST_ID,
        }
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: {
          type: "api_error",
          code: "internal_error",
          message: "Internal server error",
          request_id: REQUEST_ID,
          retryable: false,
        },
      });
      expect(healthy.cache.deletes).toEqual([]);
      expect(healthy.cache.zadds).toEqual([]);
    } finally {
      await admin.unsafe("GRANT UPDATE ON TABLE mnemosyne.mnemo_session TO mnemo_app_role");
    }
  });
});
