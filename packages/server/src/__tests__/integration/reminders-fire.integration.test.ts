/**
 * REMIND-1 — real-Postgres proof that `memory_remind_when` reminders
 * genuinely fire.
 *
 * `memory_remind_when`'s description promises "el runtime evalúa ambos
 * [triggerAt y condition] en cada ciclo de recall." Before this fix, that
 * was false: no recall path ever called `evaluatePendingReminders`, and the
 * 30s background poller passed a placeholder queryText that could never
 * satisfy any semantic condition. This suite proves, against a REAL
 * Postgres instance under a genuine NOSUPERUSER `mnemo_app_role`:
 *
 *  1. A semantic-only reminder fires on a recall whose query genuinely
 *     satisfies its condition (vector cosine, via a real embed round-trip
 *     through a deterministic fake LLM provider), is returned inline in the
 *     recall response, and its row transitions to status='triggered'.
 *  2. The same reminder does NOT fire on an unrelated recall query — the row
 *     stays 'pending'.
 *  3. A time-only reminder (condition omitted at creation — migration 0018
 *     made the column nullable) is accepted, persists NULL, and fires on
 *     ANY recall call once its triggerAt has passed.
 *  4. A compound (time+condition) reminder does NOT fire on time alone with
 *     an unrelated query (the AND rule holds end-to-end against a real DB),
 *     but DOES fire once both conditions are satisfied by a real recall call.
 *  5. POST /reminders with neither condition nor triggerAt is rejected (400).
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
const APP_ROLE = "reminders_app";
const APP_PASSWORD = "reminders_app_pass";

const TENANT_ID = "tenant-reminders-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000020";
const API_KEY = "mns_live_reminderscontracthasscope1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
/** The RLS-subject storage, so a test can run exactly what the 30 s poller runs. */
let pollerStorage: import("@mnemo-ai/types").StorageAdapter;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers };
}

/** Deterministic fake embedding: "Acme"-mentioning text -> [1,0,0,0], everything else -> [0,1,0,0]. */
function fakeVector(text: string): number[] {
  return /acme/i.test(text) ? [1, 0, 0, 0] : [0, 1, 0, 0];
}

async function createReminderViaApi(body: {
  content: string;
  condition?: string;
  triggerAt?: string;
}): Promise<{ status: number; body: { id?: string; condition?: string | null } }> {
  const res = await app.request("/reminders", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as { id?: string; condition?: string | null },
  };
}

async function recallViaApi(query: string): Promise<{
  status: number;
  body: { reminders?: Array<{ id: string; triggeredBy: string }> };
}> {
  const res = await app.request("/recall", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ query }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { reminders?: Array<{ id: string; triggeredBy: string }> },
  };
}

async function reminderRow(
  id: string
): Promise<{ status: string; condition: string | null } | undefined> {
  const rows = await admin<Array<{ status: string; condition: string | null }>>`
    SELECT status, condition FROM mnemosyne.mnemo_reminder WHERE id = ${id} AND workspace_id = ${WS}
  `;
  return rows[0];
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

  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Reminders contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Reminders contract workspace"}, ${"reminders-contract"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_reminders_contract"}, ${WS}, ${hash}, ${"reminders-contract"}, ${"reminders-contract"},
       ARRAY['memory:read','memory:write']::text[])
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
  pollerStorage = v3Storage as unknown as import("@mnemo-ai/types").StorageAdapter;
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
    // REMIND-1: a deterministic fake LLM provider so both reminder-creation
    // (routes/reminders.ts computes conditionEmbedding) and recall-time
    // evaluation (recall/reminders.ts's lazy embedQuery) get real, real
    // Postgres-round-tripped vectors — not the "no embedder configured"
    // FTS-fallback path, which this suite covers separately at the unit
    // level (recall-reminders.test.ts).
    llm: { embed: async (text: string) => fakeVector(text) },
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "reminders-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_remind_when — semantic-only reminder fires on a real matching recall", () => {
  it("REGRESSION (was: never fires): fires on a recall whose query satisfies the condition, and is returned inline", async () => {
    const created = await createReminderViaApi({
      content: "Follow up on the Acme contract",
      condition: "when user mentions Acme",
    });
    expect(created.status).toBe(201);
    const id = created.body.id!;
    expect((await reminderRow(id))?.status).toBe("pending");

    const recall = await recallViaApi("give me the Acme roadmap");
    expect(recall.status).toBe(200);
    expect(recall.body.reminders).toHaveLength(1);
    expect(recall.body.reminders?.[0]?.id).toBe(id);
    expect(recall.body.reminders?.[0]?.triggeredBy).toBe("semantic");

    expect((await reminderRow(id))?.status).toBe("triggered");
  });

  it("does NOT fire on an unrelated recall query — the row stays pending", async () => {
    const created = await createReminderViaApi({
      content: "Follow up on the Acme contract",
      condition: "when user mentions Acme",
    });
    const id = created.body.id!;

    const recall = await recallViaApi("what is the weather tomorrow");
    expect(recall.status).toBe(200);
    expect(recall.body.reminders).toBeUndefined();
    expect((await reminderRow(id))?.status).toBe("pending");
  });
});

