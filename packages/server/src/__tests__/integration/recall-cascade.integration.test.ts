/**
 * Integration test: Task 1 (path-to-100)
 *
 * Proves that POST /recall uses the worth-gated v3 three-tier cascade when
 * deps.cognitive is present, instead of the legacy searchMnemo.
 *
 * Setup:
 *   - Runs BOTH migration streams (public + mnemosyne schemas).
 *   - Builds an app with deps.cognitive wired (DrizzleStorageAdapter + PgVectorAdapter
 *     + createCore from @mnemo-ai/core/cognitive). No real LLM; fake embed adapter
 *     returns a deterministic unit vector so HNSW cosine-similarity is defined.
 *   - Inserts two facts via v3.remember() → mnemosyne.mnemo_fact. Then directly
 *     updates worth_alpha/worth_beta so one fact has worth≈0.9 and the other ≈0.1.
 *   - Asserts POST /recall:
 *       1. Returns 200 with v1 shape { hits[], debug }.
 *       2. debug.tier is present (proves the v3 branch ran, not legacy searchMnemo).
 *       3. The high-worth fact ranks above the low-worth fact.
 *
 * Hermetic & CI-safe: fresh container per run. Requires Docker.
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

const WS = "17e5f9a3-0001-0001-0001-000000000001"; // valid UUID for mnemosyne schema
const PLAINTEXT_KEY = "mns_live_recallcascadetestkey0001";
const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

// Deterministic unit vector (1536-d) so cosine similarity is well-defined
// (not NaN) for any query using the same vector.
const DIMS = 1536;
const UNIT_VAL = 1 / Math.sqrt(DIMS);
const UNIT_VECTOR = Array.from({ length: DIMS }, () => UNIT_VAL);
const UNIT_FLOAT32 = new Float32Array(UNIT_VECTOR);

let container: StartedTestContainer;
let databaseUrl: string;
let cognitive: import("../../deps.js").MnemoCore;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let pgClient: postgres.Sql;

let highWorthFactId: string;
let lowWorthFactId: string;

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

  // Stream 1: legacy core migrations → public schema
  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");

  // Stream 2: v3 adapter-postgres migrations → mnemosyne schema
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  // Seed API key into mnemosyne.mnemo_api_keys (v3 schema — createApiKeyLookup
  // uses search_path 'mnemosyne,public' so it resolves to the mnemosyne table).
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  pgClient = postgres(databaseUrl, { max: 3, onnotice: () => void 0 });
  await pgClient`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_recall_cascade_01"}, ${WS}, ${keyHash}, ${"recall-cascade-test"}, ${"recall-cascade-test"},
            ARRAY['memory:read', 'memory:write', 'memory:delete']::text[])
  `;

  // Build the legacy v1 core (needed for auth + public schema)
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  apiKeyLookupClose = apiKeys.close;

  // Build the v3 core with a fake embed adapter (deterministic unit vector)
  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);

  const { db, pgClient: pgC } = adapterPgMod.createDrizzleClient(databaseUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgC, undefined);
  const vectorAdapter = new adapterVectorMod.PgVectorAdapter({ connectionString: databaseUrl });

  // The fake embed adapter returns DIFFERENT vectors per text so that
  // dedupByContent (which re-embeds hit.content with cosine threshold 0.88)
  // does NOT collapse the two facts into one. We use a one-hot vector at
  // dimension = text.length % DIMS — each unique text length maps to a
  // unique orthogonal vector (cosine = 0 between any two different lengths).
  // The DB embeddings are set separately to UNIT_VECTOR so HNSW finds both.
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(_texts: string[]): Promise<Float32Array[]> {
      return _texts.map((text) => {
        const v = new Float32Array(DIMS);
        v[text.length % DIMS] = 1.0;
        return v;
      });
    },
    async embedSingle(_text: string): Promise<Float32Array> {
      const v = new Float32Array(DIMS);
      v[_text.length % DIMS] = 1.0;
      return v;
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };

  const noop = {
    startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
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

  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };

  cognitive = v3CoreMod.createCore({
    storage,
    vector: vectorAdapter,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noop,
  });

  const auth = {
    workspaceId: WS,
    actorId: "test-agent",
    actorType: "agent" as const,
    scopes: ["memory:write"] as const,
  };

  // Insert two facts via v3.remember() → they land in mnemosyne.mnemo_fact with embeddings
  const highResult = await cognitive.remember(
    {
      workspaceId: WS,
      kind: "fact",
      content: "The high-worth pricing fact about revenue tiers.",
      sensitivity: "internal",
    },
    auth
  );
  highWorthFactId = highResult.id;

  const lowResult = await cognitive.remember(
    {
      workspaceId: WS,
      kind: "fact",
      content: "The low-worth pricing fact about legacy tiers.",
      sensitivity: "internal",
    },
    auth
  );
  lowWorthFactId = lowResult.id;

  // The OutboxWorker (which processes vector_upsert events) is not running in
  // this test. Insert embeddings directly via PgVectorAdapter so HNSW can find
  // both facts. Using the adapter's own connection (search_path=mnemosyne,public)
  // guarantees the UPDATE reaches the right schema without raw SQL.
  await vectorAdapter.upsert(highWorthFactId, UNIT_FLOAT32, { workspaceId: WS });
  await vectorAdapter.upsert(lowWorthFactId, UNIT_FLOAT32, { workspaceId: WS });

  // Override worth via DB so we can control ordering.
  // worth is GENERATED ALWAYS AS (worth_success / (worth_success + worth_failure)).
  // worth_alpha/worth_beta drive wilsonLowerBound used by passesWorthGate (lb >= 0.3).
  // Both facts must pass the gate (worth > 0.5 && lb >= 0.3) to appear in results.
  //
  // High: success=90, failure=10 → worth=0.9, Wilson LB≈0.82  (score = 0.54)
  // Low:  success=55, failure=45 → worth=0.55, Wilson LB≈0.45 (score = 0.33)
  //
  // Replicates withMnemoTx pattern manually: begin() + SET LOCAL ROLE app_user +
  // mnemosyne.workspace_id GUC activates FORCE RLS identically to withMnemoTx.
  // Cannot use withMnemoTx directly because it wraps @mnemo-ai/core's Drizzle pool
  // while this test-seeding needs parameterized raw SQL for arbitrary worth values
  // not reachable through MnemoCore.updateWorth().
  await pgClient.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('mnemosyne.workspace_id', ${WS}, true)`;
    await tx`
      UPDATE mnemosyne.mnemo_fact
      SET worth_success = 90, worth_failure = 10, worth_alpha = 90, worth_beta = 10
      WHERE id = ${highWorthFactId}
    `;
    await tx`
      UPDATE mnemosyne.mnemo_fact
      SET worth_success = 55, worth_failure = 45, worth_alpha = 55, worth_beta = 45
      WHERE id = ${lowWorthFactId}
    `;
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    cognitive,
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
  };
  app = createApp({ deps, version: "cascade-test" });
}, 180_000);

afterAll(async () => {
  await pgClient?.end().catch(() => void 0);
  await apiKeyLookupClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("POST /recall uses the v3 worth-gated cascade (not legacy searchMnemo)", () => {
  it("returns 200 with v1 shape and debug.tier signal when deps.cognitive is present", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        query: "pricing tiers",
        topK: 10,
        // Provide precomputed vector so no embed round-trip is needed.
        // Using the same unit vector as both facts → cosine = 1.0 for all hits.
        vector: UNIT_VECTOR,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // v1 contract preserved
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.debug).toBeDefined();
    const debug = body.debug as Record<string, unknown>;

    // tier signal proves the v3 cascade branch ran (not legacy searchMnemo)
    expect(debug).toHaveProperty("tier");
    expect(["hot", "cold"]).toContain(debug.tier);
  });

  it("ranks the high-worth fact above the low-worth fact (worth-gated ordering)", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        query: "pricing tiers",
        topK: 10,
        vector: UNIT_VECTOR,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; score: number }> };

    const hits = body.hits;
    expect(hits.length).toBeGreaterThanOrEqual(2);

    const highIdx = hits.findIndex((h) => h.id === highWorthFactId);
    const lowIdx = hits.findIndex((h) => h.id === lowWorthFactId);

    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    // High-worth (≈0.9) must rank before low-worth (≈0.1)
    expect(highIdx).toBeLessThan(lowIdx);
  });
});
