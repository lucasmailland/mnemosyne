/**
 * DUAL-SCHEMA cutover integration test — the merge gate for the v3
 * migration-stream fix (docs/archive/superpowers/plans/2026-06-14-design-gap-remediation.md,
 * Wave P-1).
 *
 * The deployed server still runs BOTH migration streams:
 *   - legacy stream (packages/core/migrations)            -> public schema
 *       public.mnemo_api_keys still exists, but the active auth path uses
 *       mnemosyne.mnemo_api_keys (createApiKeyLookup sets
 *       search_path='mnemosyne,public', so mnemosyne wins when both exist).
 *   - v3 stream (packages/adapter-postgres/migrations/v3)  -> mnemosyne schema
 *       serves EVERY route (flatten-legacy-dual-core Phase 7 — `CoreLike`/
 *       `factory.ts` deleted) via DrizzleStorageAdapter (reminders poller,
 *       session sweep, consolidation background tasks, and all HTTP routes).
 *
 * Before this fix the Docker `migrate` ran ONLY the legacy stream, so the
 * mnemosyne schema never existed and the v3 background tasks failed at runtime.
 *
 * This test spins up a throwaway pgvector container, runs BOTH streams, asserts
 * both schemas materialise, then exercises:
 *   1. the (now fully v3) HTTP surface (auth + facts) end-to-end, and
 *   2. a DrizzleStorageAdapter read against the mnemosyne schema (v3 storage),
 * proving the runtime is fully provisioned.
 *
 * Hermetic & CI-safe: every run gets a fresh DB. Requires Docker.
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

// Resolve @mnemo-ai/core's built migrate CLI + the legacy migrations dir
// relative to THIS file (works on any machine / CI). From
// packages/server/src/__tests__/integration/ up 5 levels to /packages/.
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
// The v3 adapter-postgres migrate CLI (resolves migrations/v3 relative to dist).
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

// Must be a valid UUID — isWorkspaceId() in api-key-lookup.ts filters out
// non-UUID workspace_ids, so a plain string like "ws_a" causes a 401.
const WS = "aa000001-0001-0001-0001-000000000001";
// Matches auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const PLAINTEXT_KEY = "mns_live_dualschematestkey00001";

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

let container: StartedTestContainer;
let databaseUrl: string;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let v3StorageClose: (() => Promise<void>) | undefined;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...headers,
  };
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
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  // NOTE: we deliberately do NOT pre-create the `vector` extension here. The
  // Docker migrate image does not either — it relies on the migration streams
  // to self-provision it (core's 0015 runs CREATE EXTENSION before the first
  // vector-typed column; v3's 0001 also does CREATE EXTENSION IF NOT EXISTS).
  // Letting the streams create it keeps this test faithful to the deploy path.

  // ── Stream 1: legacy core migrations -> public schema ──────────────────────
  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");

  // ── Stream 2: v3 adapter-postgres migrations -> mnemosyne schema ───────────
  // Run the BUILT CLI (`node dist/migrate.js`) — exactly what the Docker migrate
  // image executes — so this test gates the real deploy path, not just the
  // programmatic migrate() API. Reads DATABASE_URL from the environment.
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  // Seed an API key into the mnemosyne schema table (where createApiKeyLookup reads).
  // search_path='mnemosyne,public' in createApiKeyLookup resolves unqualified mnemo_api_keys
  // to mnemosyne.mnemo_api_keys (which exists after the v3 baseline runs), so the seed
  // must target that table too — not public.mnemo_api_keys.
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  expect(BCRYPT_COST).toBe(12);
  const seed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await seed`
      INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
      VALUES (${"key_dualschema_01"}, ${WS}, ${keyHash}, ${"dual-schema-test"}, ${"dual-schema-test"},
              ARRAY['memory:read', 'memory:write', 'memory:delete']::text[])
    `;
  } finally {
    await seed.end();
  }

  // Build the real app in-process — apiKeys via @mnemo-ai/core's auth
  // bootstrap (api-key-lookup.ts), everything else v3-only. No LLM.
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  apiKeyLookupClose = apiKeys.close;

  // v3 cognitive core — required so POST /remember (the sole write path
  // since flatten-legacy-dual-core PR8 deleted POST /facts) actually runs
  // end-to-end. Fake embed adapter, no LLM — mirrors
  // purge-facts-hard-delete.integration.test.ts. Both `core` above and this
  // cognitive core connect with search_path=mnemosyne,public
  // (packages/core/src/factory.ts), so they resolve the SAME physical
  // mnemosyne.mnemo_fact table this describe block's own first two tests
  // already prove is the authoritative v3 store.
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
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(databaseUrl);
  const v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
  const v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: databaseUrl });
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
  app = createApp({ deps, version: "dual-schema-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await v3StorageClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("both migration streams provision their schemas", () => {
  it("public schema has mnemo_api_keys and mnemo_fact after both migration streams run", async () => {
    // After both migration streams run, both schemas coexist:
    //   public.mnemo_api_keys  — legacy auth table (core stream)
    //   public.mnemo_fact      — legacy fact table (core stream)
    //   mnemosyne.mnemo_fact   — v3 fact table (v3 baseline stream)
    // The v3 baseline intentionally does NOT clean up public schema duplicates;
    // the mnemosyne schema is the authoritative v3 store (verified in the next test).
    const c = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
    try {
      const rows = await c<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('mnemo_api_keys', 'mnemo_fact')
        ORDER BY table_name
      `;
      expect(rows.map((r) => r.table_name)).toEqual(["mnemo_api_keys", "mnemo_fact"]);
    } finally {
      await c.end();
    }
  });

  it("mnemosyne schema holds the v3 tables (mnemo_fact, mnemo_reminder, mnemo_strategy)", async () => {
    // mnemo_fact is now a real table in mnemosyne (moved from public by 0002).
    // mnemo_reminder and mnemo_strategy were always native mnemosyne tables.
    const c = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
    try {
      const rows = await c<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'mnemosyne'
          AND table_name IN ('mnemo_fact', 'mnemo_reminder', 'mnemo_strategy')
        ORDER BY table_name
      `;
      expect(rows.map((r) => r.table_name)).toEqual([
        "mnemo_fact",
        "mnemo_reminder",
        "mnemo_strategy",
      ]);
    } finally {
      await c.end();
    }
  });
});

// flatten-legacy-dual-core Phase 7: renamed from "v1 surface works against
// the public schema (legacy core)" — `CoreLike`/`factory.ts` are physically
// deleted this Phase, so there is no more legacy core surface to exercise.
// These scenarios now exercise the fully-v3 HTTP write/read path
// end-to-end against the SAME physical mnemosyne.mnemo_fact table the two
// describe blocks above already prove is provisioned by both migration
// streams together.
describe("HTTP surface works end-to-end (v3-only) after both migration streams run", () => {
  let factId: string;

  it("POST /remember with a valid key -> 201", async () => {
    // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the
    // sole write path is now POST /remember, lossless-remapped
    // {content} -> {statement}.
    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "Dual-schema cutover fact.", tags: ["cutover"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceId).toBe(WS);
    factId = body.id as string;
    expect(typeof factId).toBe("string");
  });

  it("GET /facts/:id -> 200, content matches", async () => {
    const res = await app.request(`/facts/${factId}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.content).toBe("Dual-schema cutover fact.");
  });

  it("auth: missing key -> 401", async () => {
    const res = await app.request(`/facts/${factId}`, {
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

describe("v3 storage works against the mnemosyne schema (DrizzleStorageAdapter)", () => {
  it("getFact resolves against mnemosyne.* without a missing-relation error", async () => {
    const adapterPg = await import("@mnemo-ai/adapter-postgres");
    const { db, pgClient } = adapterPg.createDrizzleClient(databaseUrl);
    v3StorageClose = async () => {
      await pgClient.end({ timeout: 5 });
    };
    const storage = new adapterPg.DrizzleStorageAdapter(db, pgClient);

    // No rows exist; the point is that the mnemosyne.mnemo_fact table is
    // provisioned and the adapter (search_path=mnemosyne, mnemo_set_workspace,
    // RLS) can query it. A missing schema would throw "relation does not exist".
    const result = await storage.getFact(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222"
    );
    expect(result).toBeNull();
  });
});
