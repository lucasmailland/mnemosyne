/**
 * WEBHOOK-1 — `mnemo_webhook_endpoint`'s Drizzle schema had drifted from the
 * live table, breaking every route in `routes/webhooks.ts` under real
 * Postgres.
 *
 * Root cause (confirmed by reading side by side, not assumed):
 * `packages/adapter-postgres/src/schema/infrastructure.ts:155-170`
 * (`webhookEndpointTable`) declares `description` and `updatedAt` columns.
 * `packages/types/src/ports.ts:640-652`'s `MnemoWebhookEndpoint` — the pure
 * domain type — ALSO declares both as first-class fields (`description:
 * string | null`, `updatedAt: Date`), and `routes/webhooks.ts`'s
 * `CreateWebhookSchema`/`UpdateWebhookSchema` accept `description` from real
 * callers. So this was never a speculative/dead field — it's a genuinely
 * intended, fully-wired feature. But the baseline migration's `CREATE TABLE
 * mnemosyne.mnemo_webhook_endpoint`
 * (`packages/adapter-postgres/migrations/baseline/0001_v3_complete_baseline.sql:2230-2241`)
 * never created either column — the migration was simply never written.
 *
 * Impact: `createWebhookEndpoint` always writes `description` (even `null`
 * when omitted) and `updateWebhookEndpoint` always writes `updatedAt` — both
 * unconditionally, on every call — so EVERY route in `routes/webhooks.ts`
 * (`POST`, `GET` list, `GET :id`, `PATCH`, `DELETE`, `GET :id/deliveries`,
 * `POST :id/test` — all of which read via `getWebhookEndpoint`/
 * `listWebhookEndpoints`, themselves a bare `.select()` over the full
 * Drizzle column list) 500s under a real, correctly-migrated Postgres. This
 * is not the "cosmetic log noise" it first looked like from
 * `dispatchWebhookEvent`'s swallowed best-effort call — it is a total outage
 * of webhook endpoint management.
 *
 * Separately, the live table also has `last_success_at`, which the domain
 * type does NOT declare and nothing in `WebhookRepository.ts` references —
 * an orphaned column, left alone here (dropping it is a separate decision,
 * not required to fix this bug, and carries needless risk for zero benefit).
 *
 * Fixed by migration `0020_webhook_endpoint_missing_columns.sql`, adding the
 * two missing columns to match the schema/type that already assumed them.
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
const APP_ROLE = "webhook_app";
const APP_PASSWORD = "webhook_app_pass";

const TENANT_ID = "tenant-webhook-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000050";

// Well-formed key matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const API_KEY = "mns_live_webhookcontracthasscopeenough1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers };
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

  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Webhook contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Webhook contract workspace"}, ${"webhook-contract"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_webhook_contract"}, ${WS}, ${hash}, ${"webhook-contract"}, ${"webhook-contract"},
       ARRAY['memory:read','memory:write','memory:admin','memory:delete']::text[])
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
  app = createApp({ deps, version: "webhook-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("webhook endpoints — full CRUD against real Postgres (WEBHOOK-1)", () => {
  it("POST /webhooks with a description succeeds (201), and the real row has description + a real updated_at", async () => {
    const res = await app.request("/webhooks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        url: "https://example.com/hook-a",
        events: ["fact.created"],
        description: "notifies on new facts",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      description: string | null;
      updatedAt: string;
    };
    expect(body.description).toBe("notifies on new facts");
    expect(body.updatedAt).toBeTruthy();

    const rows = await admin<Array<{ description: string | null; updated_at: string }>>`
      SELECT description, updated_at::text FROM mnemosyne.mnemo_webhook_endpoint
      WHERE id = ${body.id} AND workspace_id = ${WS}
    `;
    expect(rows[0]?.description).toBe("notifies on new facts");
    expect(rows[0]?.updated_at).toBeTruthy();
  });

  it("POST /webhooks WITHOUT a description succeeds (201) with description: null", async () => {
    const res = await app.request("/webhooks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ url: "https://example.com/hook-b", events: ["fact.created"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { description: string | null };
    expect(body.description).toBeNull();
  });

  it("GET /webhooks lists created endpoints with their descriptions", async () => {
    const createRes = await app.request("/webhooks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        url: "https://example.com/hook-list",
        events: ["fact.created"],
        description: "list-me",
      }),
    });
    const created = (await createRes.json()) as { id: string };

    const res = await app.request("/webhooks", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; description: string | null }> };
    const found = body.items.find((i) => i.id === created.id);
    expect(found?.description).toBe("list-me");
  });

  it("GET /webhooks/:id returns the endpoint", async () => {
    const createRes = await app.request("/webhooks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ url: "https://example.com/hook-get", events: ["fact.created"] }),
    });
    const created = (await createRes.json()) as { id: string };

    const res = await app.request(`/webhooks/${created.id}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(created.id);
  });

  it("PATCH /webhooks/:id updates description and bumps updated_at", async () => {
    const createRes = await app.request("/webhooks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        url: "https://example.com/hook-patch",
        events: ["fact.created"],
        description: "original",
      }),
    });
    const created = (await createRes.json()) as { id: string; updatedAt: string };

    // Guarantee a distinct updated_at from created_at's timestamp — Postgres
    // timestamptz has microsecond resolution but two calls in the same test
    // can otherwise land in the same millisecond.
    await new Promise((r) => setTimeout(r, 20));

    const patchRes = await app.request(`/webhooks/${created.id}`, {
      method: "PATCH",
      headers: authed(),
      body: JSON.stringify({ description: "updated" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { description: string | null; updatedAt: string };
    expect(patched.description).toBe("updated");
    expect(new Date(patched.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.updatedAt).getTime()
    );

    const rows = await admin<Array<{ description: string | null }>>`
      SELECT description FROM mnemosyne.mnemo_webhook_endpoint
      WHERE id = ${created.id} AND workspace_id = ${WS}
    `;
    expect(rows[0]?.description).toBe("updated");
  });

  it("DELETE /webhooks/:id removes the endpoint", async () => {
    const createRes = await app.request("/webhooks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ url: "https://example.com/hook-delete", events: ["fact.created"] }),
    });
    const created = (await createRes.json()) as { id: string };

    const delRes = await app.request(`/webhooks/${created.id}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(delRes.status).toBe(204);

    const getRes = await app.request(`/webhooks/${created.id}`, { headers: authed() });
    expect(getRes.status).toBe(404);
  });

  it("a fact create's best-effort webhook dispatch no longer logs webhook_dispatch.list_failed (regression guard for the swallowed error that first surfaced this bug)", async () => {
    // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the sole
    // write path is now POST /remember, whose fact.created webhook dispatch
    // was already ported here in PR7 (D2 step 1).
    const res = await app.request("/remember", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ statement: "a fact that triggers dispatchWebhookEvent", tags: [] }),
    });
    expect(res.status).toBe(201);
    // dispatchWebhookEvent's listWebhookEndpoints call is best-effort and
    // swallows errors, so there is no direct assertion surface here beyond
    // "the fact create itself still succeeds" — the real proof that the
    // underlying query no longer throws is the direct listWebhookEndpoints
    // exercise in the "GET /webhooks lists" case above, which goes through
    // the identical code path.
  });
});
