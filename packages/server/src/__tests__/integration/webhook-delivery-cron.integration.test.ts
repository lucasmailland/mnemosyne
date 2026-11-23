/**
 * WEBHOOK-2 — real-Postgres coverage for the delivery-worker cron's
 * cross-workspace poll (`listPendingWebhookDeliveries`).
 *
 * Finding: `packages/server/src/cron/webhookDelivery.ts`'s
 * `runWebhookDeliveryBatch` polls pending deliveries across ALL workspaces
 * in one batch — there is no single `workspaceId` to scope that query to,
 * by design. Under a real NOSUPERUSER FORCE-RLS role, a direct query against
 * `mnemo_webhook_delivery` threw `unrecognized configuration parameter
 * "mnemosyne.workspace_id"` (its RLS policy has no `missing_ok` flag) on
 * every poll cycle — the cron had likely never successfully delivered a
 * single webhook against a real, correctly-secured deployment.
 *
 * Fixed by `mnemosyne.mnemo_claim_pending_webhook_deliveries()` (migration
 * 0021), a SECURITY DEFINER function mirroring `mnemo_refresh_anticipation()`'s
 * established pattern — bypasses RLS for this one narrowly-scoped read,
 * while every other access path to the table keeps real per-workspace
 * isolation (proven by WEBHOOK-1's fixes already covered in
 * webhook-endpoint-schema.integration.test.ts).
 *
 * This suite proves: (1) the direct repository call no longer throws and
 * returns rows across workspaces; (2) the full cron
 * (`runWebhookDeliveryBatch`) runs end-to-end against real Postgres and
 * resolves each delivery correctly scoped to its OWN workspace, with no
 * cross-workspace leakage in the per-delivery follow-up calls.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { runWebhookDeliveryBatch } from "../../cron/webhookDelivery.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_ROLE = "webhook_cron_app";
const APP_PASSWORD = "webhook_cron_app_pass";

const TENANT_ID = "tenant-webhook-cron-contract";
const WS_A = "9b1f9c00-0000-4000-8000-000000000060";
const WS_B = "9b1f9c00-0000-4000-8000-000000000061";

// Well-formed keys matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const API_KEY_A = "mns_live_webhookcronworkspaceahasscope1";
const API_KEY_B = "mns_live_webhookcronworkspacebhasscope1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let v3Storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;

function authedFor(apiKey: string, headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...headers };
}

async function createWebhookViaApi(apiKey: string, url: string): Promise<{ id: string }> {
  const res = await app.request("/webhooks", {
    method: "POST",
    headers: authedFor(apiKey),
    body: JSON.stringify({ url, events: ["test.event"] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function seedPendingDelivery(
  id: string,
  webhookId: string,
  workspaceId: string
): Promise<void> {
  await admin`
    INSERT INTO mnemosyne.mnemo_webhook_delivery
      (id, webhook_id, workspace_id, event_type, payload, status, attempt)
    VALUES
      (${id}, ${webhookId}, ${workspaceId}, ${"test.event"}, ${{ hello: "world" }}, ${"pending"}, ${1})
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

  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Webhook cron contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_A}, ${"Webhook cron workspace A"}, ${"webhook-cron-a"}, ${TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_B}, ${"Webhook cron workspace B"}, ${"webhook-cron-b"}, ${TENANT_ID})
  `;

  const hashA = await bcrypt.hash(API_KEY_A, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_webhook_cron_a"}, ${WS_A}, ${hashA}, ${"webhook-cron-a"}, ${"webhook-cron-a"},
       ARRAY['memory:read','memory:write','memory:admin']::text[]) -- webhook writes need admin (APP-005)
  `;
  const hashB = await bcrypt.hash(API_KEY_B, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_webhook_cron_b"}, ${WS_B}, ${hashB}, ${"webhook-cron-b"}, ${"webhook-cron-b"},
       ARRAY['memory:read','memory:write','memory:admin']::text[])
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
  app = createApp({ deps, version: "webhook-cron-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listPendingWebhookDeliveries — real Postgres, cross-workspace claim (WEBHOOK-2)", () => {
  it("does NOT throw 'unrecognized configuration parameter', and returns pending deliveries from BOTH workspaces in one call", async () => {
    const whA = await createWebhookViaApi(API_KEY_A, "https://example.com/cron-a");
    const whB = await createWebhookViaApi(API_KEY_B, "https://example.com/cron-b");
    await seedPendingDelivery("del-claim-a", whA.id, WS_A);
    await seedPendingDelivery("del-claim-b", whB.id, WS_B);

    const rows = await v3Storage.listPendingWebhookDeliveries(50);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("del-claim-a");
    expect(ids).toContain("del-claim-b");

    const rowA = rows.find((r) => r.id === "del-claim-a");
    const rowB = rows.find((r) => r.id === "del-claim-b");
    expect(rowA?.workspaceId).toBe(WS_A);
    expect(rowB?.workspaceId).toBe(WS_B);
  });
});

describe("runWebhookDeliveryBatch — full cron, real Postgres, no cross-workspace leakage (WEBHOOK-2)", () => {
  it("delivers pending deliveries from two different workspaces, each resolved against its OWN endpoint", async () => {
    const whA = await createWebhookViaApi(API_KEY_A, "https://example.com/cron-full-a");
    const whB = await createWebhookViaApi(API_KEY_B, "https://example.com/cron-full-b");
    await seedPendingDelivery("del-full-a", whA.id, WS_A);
    await seedPendingDelivery("del-full-b", whB.id, WS_B);

    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calledUrls.push(url);
      return { ok: true, status: 200, text: async () => "ok" } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const telemetry = {
      counter: () => {},
      histogram: () => {},
      startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
      gauge: () => {},
      shutdown: async () => {},
    };

    const result = await runWebhookDeliveryBatch({
      storage: v3Storage,
      logger,
      telemetry,
    } as unknown as Parameters<typeof runWebhookDeliveryBatch>[0]);

    expect(result.delivered).toBeGreaterThanOrEqual(2);
    expect(calledUrls).toContain("https://example.com/cron-full-a");
    expect(calledUrls).toContain("https://example.com/cron-full-b");

    // Confirm each delivery resolved to "delivered" scoped correctly to its
    // OWN workspace — the per-delivery follow-up calls (getWebhookEndpoint,
    // updateWebhookDelivery) are already workspace-scoped/GUC-fixed by
    // WEBHOOK-1; this proves the cross-workspace claim feeds them correctly.
    const deliveriesA = await v3Storage.listWebhookDeliveries(whA.id, WS_A, 10);
    const deliveriesB = await v3Storage.listWebhookDeliveries(whB.id, WS_B, 10);
    expect(deliveriesA.find((d) => d.id === "del-full-a")?.status).toBe("delivered");
    expect(deliveriesB.find((d) => d.id === "del-full-b")?.status).toBe("delivered");
  });
});
