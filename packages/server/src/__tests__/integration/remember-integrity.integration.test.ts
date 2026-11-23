/**
 * WP-5 — POST /remember end to end against real Postgres, through the real
 * HTTP app, with storage and the vector index connected as a NOSUPERUSER
 * NOBYPASSRLS role that only inherits `mnemo_app_role` (as production's
 * `mnemo_app` does under FORCE RLS).
 *
 *   - CHAOS-7: ten concurrent identical writes used to return a mix of 201 and
 *     500 (`uniq_mnemo_fact_dedup`) although one row was stored. Every caller
 *     must now get 201 and the same id. Same for a topicKey race
 *     (`idx_fact_topic`), whose loser also used to see a 500.
 *   - CHAOS-5: with the embed provider unreachable, a write used to 500 and
 *     store nothing. It must now be stored (201, `embeddingDeferred`), be
 *     full-text searchable at once, and carry a queued embedding job.
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

const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_ROLE = "remember_integrity_app";
const APP_PASSWORD = "remember_integrity_app_pass";

const TENANT_ID = "tenant-remember-integrity";
const WS = "9b1f9c00-0000-4000-8000-000000000519";
const KEY = "mns_live_rememberintegrityrealpg01";

const DIMS = 1536;
let embedderUp = true;

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
}

async function remember(body: Record<string, unknown>) {
  const res = await app.request("/remember", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
  const superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }
  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });

  admin = postgres(superUrl, { max: 2, onnotice: () => void 0 });
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"WP-5 tenant"})`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"WP-5 workspace"}, ${"wp5-remember"}, ${TENANT_ID})
  `;
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_wp5_remember"}, ${WS}, ${keyHash}, ${"wp5"}, ${"wp5"},
            ARRAY['memory:read','memory:write','memory:delete','memory:event']::text[])
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
  // A distinct vector per text, so identical statements embed identically
  // and different ones do not collide as "the same" memory.
  const vectorFor = (text: string) => {
    const v = new Float32Array(DIMS);
    for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % DIMS] += 1;
    return v;
  };
  const embed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "wp5-embed",
    model: "wp5-model",
    dimensions: DIMS,
    async embed(texts) {
      if (!embedderUp) throw new Error("LLMProviderError: connect ECONNREFUSED 127.0.0.1:1");
      return texts.map(vectorFor);
    },
    async embedSingle(text) {
      if (!embedderUp) throw new Error("LLMProviderError: connect ECONNREFUSED 127.0.0.1:1");
      return vectorFor(text);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const { db, pgClient } = adapterPgMod.createDrizzleClient(appUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient, undefined);
  const vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appUrl });
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
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const telemetry = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outbox: import("@mnemo-ai/types").OutboxAdapter = {
    append: (e) => storage.appendOutbox(e),
    claimBatch: (n) => storage.claimOutbox(n),
    markProcessed: (ids) => storage.markOutboxProcessed(ids),
    markFailed: (id, err) => storage.markOutboxFailed(id, err),
    getStats: async () => ({ pending: 0, failed: 0, oldestPendingMs: 0 }),
  };
  const cognitive = v3CoreMod.createCore({
    storage,
    vector,
    embed,
    outbox,
    logger: noopLogger,
    telemetry,
  });
  const deps: ServerDeps = {
    apiKeys,
    cognitive,
    storage,
    llm: undefined,
    embedModel: "wp5-model",
    telemetry,
  };
  app = createApp({ deps, version: "wp5-remember-integrity" });
}, 240_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("CHAOS-7 — concurrent identical writes all land on one row", () => {
  it("answers 201 with the same id to ten concurrent identical remembers", async () => {
    const statement = "The ledger reconciliation job runs at 02:15 UTC.";
    const results = await Promise.all(Array.from({ length: 10 }, () => remember({ statement })));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const rows = await admin`
      SELECT id FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND statement = ${statement} AND valid_to IS NULL
    `;
    expect(rows).toHaveLength(1);
  });

  it("never answers 500 to concurrent writes racing on one topicKey", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        remember({
          statement: `The api gateway timeout is ${30 + i} seconds.`,
          topicKey: "infra/gateway-timeout",
        })
      )
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    const live = await admin`
      SELECT id FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND topic_key = 'infra/gateway-timeout' AND valid_to IS NULL
    `;
    expect(live).toHaveLength(1);
  });
});

describe("CHAOS-5 — embedder down: stored now, embedded later", () => {
  it("stores the write, reports the deferral and finds it by full text", async () => {
    embedderUp = false;
    try {
      const statement = "The settlement export uploads to the partner SFTP at midnight.";
      const { status, body } = await remember({ statement });
      expect(status).toBe(201);
      expect(body.embeddingDeferred).toBe(true);
      const id = body.id as string;

      const [row] = await admin<Array<{ embedding: string | null }>>`
        SELECT embedding::text AS embedding FROM mnemosyne.mnemo_fact WHERE id = ${id}
      `;
      expect(row).toBeDefined();
      expect(row!.embedding).toBeNull();
      const jobs = await admin<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM mnemosyne.mnemo_outbox
        WHERE workspace_id = ${WS} AND event_type = 'vector_upsert' AND payload->>'id' = ${id}
      `;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).toMatchObject({ text: statement, indexLsh: true });

      const res = await app.request("/facts?q=settlement%20export", { headers: authed() });
      expect(res.status).toBe(200);
      const list = (await res.json()) as { items: Array<{ id: string }> };
      expect(list.items.map((f) => f.id)).toContain(id);
    } finally {
      embedderUp = true;
    }
  });
});

// Review round — no existence oracle above the caller's read ceiling. The key
// in this file has no per-key grant, so the process default (`internal`) is
// its ceiling.
describe("review round — events and entities above the ceiling stay invisible", () => {
  async function seedEvent(sensitivity: string): Promise<string> {
    const id = crypto.randomUUID();
    await admin`
      INSERT INTO mnemosyne.mnemo_event (id, workspace_id, type, name, description, occurred_at, source, sensitivity)
      VALUES (${id}, ${WS}, 'system', ${`ceiling ${sensitivity} event`}, ${"x"}, now(), 'test', ${sensitivity})
    `;
    return id;
  }

  it("answers 404, not 409, to forgetting or deleting a restricted event", async () => {
    const restricted = await seedEvent("restricted");
    const readable = await seedEvent("internal");
    const call = (path: string) => app.request(path, { method: "DELETE", headers: authed() });

    expect((await call(`/forget/event/${restricted}`)).status).toBe(404);
    expect((await call(`/events/${restricted}`)).status).toBe(404);
    expect((await call(`/forget/event/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call(`/forget/event/${readable}`)).status).toBe(409);
    expect((await call(`/events/${readable}`)).status).toBe(409);
  });

  it("does not hand out the id of a duplicate entity the caller cannot read", async () => {
    const restrictedId = crypto.randomUUID();
    const readableId = crypto.randomUUID();
    await admin`
      INSERT INTO mnemosyne.mnemo_entity (id, workspace_id, name, kind, sensitivity)
      VALUES (${restrictedId}, ${WS}, ${"Vaultkeeper Ltd"}, 'organization', 'restricted'),
             (${readableId}, ${WS}, ${"Openbook Ltd"}, 'organization', 'internal')
    `;
    const hidden = await remember({
      statement: "a vendor",
      kind: "entity",
      subtype: "organization",
      subject: "Vaultkeeper Ltd",
    });
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body)).not.toContain(restrictedId);

    const visible = await remember({
      statement: "a vendor",
      kind: "entity",
      subtype: "organization",
      subject: "Openbook Ltd",
    });
    expect(visible.status).toBe(409);
    expect(visible.body).toMatchObject({ error: { details: { existingId: readableId } } });
  });
});

// Q-3 (end-to-end verification) — the strict 400 for an unknown fact subtype
// lost 45 of 62 writes from an agent following the protocol. The categories
// agents use are fact kinds now (migration 0048), and anything else is stored
// as `other` with a warning. Written through the NOBYPASSRLS role above.
describe("Q-3 — the subtypes agents send are stored", () => {
  async function storedKind(id: unknown): Promise<string> {
    const [row] = await admin<Array<{ kind: string }>>`
      SELECT kind FROM mnemosyne.mnemo_fact WHERE id = ${id as string}`;
    return row!.kind;
  }

  it.each(["architecture", "bugfix", "config", "discovery", "policy", "process"])(
    "stores a fact sent with subtype '%s' under that kind",
    async (subtype) => {
      const { status, body } = await remember({
        statement: `q3: the payments-api ${subtype} note is kept here`,
        subtype,
      });
      expect(status).toBe(201);
      expect(body.warnings).toBeUndefined();
      expect(await storedKind(body.id)).toBe(subtype);
    }
  );

  it("stores an unknown subtype as 'other' and says so", async () => {
    const { status, body } = await remember({
      statement: "q3: billing moved from Adyen to Stripe",
      subtype: "decision",
    });
    expect(status).toBe(201);
    expect(body.warnings).toEqual([
      expect.objectContaining({
        code: "subtype_substituted",
        received: "decision",
        storedAs: "other",
      }),
    ]);
    expect(await storedKind(body.id)).toBe("other");
  });
});
