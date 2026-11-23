/**
 * Contract test for `memory_decide` (packages/mcp/src/tools/decide.ts),
 * covering docs/archive/openspec/tool-promise-remediation/tools/memory_decide.md.
 *
 * `memory_decide`'s MCP description promises:
 *   "Persiste una decisión durable en la memoria del workspace ... Registra
 *    el summary, el rationale, las alternativas consideradas y cuál fue
 *    elegida. Idempotente por topic_key normalizado."
 * Its `topicKey` field description additionally promises: "Omitir deja al
 * servidor calcularla a partir de title."
 *
 * `memory_decide` -> client.createDecision() -> POST /decisions
 * (packages/server/src/routes/decisions.ts) -> deps.core.createDecision()
 * (packages/core/src/factory.ts:1577) -> coreCreateDecision()
 * (packages/core/src/primitives/decision.ts). That last function is the
 * ONLY place upsert-by-topic_key logic lives.
 *
 * DECIDE-1 — FIXED 2026-07-31 (docs/STATUS.md): the "normalizado" half of
 * the promise used to be false — the lookup was a byte-exact `eq()` against
 * the raw `topicKey` string, and the DB-level partial unique index
 * (`uniq_mnemo_decision_topic`) was a plain btree over the raw column, not
 * case-insensitive. "Auth-Strategy" vs "auth-strategy" (or the same string
 * with trailing whitespace) created two independent rows instead of one.
 * Fixed at both layers: the lookup now compares `lower(btrim(topic_key))`,
 * and migration `0017_decision_topic_key_normalized_unique.sql` rebuilds
 * the unique index as the same expression, so a concurrent differently-cased
 * write can't race past the app-level SELECT and create a duplicate either.
 * The stored `topic_key` keeps whichever casing the FIRST caller supplied —
 * only the matching is normalized, not the data.
 *
 * The OTHER half of the promise — "omitir deja al servidor calcularla a
 * partir de title" — remains false and is NOT fixed here: `input.topicKey`
 * falsy still skips the whole upsert branch, so omitting `topicKey` still
 * creates a new row every call. No derivation algorithm was ever specified
 * anywhere (what would "calculate from title" even mean — slugify? hash?
 * truncate?), so implementing one now would be inventing new behavior, not
 * fixing a bug. The tool's description was corrected to stop promising it.
 *
 * This test proves, against a REAL Postgres instance through a real
 * non-superuser `mnemo_app_role`-inheriting connection (production never
 * connects as a Postgres superuser — see packages/core/src/tx.ts's
 * `withMnemoTx` doc comment), exercising the actual HTTP route the MCP tool
 * calls:
 *
 *   1. All documented fields (title="summary", body="rationale +
 *      alternatives + chosen") round-trip byte-exact through POST, GET, and
 *      a direct DB read — nothing is silently dropped or mutated.
 *   2. A second POST with the BYTE-IDENTICAL topic_key updates the existing
 *      row (revision_count increments, title/body take the new call's
 *      values) instead of creating a second row.
 *   3. A second POST with a topic_key that differs ONLY in case
 *      ("Auth-Strategy" vs "auth-strategy") now ALSO updates the same row —
 *      the normalized match works.
 *   4. Same for leading/trailing whitespace.
 *   5. Omitting `topicKey` across repeated calls with the identical `title`
 *      still creates a new row every time — confirms the (deliberately
 *      unfixed) absence of title-derivation.
 *
 * Hermetic & CI-safe: fresh throwaway pgvector container per run. Requires
 * Docker.
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
const APP_ROLE = "decide_app";
const APP_PASSWORD = "decide_app_pass";

const TENANT_ID = "tenant-decide-contract";
const WS = "9b1f9c00-0000-4000-8000-0000000000d1";
const KEY = "mns_live_decidecontractkey0000001";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers };
}

interface DecisionBody {
  id: string;
  workspaceId: string;
  kind: string;
  title: string;
  body: string;
  topicKey: string | null;
  revisionCount: number;
  status: string;
  [key: string]: unknown;
}

async function createDecision(input: {
  kind: string;
  title: string;
  body: string;
  topicKey?: string;
}): Promise<{ status: number; body: DecisionBody }> {
  const res = await app.request("/decisions", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as DecisionBody;
  return { status: res.status, body };
}

async function getDecision(id: string): Promise<{ status: number; body: DecisionBody }> {
  const res = await app.request(`/decisions/${id}`, { headers: authed() });
  const body = (await res.json()) as DecisionBody;
  return { status: res.status, body };
}

/** Raw row read — bypasses the HTTP layer entirely for byte-exact proof. */
async function rawDecisionRows(predicate: { topicKey?: string; title?: string }): Promise<
  Array<{
    id: string;
    title: string;
    body: string;
    topic_key: string | null;
    revision_count: number;
    status: string;
  }>
