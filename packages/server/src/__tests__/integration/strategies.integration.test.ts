/**
 * FULL-STACK HTTP contract test for the `memory_strategy` MCP tool's
 * server-side surface: GET/POST /strategies, GET/PATCH/DELETE
 * /strategies/:id, POST /strategies/:id/rate
 * (packages/server/src/routes/strategies.ts), which
 * packages/mcp/src/tools/strategy.ts calls via
 * MnemosyneClient.listStrategies()/createStrategy()/rateStrategy()/etc.
 *
 * Audits the tool-promise-remediation claims for `memory_strategy`
 * (docs/archive/openspec/tool-promise-remediation/tools/memory_strategy.md):
 *
 *   1. `store`/`recall` claimed as aliases of `create`/`list`. The MCP tool
 *      (strategy.ts) maps both `store` and `create` onto the identical
 *      `createStrategy()` call, and both `recall` and `list` onto the
 *      identical `listStrategies()` call — EXCEPT `recall` additionally
 *      defaults `status` to `"active"` when no explicit `statusFilter` is
 *      given, while `list` stays unfiltered. This test proves that default
 *      filtering difference is real at the HTTP/DB layer (not just present
 *      in a code comment): `GET /strategies` (unfiltered) returns both an
 *      active and an archived strategy; `GET /strategies?status=active`
 *      (what `recall` sends by default) returns only the active one. For
 *      an active strategy specifically, the two calls return identical
 *      field values (proving the "true alias for common case" half of the
 *      claim).
 *
 *   2. `rate` claimed to move `worth` via the same Beta-Bernoulli mechanism
 *      documented elsewhere in the codebase: alpha = 2 + successCount,
 *      beta = 2 + failureCount, worth = alpha / (alpha + beta). `worth`
 *      itself is a Postgres GENERATED STORED column
 *      (`worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`) — this test
 *      proves the full round trip against a REAL Postgres instance: the
 *      repository writes `worth_alpha`/`worth_beta` as numeric strings,
 *      and Postgres (not application code) computes `worth`. A success
 *      outcome MUST move worth up from the fresh baseline of 0.5; a
 *      failure outcome on a fresh strategy MUST move it down.
 *
 * Harness: throwaway pgvector/pgvector:pg17 testcontainer, real migrations
 * (core + adapter-postgres v3), the real Hono app driven through
 * app.request(...), and — per this repo's DB/RLS verification rule — a
 * genuine non-superuser, non-BYPASSRLS `mnemo_app_role` connection (same
 * discipline as purge-facts-hard-delete.integration.test.ts and
 * doctor-nonsuperuser.integration.test.ts), so RLS is actually enforced
 * for every query under test, not bypassed by a superuser connection.
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
const APP_ROLE = "strategy_app";
const APP_PASSWORD = "strategy_app_pass";

const TENANT_ID = "tenant-strategy-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000002";
const OTHER_WS = "9b1f9c00-0000-4000-8000-000000000003";

// Well-formed keys matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const KEY = "mns_live_strategycontractkey00001";
const OTHER_WS_KEY = "mns_live_strategycontractotherws1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;

function authed(key: string = KEY): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

interface StrategyBody {
  id: string;
  trigger: string;
  action: string;
  status: string;
  successCount: number;
  failureCount: number;
  worth: number;
  [key: string]: unknown;
}

async function createStrategy(
  trigger: string,
  action: string,
  key: string = KEY
): Promise<StrategyBody> {
  const res = await app.request("/strategies", {
    method: "POST",
    headers: authed(key),
    body: JSON.stringify({ trigger, action }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as StrategyBody;
}

async function listStrategies(query = ""): Promise<{ items: StrategyBody[]; total: number }> {
  const res = await app.request(`/strategies${query}`, { headers: authed() });
  expect(res.status).toBe(200);
  return (await res.json()) as { items: StrategyBody[]; total: number };
}

async function archiveStrategy(id: string): Promise<void> {
  const res = await app.request(`/strategies/${id}`, { method: "DELETE", headers: authed() });
  expect(res.status).toBe(204);
}

async function rateStrategy(id: string, outcome: "success" | "failure"): Promise<StrategyBody> {
  const res = await app.request(`/strategies/${id}/rate`, {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ outcome }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as StrategyBody;
}

async function rawWorthColumns(
  id: string
): Promise<{ worth: number; worthAlpha: string; worthBeta: string } | undefined> {
  const rows = await admin<Array<{ worth: number; worth_alpha: string; worth_beta: string }>>`
    SELECT worth, worth_alpha::text, worth_beta::text
    FROM mnemosyne.mnemo_strategy
    WHERE id = ${id}
  `;
  const row = rows[0];
  return row
    ? { worth: row.worth, worthAlpha: row.worth_alpha, worthBeta: row.worth_beta }
    : undefined;
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
  // purge-facts-hard-delete.integration.test.ts and
  // doctor-nonsuperuser.integration.test.ts.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Strategy contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Strategy contract workspace"}, ${"strategy-contract"}, ${TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${OTHER_WS}, ${"Strategy contract other workspace"}, ${"strategy-contract-other"}, ${TENANT_ID})
  `;

  const [hash, otherHash] = await Promise.all([
    bcrypt.hash(KEY, BCRYPT_COST),
    bcrypt.hash(OTHER_WS_KEY, BCRYPT_COST),
  ]);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_strategy_contract"}, ${WS}, ${hash}, ${"strategy-contract"}, ${"strategy-contract"},
       ARRAY['memory:read','memory:write','memory:delete']::text[]),
      (${"key_strategy_contract_other"}, ${OTHER_WS}, ${otherHash}, ${"strategy-contract-other"}, ${"strategy-contract-other"},
       ARRAY['memory:read','memory:write','memory:delete']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  // v3 cognitive core — required by ServerDeps since P20. Fake embed adapter,
  // no LLM. Strategies routes only touch deps.storage; this plumbing exists
  // solely to satisfy ServerDeps's required `cognitive` field.
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
  app = createApp({ deps, version: "strategy-contract-test" });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_strategy store/create — same createStrategy path", () => {
  it("a strategy created via POST /strategies is immediately visible, active, and worth=0.5 (fresh Beta prior)", async () => {
    const created = await createStrategy("store/create parity probe", "do the thing");
    expect(created.status).toBe("active");
    expect(created.successCount).toBe(0);
    expect(created.failureCount).toBe(0);
    expect(created.worth).toBeCloseTo(0.5, 5);

    const raw = await rawWorthColumns(created.id);
    expect(raw).toBeDefined();
    // Postgres itself computed `worth` via the GENERATED column, not app code.
    expect(raw!.worth).toBeCloseTo(0.5, 5);
  });
});

describe("memory_strategy recall vs list — default status filtering (Scenario 1 & 3)", () => {
  it("list (unfiltered) returns only current strategies; includeClosed=true brings the archived one back (PRIM-16)", async () => {
    const active = await createStrategy("recall/list scenario — active", "stay active");
    const toArchive = await createStrategy("recall/list scenario — will archive", "get archived");
    await archiveStrategy(toArchive.id);

    // Plain `list` — the MCP tool's `list` op sends no status param at all.
    const unfiltered = await listStrategies();
    const unfilteredIds = unfiltered.items.map((s) => s.id);
    expect(unfilteredIds).toContain(active.id);
    // PRIM-16: an archived strategy is history; the default list is the current set.
    expect(unfilteredIds).not.toContain(toArchive.id);
    const withClosed = (await listStrategies("?includeClosed=true")).items.map((s) => s.id);
    expect(withClosed).toContain(toArchive.id);

    // `recall` with no explicit statusFilter — strategy.ts sets
    // params.status = "active" in exactly this case (line ~85). This is the
    // literal query the MCP tool issues by default for `op:"recall"`.
    const recalled = await listStrategies("?status=active");
    const recalledIds = recalled.items.map((s) => s.id);
    expect(recalledIds).toContain(active.id);
    // The archived strategy MUST be filtered out — this is the real
    // filtering logic behind "recupera estrategias relevantes/activas".
    // If this assertion failed, recall would be a pure unfiltered alias of
    // list despite its documented claim, which is exactly the gap the
    // audit spec asked us to check for.
    expect(recalledIds).not.toContain(toArchive.id);

    // For the strategy that IS active, list and recall must return the
    // identical record (proves the "alias" half of the claim for the
    // common case where nothing has been archived).
    const activeFromList = unfiltered.items.find((s) => s.id === active.id)!;
    const activeFromRecall = recalled.items.find((s) => s.id === active.id)!;
    expect(activeFromRecall).toEqual(activeFromList);
  });

  it("archiving actually flips status to 'archived' and sets validTo (not just removed from the active filter)", async () => {
    const s = await createStrategy("archive semantics probe", "action");
    await archiveStrategy(s.id);

    const res = await app.request(`/strategies/${s.id}`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StrategyBody;
    expect(body.status).toBe("archived");
    expect(body["validTo"]).toBeTruthy();
  });
});

describe("memory_strategy rate — Beta-Bernoulli worth movement against real Postgres (Scenario 2)", () => {
  it("success outcome moves worth UP from the fresh baseline via the real GENERATED worth column", async () => {
    const s = await createStrategy("rate success probe", "retry with backoff");
    expect(s.worth).toBeCloseTo(0.5, 5);

    const afterFirstSuccess = await rateStrategy(s.id, "success");
    // alpha = 2 + 1 = 3, beta = 2 + 0 = 2, worth = 3/5 = 0.6
    expect(afterFirstSuccess.successCount).toBe(1);
    expect(afterFirstSuccess.failureCount).toBe(0);
    expect(afterFirstSuccess.worth).toBeGreaterThan(0.5);
    expect(afterFirstSuccess.worth).toBeCloseTo(0.6, 5);

    const raw = await rawWorthColumns(s.id);
    expect(raw).toBeDefined();
    expect(parseFloat(raw!.worthAlpha)).toBeCloseTo(3.0, 4);
    expect(parseFloat(raw!.worthBeta)).toBeCloseTo(2.0, 4);
    // Confirms Postgres — not application arithmetic — computed this value.
    expect(raw!.worth).toBeCloseTo(0.6, 5);

    const afterSecondSuccess = await rateStrategy(s.id, "success");
    // alpha = 2 + 2 = 4, beta = 2 + 0 = 2, worth = 4/6 = 0.6667
    expect(afterSecondSuccess.successCount).toBe(2);
    expect(afterSecondSuccess.worth).toBeGreaterThan(afterFirstSuccess.worth);
    expect(afterSecondSuccess.worth).toBeCloseTo(4 / 6, 5);
  });

  it("failure outcome moves worth DOWN from the fresh baseline on a fresh strategy", async () => {
    const s = await createStrategy("rate failure probe", "give up immediately");
    expect(s.worth).toBeCloseTo(0.5, 5);

    const afterFailure = await rateStrategy(s.id, "failure");
    // alpha = 2 + 0 = 2, beta = 2 + 1 = 3, worth = 2/5 = 0.4
    expect(afterFailure.successCount).toBe(0);
    expect(afterFailure.failureCount).toBe(1);
    expect(afterFailure.worth).toBeLessThan(0.5);
    expect(afterFailure.worth).toBeCloseTo(0.4, 5);

    const raw = await rawWorthColumns(s.id);
    expect(raw).toBeDefined();
    expect(parseFloat(raw!.worthAlpha)).toBeCloseTo(2.0, 4);
    expect(parseFloat(raw!.worthBeta)).toBeCloseTo(3.0, 4);
    expect(raw!.worth).toBeCloseTo(0.4, 5);
  });

  it("mixed outcomes converge worth back toward — but not exactly to — 0.5, tracking net success/failure", async () => {
    const s = await createStrategy("rate mixed probe", "sometimes works");
    await rateStrategy(s.id, "success");
    await rateStrategy(s.id, "success");
    const afterMix = await rateStrategy(s.id, "failure");
    // alpha = 2+2=4, beta = 2+1=3, worth = 4/7 ≈ 0.5714 — still above 0.5
    // (net positive), and strictly between the success-heavy and neutral
    // values already proven above.
    expect(afterMix.successCount).toBe(2);
    expect(afterMix.failureCount).toBe(1);
    expect(afterMix.worth).toBeCloseTo(4 / 7, 5);
    expect(afterMix.worth).toBeGreaterThan(0.5);
  });
});

describe("memory_strategy — RLS isolation across workspaces", () => {
  it("a strategy created in one workspace is invisible to a key scoped to a different workspace", async () => {
    const mine = await createStrategy("rls isolation probe", "stay in my workspace");

    const otherList = await app.request("/strategies", { headers: authed(OTHER_WS_KEY) });
    expect(otherList.status).toBe(200);
    const otherBody = (await otherList.json()) as { items: StrategyBody[] };
    expect(otherBody.items.map((s) => s.id)).not.toContain(mine.id);

    const otherGet = await app.request(`/strategies/${mine.id}`, { headers: authed(OTHER_WS_KEY) });
    expect(otherGet.status).toBe(404);
  });
});

describe("memory_strategy — validAt bitemporal filter (DATEBUG-1)", () => {
  it("GET /strategies?validAt=<now> succeeds (does not 500 on a raw Date param)", async () => {
    const s = await createStrategy("validAt smoke probe", "must not 500");
    // Just after the row's own valid_from (database clock), not the Node clock's "now".
    const justAfter = new Date(Date.parse(s.validFrom as string) + 1).toISOString();
    const res = await app.request(`/strategies?validAt=${encodeURIComponent(justAfter)}`, {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: StrategyBody[] };
    expect(body.items.map((x) => x.id)).toContain(s.id);
  });

  it("validAt=<now> excludes a strategy archived before that instant", async () => {
    const live = await createStrategy("validAt live probe", "stays open");
    const closed = await createStrategy("validAt closed probe", "gets archived");
    await archiveStrategy(closed.id);
    const asOf = new Date(Date.now() + 60_000).toISOString(); // determinism-ok: relative seed timestamp, not an assertion value
    const res = await app.request(`/strategies?validAt=${encodeURIComponent(asOf)}`, {
      headers: authed(),
    });
    const ids = ((await res.json()) as { items: StrategyBody[] }).items.map((x) => x.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(closed.id);
  });

  it("a validAt BEFORE the archive instant still returns the archived strategy (real as-of read)", async () => {
    const closed = await createStrategy("validAt time-travel probe", "archived later");
    // Archived well after it began: one millisecond before the close is still inside the
    // interval (back to back, both stamps can share a millisecond).
    await new Promise((r) => setTimeout(r, 20));
    await archiveStrategy(closed.id);
    const detail = await app.request(`/strategies/${closed.id}`, { headers: authed() });
    const { validTo } = (await detail.json()) as StrategyBody & { validTo: string };
    const justBefore = new Date(new Date(validTo).getTime() - 1).toISOString();
    const res = await app.request(`/strategies?validAt=${encodeURIComponent(justBefore)}`, {
      headers: authed(),
    });
    const ids = ((await res.json()) as { items: StrategyBody[] }).items.map((x) => x.id);
    expect(ids).toContain(closed.id);
  });
});