describe("memory_remind_when — time-only reminder (migration 0018)", () => {
  it("is accepted with condition omitted, persists NULL, and fires on ANY recall once triggerAt has passed", async () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // determinism-ok: relative seed timestamp, not an assertion value
    const created = await createReminderViaApi({
      content: "Ping the on-call rotation",
      triggerAt: past,
    });
    expect(created.status).toBe(201);
    const id = created.body.id!;
    expect(created.body.condition).toBeNull();
    expect((await reminderRow(id))?.condition).toBeNull();

    const recall = await recallViaApi("completely unrelated query text");
    expect(recall.status).toBe(200);
    expect(recall.body.reminders?.map((r) => r.id)).toContain(id);
    expect(recall.body.reminders?.find((r) => r.id === id)?.triggeredBy).toBe("time");
    expect((await reminderRow(id))?.status).toBe("triggered");
  });
});

describe("memory_remind_when — compound (time+condition) reminder AND rule, end-to-end", () => {
  it("does NOT fire on time alone with an unrelated query, but DOES fire once both conditions are met", async () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // determinism-ok: relative seed timestamp, not an assertion value
    const created = await createReminderViaApi({
      content: "Review the Acme renewal",
      condition: "when user mentions Acme",
      triggerAt: past,
    });
    const id = created.body.id!;

    const unrelated = await recallViaApi("what is the weather tomorrow");
    expect(unrelated.body.reminders).toBeUndefined();
    expect((await reminderRow(id))?.status).toBe("pending");

    const matching = await recallViaApi("Acme contract renewal terms");
    expect(matching.body.reminders?.map((r) => r.id)).toContain(id);
    expect(matching.body.reminders?.find((r) => r.id === id)?.triggeredBy).toBe("both");
    expect((await reminderRow(id))?.status).toBe("triggered");
  });
});

describe("memory_remind_when — POST /reminders validation", () => {
  it("rejects a reminder with neither condition nor triggerAt (400)", async () => {
    const res = await app.request("/reminders", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ content: "no trigger at all" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("LIFECYCLE-6 — a reminder the poller fired reaches the next recall", () => {
  it("is returned by the first recall after the poller, once, under RLS", async () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // determinism-ok: relative seed timestamp, not an assertion value
    const created = await createReminderViaApi({
      content: "Poller-only reminder: check the orders-api error budget",
      triggerAt: past,
    });
    const id = created.body.id!;

    // Exactly what the background poller does: a time-only sweep, no query.
    const { evaluatePendingReminders } = await import("@mnemo-ai/core");
    const polled = await evaluatePendingReminders({
      storage: pollerStorage,
      workspaceId: WS,
      queryText: "",
    });
    expect(polled.map((r) => r.id)).toContain(id);
    expect((await reminderRow(id))?.status).toBe("triggered");

    const first = await recallViaApi("an unrelated query about something else");
    expect(first.body.reminders?.map((r) => r.id)).toContain(id);
    expect(first.body.reminders?.find((r) => r.id === id)?.triggeredBy).toBe("time");

    const second = await recallViaApi("an unrelated query about something else");
    expect(second.body.reminders?.map((r) => r.id) ?? []).not.toContain(id);

    const [row] = await admin<Array<{ delivered_at: Date | null }>>`
      SELECT delivered_at FROM mnemosyne.mnemo_reminder WHERE id = ${id}`;
    expect(row?.delivered_at).not.toBeNull();
  });
});

describe("Review round — reminder delivery is once-only under concurrent recalls", () => {
  it("parallel recalls never return the same reminder twice", async () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // determinism-ok: relative seed timestamp, not an assertion value
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const created = await createReminderViaApi({
        content: `Concurrent delivery reminder ${i}`,
        triggerAt: past,
      });
      ids.push(created.body.id!);
    }
    // Half fired by the poller, half left pending for the recalls to fire.
    const { evaluatePendingReminders } = await import("@mnemo-ai/core");
    await admin`
      UPDATE mnemosyne.mnemo_reminder SET trigger_at = now() + interval '1 hour'
      WHERE id = ANY(${ids.slice(3)})`;
    await evaluatePendingReminders({ storage: pollerStorage, workspaceId: WS, queryText: "" });
    await admin`
      UPDATE mnemosyne.mnemo_reminder SET trigger_at = now() - interval '1 minute'
      WHERE id = ANY(${ids.slice(3)})`;

    const responses = await Promise.all(
      [1, 2, 3, 4].map(() => recallViaApi("an unrelated query about something else"))
    );
    const delivered = responses
      .flatMap((r) => r.body.reminders ?? [])
      .map((r) => r.id)
      .filter((id) => ids.includes(id));

    expect(new Set(delivered).size).toBe(delivered.length);
    expect([...delivered].sort()).toEqual([...ids].sort());
  });
});