> {
  if (predicate.topicKey !== undefined) {
    return admin<
      Array<{
        id: string;
        title: string;
        body: string;
        topic_key: string | null;
        revision_count: number;
        status: string;
      }>
    >`
      SELECT id, title, body, topic_key, revision_count, status
      FROM mnemosyne.mnemo_decision
      WHERE workspace_id = ${WS} AND topic_key = ${predicate.topicKey}
      ORDER BY created_at ASC
    `;
  }
  return admin<
    Array<{
      id: string;
      title: string;
      body: string;
      topic_key: string | null;
      revision_count: number;
      status: string;
    }>
  >`
    SELECT id, title, body, topic_key, revision_count, status
    FROM mnemosyne.mnemo_decision
    WHERE workspace_id = ${WS} AND title = ${predicate.title ?? ""}
    ORDER BY created_at ASC
  `;
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
  // purge-facts-hard-delete.integration.test.ts / doctor-nonsuperuser. This
  // is the connecting role withMnemoTx's `SET LOCAL ROLE app_user` runs
  // under in production, never a Postgres superuser.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT app_user TO ${APP_ROLE};
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Decide contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Decide contract workspace"}, ${"decide-contract"}, ${TENANT_ID})
  `;

  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_decide_test"}, ${WS}, ${keyHash}, ${"decide-contract"}, ${"decide-contract"},
            ARRAY['memory:read', 'memory:write']::text[])
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
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_decide contract — POST /decisions", () => {
  it("scenario 1: all documented fields (summary/rationale/alternatives/chosen packed into title+body) round-trip byte-exact", async () => {
    const title = "Use PostgreSQL as the primary datastore (summary).";
    const body =
      "Rationale: need ACID + pgvector for hybrid recall in one engine. " +
      "Alternatives considered: (a) MongoDB — rejected, no native vector search at the time; " +
      "(b) DynamoDB + separate vector DB — rejected, two systems to keep consistent. " +
      "Chosen: PostgreSQL + pgvector — unicode check: café, naïve, 日本語, emoji 🎯.";

    const created = await createDecision({ kind: "architecture", title, body });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe(title);
    expect(created.body.body).toBe(body);
    expect(created.body.kind).toBe("architecture");

    // Fetched back via GET — same fields, unmodified.
    const fetched = await getDecision(created.body.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.title).toBe(title);
    expect(fetched.body.body).toBe(body);

    // Direct DB read — proves nothing is lost/mutated between the app layer
    // and the actual persisted row.
    const rows = await rawDecisionRows({ title });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe(body);
  });

  it("scenario 2 (exact-match upsert WORKS): identical topic_key on a 2nd call updates the existing row, does not duplicate", async () => {
    const topicKey = "auth-strategy-exact-match";
    const first = await createDecision({
      kind: "decision",
      title: "Use JWT for auth (v1)",
      body: "Initial rationale.",
      topicKey,
    });
    expect(first.status).toBe(201);
    expect(first.body.revisionCount).toBe(1);

    const second = await createDecision({
      kind: "decision",
      title: "Use JWT for auth (v2, revised)",
      body: "Updated rationale after reconsidering refresh tokens.",
      topicKey,
    });
    expect(second.status).toBe(201);

    // Same row — id unchanged, revision incremented, content updated.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.revisionCount).toBe(2);
    expect(second.body.title).toBe("Use JWT for auth (v2, revised)");

    const rows = await rawDecisionRows({ topicKey });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision_count).toBe(2);
    expect(rows[0]?.body).toBe("Updated rationale after reconsidering refresh tokens.");
  });

  it("scenario 3 (FIXED, DECIDE-1): case-only variation now upserts the SAME row instead of duplicating", async () => {
    const first = await createDecision({
      kind: "decision",
      title: "Case variant A",
      body: "First call, mixed-case topic key.",
      topicKey: "Auth-Strategy-Case-Test",
    });
    expect(first.status).toBe(201);

    const second = await createDecision({
      kind: "decision",
      title: "Case variant B",
      body: "Second call, same topic conceptually, all-lowercase key.",
      topicKey: "auth-strategy-case-test",
    });
    expect(second.status).toBe(201);

    // Same row — the normalized lookup (lower(btrim(...))) matches case
    // variants, so this is a real upsert, not a second insert.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.revisionCount).toBe(2);
    expect(second.body.title).toBe("Case variant B");

    // The stored topic_key keeps the FIRST caller's original casing — only
    // the matching is normalized, not the data.
    const mixedCaseRows = await rawDecisionRows({ topicKey: "Auth-Strategy-Case-Test" });
    const lowerCaseRows = await rawDecisionRows({ topicKey: "auth-strategy-case-test" });
    expect(mixedCaseRows).toHaveLength(1);
    expect(lowerCaseRows).toHaveLength(0);
    expect(mixedCaseRows[0]?.id).toBe(first.body.id);
    expect(mixedCaseRows[0]?.revision_count).toBe(2);
  });

  it("scenario 4 (FIXED, DECIDE-1): leading/trailing whitespace variation also upserts the same row", async () => {
    const first = await createDecision({
      kind: "decision",
      title: "Whitespace variant A",
      body: "First call, no padding.",
      topicKey: "billing-policy-ws-test",
    });
    expect(first.status).toBe(201);

    const second = await createDecision({
      kind: "decision",
      title: "Whitespace variant B",
      body: "Second call, trailing space in topic key.",
      topicKey: "billing-policy-ws-test ",
    });
    expect(second.status).toBe(201);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.revisionCount).toBe(2);

    const untrimmedRows = await rawDecisionRows({ topicKey: "billing-policy-ws-test" });
    expect(untrimmedRows).toHaveLength(1);
    expect(untrimmedRows[0]?.id).toBe(first.body.id);
  });

  it("scenario 5 (DISPROVES 'omitir deja al servidor calcularla a partir de title'): omitting topicKey never derives one — repeated identical-title calls all create new rows", async () => {
    const title = "Adopt trunk-based development (no topicKey supplied).";

    const first = await createDecision({ kind: "process", title, body: "First rationale." });
    expect(first.status).toBe(201);
    expect(first.body.topicKey).toBeNull();

    const second = await createDecision({
      kind: "process",
      title,
      body: "Second, unrelated call.",
    });
    expect(second.status).toBe(201);
    expect(second.body.topicKey).toBeNull();

    // No dedup happened — the server never computed a topic_key from title,
    // so this is two fully independent rows, not an idempotent upsert.
    expect(second.body.id).not.toBe(first.body.id);

    const rows = await rawDecisionRows({ title });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.topic_key === null)).toBe(true);
  });
});
