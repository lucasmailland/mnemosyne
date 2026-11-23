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
const APP_ROLE = "prov_app";
const APP_PASSWORD = "prov_app_pass";

const TENANT_ID = "tenant-fact-prov";
const WS = "9b1f9c00-0000-4000-8000-000000000011";
const WS_B = "9b1f9c00-0000-4000-8000-000000000012";

// Well-formed keys matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const KEY_ADMIN = "mns_live_factprovenanceint00001";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
// flatten-legacy-dual-core Phase 9 (task 9.1): hoisted so the STATS-1 cron
// test below can call `v3Storage.getHealthSnapshot` directly — the same
// v3 StorageAdapter instance `deps.storage` uses, exercising the exact
// method the `mnemo.health.snapshot` cron handler calls.
let v3Storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${KEY_ADMIN}`, "content-type": "application/json", ...headers };
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

  // Real non-superuser, non-BYPASSRLS application role — same discipline as
  // purge-facts-hard-delete.integration.test.ts / session-scratch-rls-nonsuperuser.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Prov tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Prov workspace"}, ${"prov-a"}, ${TENANT_ID})
  `;

  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_B}, ${"Prov workspace B"}, ${"prov-b"}, ${TENANT_ID})
  `;

  const hashAdmin = await bcrypt.hash(KEY_ADMIN, BCRYPT_COST);
  expect(BCRYPT_COST).toBe(12);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_prov"}, ${WS}, ${hashAdmin}, ${"prov-key"}, ${"prov-key"},
       ARRAY['memory:read','memory:write']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  // flatten-legacy-dual-core Phase 9 (task 9.1): the `withMnemoTx`/`getDb()`
  // singleton-registration block that used to live here (Phase 7 comment)
  // is REMOVED — it existed only so this file's STATS-1 cron test below
  // could call `@mnemo-ai/core`'s `getHealthSnapshot` directly. That
  // function is now ported to the v3 `StorageAdapter` port
  // (`v3Storage.getHealthSnapshot`, constructed below), which manages its
  // own transaction via `mnemo_set_workspace()` — no `setDb()` registration
  // needed. Confirmed nothing else in this file touches `withMnemoTx`/
  // `getDb()`.

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
  v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
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
    // GET /health (mountVitals) reads deps.storage.getWorkspaceVitals since
    // flatten-legacy-dual-core PR6 (was deps.core.vitals()) — v3Storage is
    // already constructed above for the cognitive/outbox wiring.
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
  app = createApp({ deps, version: "fact-prov-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("GET /facts/:id provenance (real Postgres)", () => {
  const get = async (id: string, qs = "") =>
    app.request(`/facts/${id}${qs}`, { headers: authed() });
  const mk = (workspaceId: string, statement: string, topicKey: string) =>
    v3Storage.createFact({
      workspaceId,
      scope: "global",
      statement,
      subject: "infra",
      kind: "other",
      sensitivity: "internal",
      topicKey,
    });

  it("reads a superseded fact and its successor through storage", async () => {
    const first = await mk(WS, "El cache corre sobre Redis.", "cache/engine");
    const merged = await v3Storage.mergeFactByTopicKey({
      workspaceId: WS,
      topicKey: "cache/engine",
      statement: "El cache corre sobre Valkey.",
    });
    expect(merged).not.toBeNull();

    expect((await get(first.id)).status).toBe(404);
    const old = (await (
      await get(first.id, "?includeClosed=true&provenance=true")
    ).json()) as Record<string, unknown>;
    expect(old.supersededById).toBe(merged!.id);
    expect(old.supersededAt).toBe(merged!.createdAt.toISOString());

    const succ = (await (await get(merged!.id, "?provenance=true")).json()) as Record<
      string,
      unknown
    >;
    expect(succ.supersedesIds).toEqual([first.id]);
    expect(succ).not.toHaveProperty("supersededById");
  });

  it("never surfaces a record or relation from another workspace", async () => {
    const a1 = await mk(WS, "A uno", "iso/a1");
    const a2 = await mk(WS, "A dos", "iso/a2");
    const b1 = await mk(WS_B, "B uno", "iso/b1");
    const b2 = await mk(WS_B, "B dos", "iso/b2");
    await v3Storage.archiveFact(a1.id, WS);
    // Cross-workspace lineage in both directions, written as superuser:
    // B fact supersedes A fact (incoming for a1), and A fact supersedes B fact (outgoing for a2).
    await admin`
      INSERT INTO mnemosyne.mnemo_relation
        (id, workspace_id, source_kind, source_id, target_kind, target_id, relation)
      VALUES
        (${"r-x1"}, ${WS_B}, 'fact', ${b1.id}, 'fact', ${a1.id}, 'supersedes'),
        (${"r-x2"}, ${WS_B}, 'fact', ${a2.id}, 'fact', ${b2.id}, 'supersedes'),
        (${"r-x3"}, ${WS}, 'fact', ${a2.id}, 'fact', ${b2.id}, 'supersedes'),
        (${"r-x4"}, ${WS}, 'fact', ${b1.id}, 'fact', ${a1.id}, 'supersedes')
    `;
    const ep = await v3Storage.createEpisode({
      workspaceId: WS_B,
      title: "B episode",
      narrative: "secret",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      sourceConversationId: "conv-from-B",
    });
    await admin`UPDATE mnemosyne.mnemo_fact SET episode_id = ${ep.id} WHERE id = ${a2.id}`;

    const q = "?includeClosed=true&provenance=true";
    const one = (await (await get(a1.id, q)).json()) as Record<string, unknown>;
    // r-x4 names a WS_B fact as successor inside WS: the fact is invisible, so it reads as none.
    expect(one.supersededById).toBeNull();
    expect(one).not.toHaveProperty("supersededAt");
    const two = (await (await get(a2.id, q)).json()) as Record<string, unknown>;
    expect(two.supersedesIds).toEqual([]);
    expect(two.sessionId).not.toBe("conv-from-B");
    expect(JSON.stringify([one, two])).not.toMatch(new RegExp(`${b1.id}|${b2.id}|conv-from-B`));
  });
});
