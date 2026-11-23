/**
 * FULL-STACK HTTP integration test for @mnemo-ai/server.
 *
 * Spins up a throwaway pgvector/pgvector:pg17 container (testcontainers),
 * enables the `vector` extension, applies ALL core SQL migrations via the
 * bundled `mnemo-migrate` CLI (child_process, for production fidelity),
 * then builds the real Hono app in-process with real @mnemo-ai/core deps
 * (no LLM provider) and drives it through `app.request(...)` — no socket.
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

// Resolve @mnemo-ai/core paths relative to THIS test file so the suite
// works on any developer machine and in CI without hardcoded /Users/...
// paths. From packages/server/src/__tests__/integration/ we go up 5 levels
// to /packages/, then into core/.
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
// v3 migrations (adapter-postgres) — run in addition to legacy core migrations
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const WS = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
// Well-formed key matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const PLAINTEXT_KEY = "mns_live_integrationtestkey0001";
const BOGUS_KEY = "mns_live_doesnotexistkey000000000";

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

let container: StartedTestContainer;
let databaseUrl: string;
let cognitive: import("../../deps.js").MnemoCore;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
/** Persists a fresh drift snapshot for WS (what the health job does in production). */
let takeHealthSnapshot: (workspaceId: string) => Promise<unknown>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...headers,
  };
}

beforeAll(async () => {
  // 1. Start pgvector container + enable the vector extension (migrations
  //    assume it exists; nothing in the stream runs CREATE EXTENSION).
  //    We use GenericContainer (testcontainers v10 split PostgreSqlContainer
  //    into the separate @testcontainers/postgresql module).
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

  const bootstrap = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  // 2. Apply ALL core migrations via the built CLI (0015 before 0016, …).
  const { stdout } = await execFileAsync(
    process.execPath,
    [MIGRATE_CLI, "--migrations-dir", MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 90_000 }
  );
  // execFile resolves only on exit code 0; a non-zero exit throws. Sanity-check output.
  expect(stdout).toContain("done");

  // 2b. Apply v3 (adapter-postgres) migrations → mnemosyne schema.
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  // 3. Mint an API key directly: bcrypt-hash the known plaintext (cost 12)
  //    and INSERT into mnemo_api_keys for ws_a.
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  expect(BCRYPT_COST).toBe(12);
  // Insert into mnemosyne.mnemo_api_keys (v3 schema) — createApiKeyLookup uses
  // search_path 'mnemosyne,public' so it resolves to the mnemosyne table first.
  const seed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await seed`
      INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
      VALUES (${"key_integration_01"}, ${WS}, ${keyHash}, ${"integration-test"}, ${"integration-test"},
              ARRAY['memory:read', 'memory:write', 'memory:delete']::text[])
    `;
  } finally {
    await seed.end();
  }

  // 4. Build the real app in-process with real core deps, NO llm provider.
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  apiKeyLookupClose = apiKeys.close;

  // 4b. Build the v3 cognitive core (required by ServerDeps since P20).
  // Uses a fake embed adapter (deterministic zero vector — 1536-dim) so recall
  // works without a real LLM. No Redis = cold cascade only.
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
  takeHealthSnapshot = (workspaceId) => v3Storage.getHealthSnapshot({ workspaceId, fresh: true });
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
  cognitive = v3CoreMod.createCore({
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
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  app = createApp({ deps, version: "2.0.0-test" });
}, 120_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("auth", () => {
  it("POST /recall with NO auth header -> 401", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /recall with a well-formed but non-existent key -> 401", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: { authorization: `Bearer ${BOGUS_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "hello" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("facts lifecycle (bitemporal)", () => {
  // Shared across the ordered tests below.
  let factId: string;

  it("POST /remember with valid key, body {statement, tags}, no attribution -> 201", async () => {
    // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the sole
    // write path for facts is now POST /remember. Both `deps.core` (legacy)
    // and `deps.cognitive`/`deps.storage` (v3) connect with
    // `search_path=mnemosyne,public` (packages/core/src/factory.ts) and
    // resolve the SAME unqualified `mnemo_fact` table — confirmed empirically
    // (GET/POST /facts/:id/* below still find a fact created via
    // POST /remember). "Dual core" means two application code paths over one
    // physical table, not two physical schemas.
    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        statement: "The pricing tier is $99/mo.",
        tags: ["pricing", "billing"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe("string");
    expect(body.workspaceId).toBe(WS);
    // No attribution supplied -> defaults to {}.
    expect(body.attribution).toEqual({});
    expect(body.statement).toBe("The pricing tier is $99/mo.");
    factId = body.id as string;
  });

  it("GET /facts/:id with valid key -> 200, content matches", async () => {
    // Legacy `deps.core.getFact` (FactSchema's own `content` field) still
    // finds the fact created via POST /remember above — same physical row,
    // read through the legacy mapper's field name.
    const res = await app.request(`/facts/${factId}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(factId);
    expect(body.content).toBe("The pricing tier is $99/mo.");
    expect(body.workspaceId).toBe(WS);
  });

  it("POST /facts/:id/pin {pinned:true} -> 200, pinned=true", async () => {
    const res = await app.request(`/facts/${factId}/pin`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pinned).toBe(true);
  });

  it("POST /recall returns 200 with hits array before deletion", async () => {
    // Supply a 1536-dim zero vector so the route doesn't 501 for missing LLM.
    // The fact was created via POST /remember (v3 cognitive write path);
    // v3 cognitive recall searches the same mnemosyne.mnemo_fact table, so we
    // still only assert the endpoint contract (200 + hits array), not the
    // specific factId (topK/ranking is not under test here).
    const vector = new Array(1536).fill(0);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "pricing", vector, topK: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: { id: string }[] };
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it("DELETE /facts/:id -> 204", async () => {
    const res = await app.request(`/facts/${factId}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(204);
  });

  it("GET /facts/:id after delete -> 404 (forgotten facts absent from current view)", async () => {
    const res = await app.request(`/facts/${factId}`, { headers: authed() });
    expect(res.status).toBe(404);
  });

  it("POST /recall does NOT find deleted fact", async () => {
    const vector = new Array(1536).fill(0);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "pricing", vector, topK: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: { id: string }[] };
    expect(body.hits.find((h) => h.id === factId)).toBeUndefined();
  });
});

describe("recall", () => {
  it("POST /recall with valid key + a vector -> 200, body has hits array", async () => {
    const vector = new Array(1536).fill(0.1);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "pricing", vector, topK: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it("POST /recall with valid key + NO vector -> 200, the server embeds the query itself", async () => {
    // No LLM is wired, but the core has an embed adapter (fakeEmbed above), so
    // the server embeds the query and `debug.embedded` says so (cf845d92: it
    // reports whether the query was actually embedded, not a constant).
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "pricing" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; debug?: { embedded?: boolean } };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.debug?.embedded).toBe(true);
  });

  it("POST /recall with mode 'lexical' -> 200, nothing embedded", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "pricing", mode: "lexical" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; debug?: { embedded?: boolean } };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.debug?.embedded).toBe(false);
  });
});

describe("timeline", () => {
  it("GET /timeline?limit=10 -> 200, body has events array + nextCursor field", async () => {
    const res = await app.request("/timeline?limit=10", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.events)).toBe(true);
    expect("nextCursor" in body).toBe(true);
  });
});

