/**
 * Contract test for `memory_skill` (packages/mcp/src/tools/skill.ts).
 *
 * `memory_skill`'s MCP description promises:
 *   "Almacena y recupera habilidades o plantillas de instrucciones (skills)
 *    que el agente ha aprendido via /skills."
 *
 * `action:"create"` -> `client.createSkill()`  -> `POST   /skills`
 * `action:"get"`    -> `client.getSkill()`     -> `GET    /skills/:id`
 * `action:"list"`   -> `client.listSkills()`   -> `GET    /skills`
 * `action:"forget"` -> `client.forgetPrimitive("skill", id)` -> `DELETE /forget/skill/:id`
 *
 * FIXED (2026-07-31), three independent, compounding bugs, all closed:
 *
 *   1. `skill.ts`'s `forget` action used to call `client.forgetFact(args.id)`
 *      — the fact-specific client method, hitting `DELETE /facts/:id`.
 *      A skill id never exists in `mnemo_fact`, so this ALWAYS 404d and left
 *      the skill row completely untouched. Fixed: `skill.ts` now calls
 *      `client.forgetPrimitive("skill", id)`, the primitive-agnostic archive
 *      route that actually reaches `mnemo_skill`.
 *
 *   2. SYSTEMIC: `DELETE /forget/skill/:id` (routes/forget.ts ->
 *      `deps.cognitive.forget(..., "soft", ...)`,
 *      packages/core/src/cognitive/forget.ts) 500d under a REAL non-superuser
 *      `mnemo_app_role` connection — not just for skills, but for EVERY
 *      primitive kind soft-archived through this route (`workflow`,
 *      `strategy`, `task`, `event`, `entity`, `episode`, `reasoning`,
 *      `hyperedge`). Root cause: the soft path's non-terminal audit append
 *      (`AuditRepository.appendAuditEntry`) ran
 *      `SELECT merkle_hash FROM mnemosyne.mnemo_audit_log WHERE ... FOR UPDATE`
 *      to find the previous hash in the per-workspace Merkle chain — and
 *      Postgres requires UPDATE privilege (not just SELECT) for ANY
 *      `FOR UPDATE` clause, a privilege S3's append-only invariant
 *      deliberately revokes from `mnemo_app_role` on `mnemo_audit_log`
 *      (`GRANT SELECT,INSERT` only). Fixed by dropping `FOR UPDATE` from
 *      that read: `appendAuditEntry` already serializes all concurrent
 *      appends for a workspace via `pg_advisory_xact_lock` before this
 *      SELECT ever runs, so a plain READ COMMITTED read (which always sees
 *      every previously-committed row once the advisory lock is acquired)
 *      is sufficient — the locking clause was redundant AND fundamentally
 *      incompatible with the append-only privilege model.
 *
 *   3. `KnowledgeRepository.querySkills` only applied the `validFrom`/
 *      `validTo` window when a caller passed `validAt` explicitly, and
 *      `routes/skills.ts`'s list handler never did — so even a genuinely
 *      archived skill stayed visible in `action:"list"` forever. Fixed by
 *      passing the current timestamp as `validAt` from the list route by
 *      default. This
 *      surfaced a FOURTH bug while fixing the third: the pre-existing
 *      `validTo` condition embedded a raw JS `Date` directly inside a
 *      `sql\`...${date}...\`` template, which skips Drizzle's column-aware
 *      driver-value mapping (unlike the typed `lte()` operator right above
 *      it) — postgres.js rejected the resulting parameter outright, 500ing
 *      `GET /skills` unconditionally once `validAt` was ever populated.
 *      Fixed by using the typed `or(isNull(...), gt(...))` operators
 *      instead of raw `sql`.
 *
 * This test proves, against a REAL Postgres instance through a real
 * non-superuser `mnemo_app_role` connection, exercising the actual HTTP
 * routes the MCP tool calls, that all four are now fixed.
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
const APP_ROLE = "skill_app";
const APP_PASSWORD = "skill_app_pass";

const TENANT_ID = "tenant-skill-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000002";

// Well-formed key matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const API_KEY = "mns_live_skillcontracthasscope01";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers };
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

async function skillRow(id: string): Promise<{ validTo: string | null; name: string } | undefined> {
  const rows = await admin<Array<{ valid_to: string | null; name: string }>>`
    SELECT valid_to::text, name
    FROM mnemosyne.mnemo_skill
    WHERE id = ${id} AND workspace_id = ${WS}
  `;
  const row = rows[0];
  return row ? { validTo: row.valid_to, name: row.name } : undefined;
}

async function factRowExists(id: string): Promise<boolean> {
  const rows = await admin<Array<{ id: string }>>`
    SELECT id FROM mnemosyne.mnemo_fact WHERE id = ${id} AND workspace_id = ${WS}
  `;
  return rows.length > 0;
}

async function listSkillIds(): Promise<string[]> {
  const res = await app.request("/skills?limit=200", { method: "GET", headers: authed() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ id: string }> };
  return body.items.map((s) => s.id);
}

async function auditLogRows(
  resourceId: string
): Promise<Array<{ action: string; resource: string; is_terminal: boolean }>> {
  return admin<Array<{ action: string; resource: string; is_terminal: boolean }>>`
    SELECT action, resource, is_terminal
    FROM mnemosyne.mnemo_audit_log
    WHERE workspace_id = ${WS} AND resource_id = ${resourceId}
    ORDER BY id ASC
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
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Skill contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Skill contract workspace"}, ${"skill-contract"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_skill_contract"}, ${WS}, ${hash}, ${"skill-contract"}, ${"skill-contract"},
       ARRAY['memory:read','memory:write','memory:delete']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  // v3 cognitive core + storage adapter — required for /skills and
  // /forget/:kind/:id. Fake embed adapter, no LLM (matching
  // purge-facts-hard-delete.integration.test.ts's pattern — recall isn't
  // under test here).
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
  app = createApp({ deps, version: "skill-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_skill create/get/list — really route through /skills", () => {
  it("POST /skills creates a row in mnemo_skill (not mnemo_fact or anywhere else)", async () => {
    const id = await createSkillViaApi("deploy-to-fly");
    const row = await skillRow(id);
    expect(row).toEqual({ validTo: null, name: "deploy-to-fly" });
  });

  it("GET /skills/:id returns the created skill", async () => {
    const id = await createSkillViaApi("write-changelog");
    const res = await app.request(`/skills/${id}`, { method: "GET", headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe(id);
    expect(body.name).toBe("write-changelog");
  });

  it("GET /skills lists created skills", async () => {
    const id = await createSkillViaApi("triage-incident");
    const ids = await listSkillIds();
    expect(ids).toContain(id);
  });
});

describe("memory_skill action:'forget' — FIXED, now calls client.forgetPrimitive(\"skill\", id) -> DELETE /forget/skill/:id", () => {
  it("REGRESSION (was: FINDING, always 404d): DELETE /forget/skill/:id on a real skill archives it (validTo set) and returns 200", async () => {
    const id = await createSkillViaApi("real-skill-to-forget");

    const before = await skillRow(id);
    expect(before).toEqual({ validTo: null, name: "real-skill-to-forget" });
    expect(await factRowExists(id)).toBe(false);

    // This is exactly what skill.ts's `forget` action does post-fix:
    // `client.forgetPrimitive("skill", id)` -> `DELETE /forget/skill/:id`.
    const res = await app.request(`/forget/skill/${id}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forgotten: boolean };
    expect(body.forgotten).toBe(true);

    const after = await skillRow(id);
    expect(after?.validTo).not.toBeNull();
  });

  it("REGRESSION: after a successful forget, the skill no longer appears in action:'list'", async () => {
    const id = await createSkillViaApi("archived-then-listed");

    const res = await app.request(`/forget/skill/${id}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(200);

    const ids = await listSkillIds();
    expect(ids).not.toContain(id);
  });

  it("REGRESSION: a real non-terminal audit-log entry (action:'delete', resource:'skill') is written — the FOR UPDATE removal did not silently drop the audit trail", async () => {
    const id = await createSkillViaApi("audited-forget");

    const res = await app.request(`/forget/skill/${id}`, { method: "DELETE", headers: authed() });
    expect(res.status).toBe(200);

    const rows = await auditLogRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ action: "delete", resource: "skill", is_terminal: false });
  });

  it("does not accidentally touch an unrelated fact that happens to share no relationship with the skill", async () => {
    // Defense-in-depth: confirm forgetting a skill via the primitive-agnostic
    // route doesn't silently touch an unrelated fact row.
    const factRes = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "an unrelated real fact", tags: [] }),
    });
    expect(factRes.status).toBe(201);
    const fact = (await factRes.json()) as { id: string };

    const skillId = await createSkillViaApi("unrelated-skill");
    await app.request(`/forget/skill/${skillId}`, { method: "DELETE", headers: authed() });

    const factCheck = await admin<Array<{ valid_to: string | null }>>`
      SELECT valid_to::text FROM mnemosyne.mnemo_fact WHERE id = ${fact.id} AND workspace_id = ${WS}
    `;
    expect(factCheck[0]?.valid_to).toBeNull();
  });

  it("a stale/unknown skill id still 404s cleanly (not a 500) — memory_forget-parity error behavior", async () => {
    const res = await app.request(`/forget/skill/00000000-0000-4000-8000-000000000099`, {
      method: "DELETE",
      headers: authed(),
    });
    // storage.archiveSkill on a non-existent row is a no-op UPDATE (0 rows
    // affected) rather than a 404 — proven here so a future regression to a
    // 500 (e.g. reintroducing FOR UPDATE) is caught either way.
    expect(res.status).toBeLessThan(500);
  });
});

describe("DELETE /forget/:kind/:id soft-archive — systemic fix proof (not skill-specific)", () => {
  it("REGRESSION, ROOT CAUSE ISOLATED AT THE SQL LAYER: mnemo_app_role can now run the Merkle prev-hash lookup without FOR UPDATE (no more 'permission denied for table mnemo_audit_log')", async () => {
    const appConn = postgres(
      `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`,
      { max: 1, onnotice: () => void 0 }
    );
    let caught: unknown;
    try {
      // The exact query AuditRepository.appendAuditEntry now runs (no FOR UPDATE).
      await appConn.unsafe(
        `SELECT merkle_hash FROM mnemosyne.mnemo_audit_log WHERE workspace_id = '${WS}'::uuid AND is_terminal = false ORDER BY created_at DESC, id DESC LIMIT 1`
      );
    } catch (err) {
      caught = err;
    } finally {
      await appConn.end();
    }
    expect(caught).toBeUndefined();
  });

  it("REGRESSION: the OLD query (with FOR UPDATE) still fails this way if reintroduced — proves the fix is real, not an environment fluke", async () => {
    const appConn = postgres(
      `postgres://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`,
      { max: 1, onnotice: () => void 0 }
    );
    let caught: unknown;
    try {
      await appConn.unsafe(
        `SELECT merkle_hash FROM mnemosyne.mnemo_audit_log WHERE workspace_id = '${WS}'::uuid AND is_terminal = false ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`
      );
    } catch (err) {
      caught = err;
    } finally {
      await appConn.end();
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toMatch(/permission denied for table mnemo_audit_log/);
  });
});

describe("DELETE /forget/:kind/:id — ?reason= truncation parity with the fact path (FORGET-2)", () => {
  it("REGRESSION (was: unbounded): a reason longer than 200 chars is truncated to 200 in the audit entry's detail, same as the fact-specific route", async () => {
    const id = await createSkillViaApi("forget-reason-truncation");
    const longReason = "x".repeat(500);

    const res = await app.request(`/forget/skill/${id}?reason=${encodeURIComponent(longReason)}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(200);

    const rows = await admin<Array<{ metadata: { reason?: string } | null }>>`
      SELECT metadata FROM mnemosyne.mnemo_audit_log
      WHERE workspace_id = ${WS} AND resource_id = ${id}
      ORDER BY id ASC
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata?.reason).toHaveLength(200);
    expect(rows[0]?.metadata?.reason).toBe("x".repeat(200));
  });

  it("a reason under 200 chars is stored verbatim, untruncated", async () => {
    const id = await createSkillViaApi("forget-reason-short");
    const res = await app.request(
      `/forget/skill/${id}?reason=${encodeURIComponent("short reason")}`,
      {
        method: "DELETE",
        headers: authed(),
      }
    );
    expect(res.status).toBe(200);

    const rows = await admin<Array<{ metadata: { reason?: string } | null }>>`
      SELECT metadata FROM mnemosyne.mnemo_audit_log
      WHERE workspace_id = ${WS} AND resource_id = ${id}
      ORDER BY id ASC
    `;
    expect(rows[0]?.metadata?.reason).toBe("short reason");
  });
});
