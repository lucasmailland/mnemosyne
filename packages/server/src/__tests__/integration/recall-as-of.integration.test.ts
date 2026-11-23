/**
 * Integration test: point-in-time recall (`asOf`) against a real Postgres.
 *
 * Line 3 of the fictional Larkspur Robotics warehouse ran firmware 4.1 during
 * January and 4.2 from February 1. A recall at an instant in January must rank
 * the 4.1 fact (closed since, so `status: "superseded"`); one in February, or
 * one without `asOf`, the 4.2 fact. The same holds on the lexical arm, for a
 * decision, and for GET /facts?asOf, whose snapshot used to drop closed rows.
 *
 * Hermetic: fresh pgvector container per run. Requires Docker.
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

const WS = "17e5f9a3-0002-0002-0002-000000000002"; // valid UUID for mnemosyne schema
const PLAINTEXT_KEY = "mns_live_recallasoftestkey000001";
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

let oldFactId: string;
let newFactId: string;
let oldDecisionId: string;

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
    VALUES (${"key_recall_as_of_01"}, ${WS}, ${keyHash}, ${"recall-as-of-test"}, ${"recall-as-of-test"},
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

  const write = (content: string, kind: "fact" | "decision" = "fact") =>
    cognitive.remember({ workspaceId: WS, kind, content, sensitivity: "internal" }, auth);
  oldFactId = (await write("Line 3 runs firmware 4.1 on the sorting robots.")).id;
  newFactId = (await write("Line 3 runs firmware 4.2 on the sorting robots, released in February."))
    .id;
  oldDecisionId = (
    await write(
      "Decision: line 3 sorting robots stay on firmware 4.1 for the January audit.",
      "decision"
    )
  ).id;
  await vectorAdapter.upsert(oldFactId, UNIT_FLOAT32, { workspaceId: WS });
  await vectorAdapter.upsert(newFactId, UNIT_FLOAT32, { workspaceId: WS });

  // Bitemporal history set directly: 4.1 valid in January and closed on
  // February 1 (as a replace leaves it), 4.2 valid from February 1.
  await pgClient.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('mnemosyne.workspace_id', ${WS}, true)`;
    await tx`
      UPDATE mnemosyne.mnemo_fact
         SET valid_from = '2026-01-01T00:00:00Z', valid_to = '2026-02-01T00:00:00Z',
             status = 'forgotten'
       WHERE id = ${oldFactId}
    `;
    await tx`UPDATE mnemosyne.mnemo_fact SET valid_from = '2026-02-01T00:00:00Z' WHERE id = ${newFactId}`;
    await tx`
      UPDATE mnemosyne.mnemo_decision
         SET valid_from = '2026-01-01T00:00:00Z', valid_to = '2026-02-01T00:00:00Z'
       WHERE id = ${oldDecisionId}
    `;
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    cognitive,
    storage,
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
  app = createApp({ deps, version: "as-of-test" });
}, 180_000);

afterAll(async () => {
  await pgClient?.end().catch(() => void 0);
  await apiKeyLookupClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

const JANUARY = "2026-01-15T00:00:00Z";
const FEBRUARY = "2026-02-15T00:00:00Z";

async function recall(body: Record<string, unknown>) {
  const res = await app.request("/recall", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ query: "line 3 sorting robots firmware", topK: 10, ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    hits: Array<{ id: string; kind: string; status?: string }>;
    debug: { tier?: string };
  };
}
const ids = (r: { hits: Array<{ id: string }> }) => r.hits.map((h) => h.id);

describe("POST /recall with asOf", () => {
  it("ranks what was valid at the instant, closed since or not", async () => {
    const january = await recall({ vector: UNIT_VECTOR, asOf: JANUARY });
    expect(ids(january)).toContain(oldFactId);
    expect(ids(january)).not.toContain(newFactId);
    expect(january.hits.find((h) => h.id === oldFactId)?.status).toBe("superseded");
    expect(january.debug.tier).toBe("cold");

    const february = await recall({ vector: UNIT_VECTOR, asOf: FEBRUARY });
    expect(ids(february)).toContain(newFactId);
    expect(ids(february)).not.toContain(oldFactId);
  });

  it("answers with the present without asOf", async () => {
    const now = await recall({ vector: UNIT_VECTOR });
    expect(ids(now)).toContain(newFactId);
    expect(ids(now)).not.toContain(oldFactId);
  });

  it("applies the instant on the lexical arm too, before its limit", async () => {
    const january = await recall({ mode: "lexical", asOf: JANUARY });
    expect(ids(january)).toContain(oldFactId);
    expect(ids(january)).not.toContain(newFactId);
  });

  it("applies the instant to decisions", async () => {
    const january = await recall({ mode: "lexical", kinds: ["decision"], asOf: JANUARY });
    expect(ids(january)).toEqual([oldDecisionId]);
    const february = await recall({ mode: "lexical", kinds: ["decision"], asOf: FEBRUARY });
    expect(ids(february)).toEqual([]);
  });

  it("refuses an instant in the future", async () => {
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "firmware", asOf: "2999-01-01T00:00:00Z" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /facts?asOf", () => {
  it("returns the rows valid at the instant, including ones closed since", async () => {
    const res = await app.request(`/facts?asOf=${encodeURIComponent(JANUARY)}`, {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const listed = body.items.map((f) => f.id);
    expect(listed).toContain(oldFactId);
    expect(listed).not.toContain(newFactId);
  });
});
