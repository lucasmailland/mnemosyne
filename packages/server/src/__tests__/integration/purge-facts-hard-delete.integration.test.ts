/**
 * Contract test for `memory_purge` (packages/mcp/src/tools/purge.ts).
 *
 * `memory_purge`'s MCP description promises:
 *   "Elimina permanentemente facts de la base de datos (NO reversible).
 *    Requiere scope memory:hard_delete en el API key.
 *    action='fact': borra un fact por ID.
 *    action='closed': borra en bulk todos los facts olvidados (status=forgotten)."
 *
 * `client.purgeFact()` -> `DELETE /facts/:id/hard`
 * `client.purgeClosedFacts()` -> `DELETE /facts/purge`
 *
 * PURGE-1 — two real bugs, both fixed:
 *
 *   1. `deps.core.hardDeleteFact` / `deps.core.purgeClosedFacts` were declared
 *      optional on `ServerDeps["core"]` (deps.ts) but `createCore()`
 *      (packages/core/src/factory.ts) never implemented them, so both routes'
 *      `deps.core.X ? await deps.core.X(...) : <fallback>` guards always took
 *      the fallback branch — neither route ever deleted anything. Now
 *      implemented as real `DELETE FROM mnemo_fact` statements (raw SQL via
 *      `withMnemoTx`, same pattern as the sibling `closeFact` method),
 *      declared non-optional on `CoreContract` (factory-types.ts) so a future
 *      regression is a compile error, not a silent no-op.
 *   2. `DELETE /facts/purge` was registered AFTER `DELETE /facts/{id}` in
 *      routes/facts.ts. `/facts/{id}` is a wildcard that matches any single
 *      path segment, including the literal "purge" — Hono resolved it there
 *      first (id="purge"), so the bulk-purge handler was unreachable
 *      regardless of bug #1. Fixed by registering `/facts/purge` first.
 *
 * Deliberately NOT GDPR-compliant: neither route writes a deletion-log entry,
 * crypto-erases the actor's DEK, or appends a terminal audit entry — a raw
 * physical DELETE only, exactly as `CoreContract.hardDeleteFact`'s own
 * docstring promises. `DELETE /forget/fact/:id?mode=hard` (`forget()` in
 * packages/core/src/cognitive/forget.ts) remains the only GDPR Article 17
 * erasure path; `memory_purge`'s own MCP description says so.
 *
 * This test proves — against a REAL Postgres instance, through a real
 * non-superuser `mnemo_app_role` connection, exercising the actual HTTP
 * routes the MCP tool calls — that both actions now genuinely delete rows,
 * the route-ordering conflict is resolved, and the `memory:hard_delete`
 * scope gate still blocks unscoped callers on both paths.
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
const APP_ROLE = "purge_app";
const APP_PASSWORD = "purge_app_pass";

const TENANT_ID = "tenant-purge-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000001";

// Well-formed keys matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const KEY_WITH_HARD_DELETE = "mns_live_purgecontracthasscope01";
const KEY_WITHOUT_HARD_DELETE = "mns_live_purgecontractnoscope001";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(key: string, headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers };
}

async function createFact(content: string): Promise<string> {
  // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the sole
  // write path is now POST /remember, which lossless-remaps
  // {content, tags} -> {statement, tags}.
  const res = await app.request("/remember", {
    method: "POST",
    headers: authed(KEY_WITH_HARD_DELETE),
    body: JSON.stringify({ statement: content, tags: [] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function factRowStatus(
  id: string
): Promise<{ status: string; validTo: string | null } | undefined> {
  const rows = await admin<Array<{ status: string; valid_to: string | null }>>`
    SELECT status, valid_to::text
    FROM mnemosyne.mnemo_fact
    WHERE id = ${id} AND workspace_id = ${WS}
  `;
  const row = rows[0];
  return row ? { status: row.status, validTo: row.valid_to } : undefined;
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
  // session-scratch-rls-nonsuperuser.integration.test.ts and
  // session-lifecycle-rls.integration.test.ts.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Purge contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Purge contract workspace"}, ${"purge-contract"}, ${TENANT_ID})
  `;

  const [hashWith, hashWithout] = await Promise.all([
    bcrypt.hash(KEY_WITH_HARD_DELETE, BCRYPT_COST),
    bcrypt.hash(KEY_WITHOUT_HARD_DELETE, BCRYPT_COST),
  ]);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_purge_with_scope"}, ${WS}, ${hashWith}, ${"purge-with-scope"}, ${"purge-with-scope"},
       ARRAY['memory:read','memory:write','memory:delete','memory:hard_delete']::text[]),
      (${"key_purge_without_scope"}, ${WS}, ${hashWithout}, ${"purge-without-scope"}, ${"purge-without-scope"},
       ARRAY['memory:read','memory:write','memory:delete']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  // v3 cognitive core — required by ServerDeps since P20. Fake embed adapter,
  // no LLM, matching api.integration.test.ts's pattern (recall isn't under
  // test here; only the facts hard-delete/purge routes are).
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
  app = createApp({ deps, version: "purge-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_purge action='fact' — DELETE /facts/:id/hard", () => {
  it("scope gate blocks the request when memory:hard_delete is absent (fact left untouched)", async () => {
    const id = await createFact("purge scope-gate probe");

    const res = await app.request(`/facts/${id}/hard`, {
      method: "DELETE",
      headers: authed(KEY_WITHOUT_HARD_DELETE),
    });
    expect(res.status).toBe(403);

    const row = await factRowStatus(id);
    expect(row).toBeDefined();
    expect(row?.status).toBe("active");
    expect(row?.validTo).toBeNull();
  });

  it("with the correct scope, physically deletes an existing fact's row", async () => {
    const id = await createFact("purge single-fact real-delete probe");

    const before = await factRowStatus(id);
    expect(before).toEqual({ status: "active", validTo: null });

    const res = await app.request(`/facts/${id}/hard`, {
      method: "DELETE",
      headers: authed(KEY_WITH_HARD_DELETE),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    // The row is genuinely GONE, not just closed (status='forgotten' would
    // still be a row; factRowStatus returns undefined only on a real miss).
    const after = await factRowStatus(id);
    expect(after).toBeUndefined();
  });

  it("returns 404 for a fact id that was never created, and does not touch other facts", async () => {
    const other = await createFact("purge single-fact 404 — unrelated fact stays");

    const res = await app.request(`/facts/does-not-exist/hard`, {
      method: "DELETE",
      headers: authed(KEY_WITH_HARD_DELETE),
    });
    expect(res.status).toBe(404);

    const otherRow = await factRowStatus(other);
    expect(otherRow).toEqual({ status: "active", validTo: null });
  });
});

describe("memory_purge action='closed' — DELETE /facts/purge", () => {
  it("scope gate blocks the request when memory:hard_delete is absent", async () => {
    const res = await app.request("/facts/purge", {
      method: "DELETE",
      headers: authed(KEY_WITHOUT_HARD_DELETE),
    });
    expect(res.status).toBe(403);
  });

  it("route is reachable — DELETE /facts/purge no longer collides with DELETE /facts/{id}", async () => {
    // Regression guard for the route-ordering bug: a literal "purge" id
    // must never again reach this handler and get treated as {id}="purge".
    const res = await app.request("/facts/purge", {
      method: "DELETE",
      headers: authed(KEY_WITH_HARD_DELETE),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: expect.any(Number) });
  });

  it("physically deletes every forgotten fact in the workspace, leaving active and pinned facts untouched", async () => {
    const activeId = await createFact("purge bulk — stays active");
    const pinnedId = await createFact("purge bulk — stays pinned");
    const forgottenId = await createFact("purge bulk — soft-forgotten, should be swept");

    const pinRes = await app.request(`/facts/${pinnedId}/pin`, {
      method: "POST",
      headers: authed(KEY_WITH_HARD_DELETE),
      body: JSON.stringify({ pinned: true }),
    });
    expect(pinRes.status).toBe(200);

    // Soft-delete another (DELETE /facts/:id -> status='forgotten', valid_to=now()).
    const softRes = await app.request(`/facts/${forgottenId}`, {
      method: "DELETE",
      headers: authed(KEY_WITH_HARD_DELETE),
    });
    expect(softRes.status).toBe(204);

    const beforePurge = await factRowStatus(forgottenId);
    expect(beforePurge?.status).toBe("forgotten");
    expect(beforePurge?.validTo).not.toBeNull();

    const purgeRes = await app.request("/facts/purge", {
      method: "DELETE",
      headers: authed(KEY_WITH_HARD_DELETE),
    });
    expect(purgeRes.status).toBe(200);
    const body = (await purgeRes.json()) as { deleted: number };
    expect(body.deleted).toBeGreaterThanOrEqual(1);

    // The forgotten fact row is genuinely gone.
    const afterForgotten = await factRowStatus(forgottenId);
    expect(afterForgotten).toBeUndefined();

    // Active and pinned facts are untouched — the sweep only targets
    // status='forgotten'.
    const afterActive = await factRowStatus(activeId);
    expect(afterActive).toEqual({ status: "active", validTo: null });
    const afterPinned = await factRowStatus(pinnedId);
    expect(afterPinned?.status).toBe("active");
  });

  it("is idempotent — a second sweep with nothing left to purge returns deleted: 0", async () => {
    const res = await app.request("/facts/purge", {
      method: "DELETE",
      headers: authed(KEY_WITH_HARD_DELETE),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0 });
  });
});
