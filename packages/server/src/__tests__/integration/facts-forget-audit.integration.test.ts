/**
 * FORGET-1 — real-Postgres proof that `memory_forget` on a fact writes an
 * audit-log entry.
 *
 * `memory_forget` promises an archived primitive "queda para auditoría".
 * True for 10 of 11 `kind` values — they route through
 * `DELETE /forget/:kind/:id` → `deps.cognitive.forget()`, which appends a
 * non-terminal audit entry (`AuditRepository.appendAuditEntry`, `FOR
 * UPDATE`-free since SKILL-1). The DEFAULT kind, `"fact"`, took
 * `DELETE /facts/:id` → `deps.core.closeFact()` — a raw bitemporal
 * `UPDATE` with no `appendAuditEntry` call at all — so forgetting a fact
 * (the most common case) left no audit trail, contradicting the tool's
 * promise. The route also never declared the `?reason=` query param the SDK
 * has always sent (`client.forgetFact(id, signal, idempotencyKey, reason)`),
 * so `memory_forget`'s "Motivo opcional (queda en audit log)" was doubly
 * false for facts.
 *
 * This suite proves, against a REAL Postgres instance under a genuine
 * NOSUPERUSER `mnemo_app_role`:
 *
 *  1. `DELETE /facts/:id` now writes exactly one non-terminal audit entry
 *     (`action:'delete'`, `resource:'fact'`).
 *  2. The `?reason=` query param is recorded in the audit entry's detail.
 *  3. A second `DELETE` of the same (already-closed) fact 404s and writes NO
 *     second audit row — the append is downstream of `closeFact`'s
 *     `valid_to IS NULL` guard.
 *  4. Parity control: the generic route already audits a non-fact kind
 *     (`skill`) the same way, proving the asymmetry this fix closes was real.
 *  5. The fix runs cleanly under the real NOSUPERUSER role (SKILL-1
 *     regression guard — a reintroduced `FOR UPDATE` in `AuditRepository`
 *     would 500 this path too, not just skill's).
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
const APP_ROLE = "factaudit_app";
const APP_PASSWORD = "factaudit_app_pass";

const TENANT_ID = "tenant-factaudit-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000021";
const API_KEY = "mns_live_factauditcontracthasscope1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers };
}

async function createFactViaApi(content: string): Promise<string> {
  // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the sole
  // write path is now POST /remember, lossless-remapped {content} -> {statement}.
  const res = await app.request("/remember", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ statement: content, tags: [] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function createSkillViaApi(name: string): Promise<string> {
  const res = await app.request("/skills", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ name, promptTemplate: `Do the thing for ${name}` }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function factRow(
  id: string
): Promise<{ validTo: string | null; status: string } | undefined> {
  const rows = await admin<Array<{ valid_to: string | null; status: string }>>`
    SELECT valid_to::text, status FROM mnemosyne.mnemo_fact WHERE id = ${id} AND workspace_id = ${WS}
  `;
  const row = rows[0];
  return row ? { validTo: row.valid_to, status: row.status } : undefined;
}

async function auditLogRows(
  resourceId: string
): Promise<Array<{ action: string; resource: string; is_terminal: boolean; detail: unknown }>> {
  return admin<Array<{ action: string; resource: string; is_terminal: boolean; detail: unknown }>>`
    SELECT action, resource, is_terminal, metadata AS detail
    FROM mnemosyne.mnemo_audit_log
    WHERE workspace_id = ${WS} AND resource_id = ${resourceId}
    ORDER BY id ASC
  `;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
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
  // skills-forget.integration.test.ts / purge-facts-hard-delete.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Fact audit contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Fact audit contract workspace"}, ${"factaudit-contract"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_factaudit_contract"}, ${WS}, ${hash}, ${"factaudit-contract"}, ${"factaudit-contract"},
       ARRAY['memory:read','memory:write','memory:delete']::text[])
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
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "factaudit-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_forget kind:'fact' — DELETE /facts/:id writes an audit-log entry (FORGET-1)", () => {
  it("REGRESSION (was: no audit row at all): writes exactly one non-terminal audit entry (action:'delete', resource:'fact')", async () => {
    const id = await createFactViaApi("a fact that will be forgotten");
    const res = await app.request(
      `/facts/${id}?reason=${encodeURIComponent("superseded by a newer fact")}`,
      {
        method: "DELETE",
        headers: authed(),
      }
    );
    expect(res.status).toBe(204);

    const row = await factRow(id);
    expect(row?.validTo).not.toBeNull();
    expect(row?.status).toBe("forgotten");

    // flatten-legacy-dual-core: createFactViaApi now goes through
    // POST /remember (the deleted POST /facts's only replacement), whose
    // real v3 write pipeline appends its OWN "create" audit entry
    // (core/src/cognitive/remember.ts) — something the old plain-insert
    // POST /facts never did. Filtered to "delete" so this FORGET-1
    // regression guard still proves exactly what it always proved (does
    // DELETE /facts/:id write a delete audit row), without being coupled to
    // how many audit rows the fact's earlier creation happened to produce.
    const rows = (await auditLogRows(id)).filter((r) => r.action === "delete");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "delete", resource: "fact", is_terminal: false });
  });

  it("records the ?reason= query param in the audit entry's detail", async () => {
    const id = await createFactViaApi("a fact with a documented reason");
    const res = await app.request(
      `/facts/${id}?reason=${encodeURIComponent("no longer accurate")}`,
      {
        method: "DELETE",
        headers: authed(),
      }
    );
    expect(res.status).toBe(204);

    // See the "filtered to delete" comment above — POST /remember's own
    // create-time audit entry is expected here too.
    const rows = (await auditLogRows(id)).filter((r) => r.action === "delete");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ reason: "no longer accurate" });
  });

  it("a second DELETE of the same fact 404s and writes NO second audit row", async () => {
    const id = await createFactViaApi("a fact deleted twice");
    const first = await app.request(`/facts/${id}`, { method: "DELETE", headers: authed() });
    expect(first.status).toBe(204);

    const second = await app.request(`/facts/${id}`, { method: "DELETE", headers: authed() });
    expect(second.status).toBe(404);

    // See the "filtered to delete" comment above — POST /remember's own
    // create-time audit entry is expected here too; the assertion is that a
    // SECOND delete attempt doesn't add a second "delete" row.
    const rows = (await auditLogRows(id)).filter((r) => r.action === "delete");
    expect(rows).toHaveLength(1);
  });

  it("PARITY: the generic route already audits a non-fact kind (skill) the same way", async () => {
    const id = await createSkillViaApi("audited-skill-control-case");
    const res = await app.request(`/forget/skill/${id}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(200);

    const rows = await auditLogRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "delete", resource: "skill", is_terminal: false });
  });

  it("runs cleanly under the real NOSUPERUSER role — SKILL-1 regression guard for the fact path too", async () => {
    const id = await createFactViaApi("a fact proving no FOR UPDATE regression");
    const res = await app.request(`/facts/${id}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(204);
  });
});

describe("DELETE /facts/:id — enqueues a vector_delete outbox entry (OUTBOX-1)", () => {
  it("REGRESSION (was: no outbox entry at all): a real vector_delete row now exists for the forgotten fact", async () => {
    const id = await createFactViaApi(
      "a fact whose embedding must eventually leave the vector index"
    );
    const res = await app.request(`/facts/${id}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(204);

    const rows = await admin<Array<{ event_type: string; payload: { id: string; kind: string } }>>`
      SELECT event_type, payload FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS}::uuid AND event_type = ${"vector_delete"}
        AND payload->>'id' = ${id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ id, kind: "fact" });
  });
});