describe("admin endpoints", () => {
  it("GET /admin/stats with a read-only key -> 200, trimmed (admin-only fields omitted)", async () => {
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.facts).toBeDefined();
    expect("embeddings" in body).toBe(false);
    expect("snapshot" in body).toBe(false);
  });

  it("GET /admin/stats with admin scope -> 200, returns workspace stats", async () => {
    // Its own workspace: "no snapshot yet" must not depend on whether an earlier
    // test in this file took one for the shared WS.
    const STATS_WS = "a1b2c3d4-e5f6-7890-abcd-ef12345678a5";
    const adminKey = "mns_live_admintestkey000000000001";
    const adminKeyHash = await bcrypt.hash(adminKey, BCRYPT_COST);
    const adminSeed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
    try {
      await adminSeed`
        INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
        VALUES (${"key_admin_01"}, ${STATS_WS}, ${adminKeyHash}, ${"admin-test"}, ${"admin-test"},
                ARRAY['memory:admin']::text[])
        ON CONFLICT (id) DO NOTHING
      `;
    } finally {
      await adminSeed.end();
    }

    const adminStats = async () => {
      const res = await app.request("/admin/stats", {
        headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    // Requirement 5 (admin-stats.ts): the snapshot-backed counts are null while
    // no drift snapshot exists — "unknown", never a fabricated 0.
    const before = await adminStats();
    expect((before.decisions as Record<string, unknown>).active).toBeNull();
    // A live count under the key's ceiling, snapshot or not.
    expect(typeof (before.relations as Record<string, unknown>).conflicts).toBe("number");
    expect((before.snapshot as Record<string, unknown>).available).toBe(false);

    await takeHealthSnapshot(STATS_WS);
    const body = await adminStats();
    expect((body.snapshot as Record<string, unknown>).available).toBe(true);

    // Verify structure
    expect(body.workspaceId).toBe(STATS_WS);
    expect(typeof body.generatedAt).toBe("string");
    expect(new Date(body.generatedAt as string).toISOString()).toBe(body.generatedAt);

    // Verify nested objects exist
    expect(body.facts).toBeDefined();
    expect(typeof (body.facts as Record<string, unknown>).live).toBe("number");
    expect(typeof (body.facts as Record<string, unknown>).closed).toBe("number");
    expect(typeof (body.facts as Record<string, unknown>).pinned).toBe("number");

    expect(body.decisions).toBeDefined();
    expect(typeof (body.decisions as Record<string, unknown>).active).toBe("number");

    expect(body.relations).toBeDefined();
    expect(typeof (body.relations as Record<string, unknown>).conflicts).toBe("number");

    expect(body.embeddings).toBeDefined();
    expect(typeof (body.embeddings as Record<string, unknown>).indexed).toBe("number");
    expect(typeof (body.embeddings as Record<string, unknown>).pending).toBe("number");

    expect(body.recall).toBeDefined();
  });
});

describe("governance endpoints", () => {
  it("GET /governance/drift without governance scope -> 403", async () => {
    const res = await app.request("/governance/drift", { headers: authed() });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("GET /governance/drift with governance scope -> 200, returns null or drift snapshot", async () => {
    // Create a governance API key for this test
    const govKey = "mns_live_govtestkey000000000001";
    const govKeyHash = await bcrypt.hash(govKey, BCRYPT_COST);
    const govSeed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
    try {
      await govSeed`
        INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
        VALUES (${"key_gov_01"}, ${WS}, ${govKeyHash}, ${"governance-test"}, ${"governance-test"},
                ARRAY['memory:governance']::text[])
        ON CONFLICT (id) DO NOTHING
      `;
    } finally {
      await govSeed.end();
    }

    const res = await app.request("/governance/drift", {
      headers: { authorization: `Bearer ${govKey}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Body can be null (no snapshot exists yet) or a HealthSnapshot object
    if (body !== null) {
      expect(body).toHaveProperty("workspaceId");
      expect(body).toHaveProperty("snapshotAt");
      expect(body).toHaveProperty("factCountActive");
      expect(body).toHaveProperty("factCountArchived");
      expect(body).toHaveProperty("factCountEmbedded");
      expect(body).toHaveProperty("factCountUnembedded");
      expect(body).toHaveProperty("decisionCountActive");
      expect(body).toHaveProperty("relationCountConflicts");
      expect(body).toHaveProperty("factsWithZeroHits");
      expect(body).toHaveProperty("recallHitRate30d");
      expect(body).toHaveProperty("extractionJobsFailed7d");
      expect(body).toHaveProperty("extractionJobsDeferred");

      // Verify types
      expect(typeof (body as Record<string, unknown>).workspaceId).toBe("string");
      expect(typeof (body as Record<string, unknown>).snapshotAt).toBe("string");
      expect(typeof (body as Record<string, unknown>).factCountActive).toBe("number");
      expect(typeof (body as Record<string, unknown>).factCountArchived).toBe("number");
    }
  });

  it("GET /governance/drift?fresh=true -> 200, computes fresh snapshot", async () => {
    // Reuse the governance key from the previous test
    const govKey = "mns_live_govtestkey000000000001";
    const res = await app.request("/governance/drift?fresh=true", {
      headers: { authorization: `Bearer ${govKey}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // With fresh=true, we should get a computed snapshot (not null)
    // However, it may still be null if no facts exist yet
    if (body !== null) {
      expect(body).toHaveProperty("workspaceId");
      expect((body as Record<string, unknown>).workspaceId).toBe(WS);
    }
  });

  it("GET /governance/worth with governance scope -> 200, returns worth scores with actions", async () => {
    // Reuse the governance key
    const govKey = "mns_live_govtestkey000000000001";
    const res = await app.request("/governance/worth", {
      headers: { authorization: `Bearer ${govKey}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.workspaceId).toBe(WS);
    expect(typeof body.computedAt).toBe("string");
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.offset).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.hasMore).toBe("boolean");

    // Verify item structure if any exist
    const items = body.items as unknown[];
    if (items.length > 0) {
      const item = items[0] as Record<string, unknown>;
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("subject");
      expect(item).toHaveProperty("statement");
      expect(item).toHaveProperty("worth");
      expect(item).toHaveProperty("worthAlpha");
      expect(item).toHaveProperty("worthBeta");
      expect(item).toHaveProperty("confidenceLower");
      expect(item).toHaveProperty("hitCount");
      expect(item).toHaveProperty("action");
      expect(["canonical", "promote", "demote", "neutral"]).toContain(item.action);
    }
  });
});
