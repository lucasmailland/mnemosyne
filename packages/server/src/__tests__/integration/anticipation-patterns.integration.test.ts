/**
 * ANTICIPATE-2 — real-Postgres coverage for the 4 anticipation pattern
 * readers (`AnalyticsRepository.get{Sequential,Periodic,Conditional,
 * CoOccurrence}Patterns`) and `GET /anticipation`.
 *
 * Coverage gap, no known bug: the only prior coverage was
 * `matview-init.integration.test.ts` (asserts empty-array-on-fresh-workspace)
 * plus mocked-storage unit tests. Nothing proved the SQL returns correct rows
 * once the materialized views have real data. This suite seeds real recall
 * history past each MV's threshold, calls the exact
 * `mnemosyne.mnemo_refresh_anticipation()` path the `mnemo.anticipate.mine`
 * cron uses, then asserts against real Postgres — through a NOSUPERUSER
 * `mnemo_app_role` connection — at three levels: the repository readers, the
 * core-level 4-way blend (`buildAnticipationFeed`), and the HTTP route.
 *
 * MV thresholds (0001_v3_complete_baseline.sql, re-verified against the
 * live SQL, not assumed from the plan doc):
 *   - mv_sequential_patterns:  30-day window, 5-min successor window,
 *     HAVING support >= 5, confidence (support/total_outgoing) >= 0.30.
 *   - mv_periodic_patterns:    90-day window, UTC dow + 3h bucket,
 *     distinct_weeks >= 3, slot_share >= 0.20.
 *   - mv_conditional_patterns: 30-day window, key = lower(btrim(query_text)),
 *     HAVING co_returns >= 4, confidence (co_returns/query_total) >= 0.50.
 *   - co-occurrence has NO MV — reads mnemo_relation.co_recall_count /
 *     hebbian_weight directly, WHERE valid_to IS NULL AND co_recall_count
 *     >= minCoRecall.
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
const APP_ROLE = "anticipation_app";
const APP_PASSWORD = "anticipation_app_pass";

const TENANT_ID = "tenant-anticipation-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000030";
const WS_OTHER = "9b1f9c00-0000-4000-8000-000000000031";

// Well-formed key matching auth.ts API_KEY_PATTERN: mns_(live|test)_[a-z0-9]{20,64}
const API_KEY = "mns_live_anticipationcontracthasscope1";
const API_KEY_OTHER = "mns_live_anticipationotherworkspacekey1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let v3Storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
let buildAnticipationFeed: typeof import("@mnemo-ai/core/cognitive").buildAnticipationFeed;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", ...headers };
}

function authedOther(headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${API_KEY_OTHER}`,
    "content-type": "application/json",
    ...headers,
  };
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

async function insertRecallLog(
  workspaceId: string,
  factId: string,
  recalledAt: Date,
  queryText?: string
): Promise<void> {
  await admin`
    INSERT INTO mnemosyne.mnemo_recall_log (workspace_id, fact_id, recalled_at, query_text)
    VALUES (${workspaceId}::uuid, ${factId}, ${recalledAt.toISOString()}::timestamptz, ${queryText ?? null})
  `;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Anticipation contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Anticipation contract workspace"}, ${"anticipation-contract"}, ${TENANT_ID})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS_OTHER}, ${"Anticipation contract workspace 2"}, ${"anticipation-contract-2"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_anticipation_contract"}, ${WS}, ${hash}, ${"anticipation-contract"}, ${"anticipation-contract"},
       ARRAY['memory:read','memory:write']::text[])
  `;
  const hashOther = await bcrypt.hash(API_KEY_OTHER, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_anticipation_contract_other"}, ${WS_OTHER}, ${hashOther}, ${"anticipation-contract-other"}, ${"anticipation-contract-other"},
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
  buildAnticipationFeed = v3CoreMod.buildAnticipationFeed;
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
  app = createApp({ deps, version: "anticipation-contract-test" });

  // ── Seed real recall history past each MV's threshold ──────────────────
  const ANCHOR = new Date(); // determinism-ok: used only as a relative reference point (all seed timestamps and assertions are offsets from it, e.g. "7/14/21 days before"), never compared against wall-clock time

  // Sequential: real facts A, B. 5 (A -> B, 60s apart) pairs, groups 1 hour
  // apart so the 5-min successor-window join never bridges groups and never
  // creates an (A,C) or (B,A) pair that would dilute A's confidence below 1.0.
  const factA = await createFactViaApi("Sequential predecessor fact A");
  const factB = await createFactViaApi("Sequential successor fact B");
  for (let i = 0; i < 5; i++) {
    const groupStart = new Date(ANCHOR.getTime() - (i + 1) * HOUR_MS);
    await insertRecallLog(WS, factA, groupStart);
    await insertRecallLog(WS, factB, new Date(groupStart.getTime() + 60_000));
  }

  // Periodic: real fact recalled 3 times, each exactly 7/14/21 days before
  // ANCHOR (same UTC dow+hour bucket by construction — date_trunc('week') has
  // an exact 7-day period, so 7/14/21-day-apart instants always land in 3
  // distinct week buckets regardless of where ANCHOR falls in its own week).
  // This fact is recalled ONLY at these 3 instants, so slot_recalls == total
  // == 3 and slot_share == 1.0 (>= the 0.20 threshold with large margin).
  const factPeriodic = await createFactViaApi("Periodic Monday-morning fact");
  for (const daysAgo of [7, 14, 21]) {
    await insertRecallLog(WS, factPeriodic, new Date(ANCHOR.getTime() - daysAgo * DAY_MS));
  }

  // Conditional: real fact recalled 4 times under the same query_key (varying
  // case/whitespace on one occurrence to prove lower(btrim(...)) normalizes
  // them into a single key). This query_key is used ONLY with this fact, so
  // co_returns == query_total == 4 and confidence == 1.0 (>= the 0.50
  // threshold with large margin).
  const factConditional = await createFactViaApi("Conditional Acme-roadmap fact");
  const rawQueries = ["acme roadmap", "Acme Roadmap", "  ACME ROADMAP  ", "acme roadmap"];
  for (let i = 0; i < rawQueries.length; i++) {
    await insertRecallLog(
      WS,
      factConditional,
      new Date(ANCHOR.getTime() - (i + 1) * 60_000),
      rawQueries[i]
    );
  }

  // Co-occurrence: direct mnemo_relation insert (no MV) — workspace_id is
  // TEXT on this table, no ::uuid cast.
  const factCoA = await createFactViaApi("Co-occurrence source fact");
  const factCoB = await createFactViaApi("Co-occurrence partner fact");
  await admin`
    INSERT INTO mnemosyne.mnemo_relation
      (id, workspace_id, source_kind, source_id, target_kind, target_id, relation,
       marked_by_kind, co_recall_count, hebbian_weight, valid_to)
    VALUES
      (${"rel_anticipation_cooccur_1"}, ${WS}, ${"fact"}, ${factCoA}, ${"fact"}, ${factCoB}, ${"related"},
       ${"agent"}, ${3}, ${0.8}, NULL)
  `;

  // Refresh — the EXACT call `mnemo.anticipate.mine` cron makes
  // (SELECT mnemosyne.mnemo_refresh_anticipation()), run once after seeding
  // rather than waiting for the cron.
  await v3Storage.refreshAnticipationViews();

  (globalThis as unknown as { __anticipationSeed: unknown }).__anticipationSeed = {
    factA,
    factB,
    factPeriodic,
    factConditional,
    factCoA,
    factCoB,
    ANCHOR,
  };
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

function seed() {
  return (
    globalThis as unknown as {
      __anticipationSeed: {
        factA: string;
        factB: string;
        factPeriodic: string;
        factConditional: string;
        factCoA: string;
        factCoB: string;
        ANCHOR: Date;
      };
    }
  ).__anticipationSeed;
}

describe("getSequentialPatterns — real mv_sequential_patterns rows", () => {
  it("returns the A->B pair with support=5 and confidence=1.0 (A only ever precedes B)", async () => {
    const { factA, factB } = seed();
    const rows = await v3Storage.getSequentialPatterns({ workspaceId: WS, predecessorId: factA });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ predecessorId: factA, successorId: factB, support: 5 });
    expect(rows[0]!.confidence).toBeCloseTo(1.0, 4);
    expect(rows[0]!.avgLagSeconds).toBeCloseTo(60, 0);
  });

  it("workspace isolation: WS_OTHER sees no sequential patterns from WS", async () => {
    const rows = await v3Storage.getSequentialPatterns({ workspaceId: WS_OTHER });
    expect(rows).toHaveLength(0);
  });
});

describe("getPeriodicPatterns — real mv_periodic_patterns rows", () => {
  it("returns the periodic fact with distinctWeeks=3 and slotShare=1.0", async () => {
    const { factPeriodic } = seed();
    const rows = await v3Storage.getPeriodicPatterns({ workspaceId: WS });
    const row = rows.find((r) => r.memoryId === factPeriodic);
    expect(row).toBeDefined();
    expect(row!.distinctWeeks).toBe(3);
    expect(row!.slotShare).toBeCloseTo(1.0, 4);
  });

  it("workspace isolation: WS_OTHER sees no periodic patterns from WS", async () => {
    const rows = await v3Storage.getPeriodicPatterns({ workspaceId: WS_OTHER });
    expect(rows).toHaveLength(0);
  });
});

describe("getConditionalPatterns — real mv_conditional_patterns rows, key-normalized", () => {
  it("normalizes case/whitespace variants into a single query_key with co_returns=4, confidence=1.0", async () => {
    const { factConditional } = seed();
    const rows = await v3Storage.getConditionalPatterns({
      workspaceId: WS,
      queryKey: "  Acme Roadmap  ",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ factId: factConditional, coReturns: 4, queryTotal: 4 });
    expect(rows[0]!.confidence).toBeCloseTo(1.0, 4);
  });

  it("workspace isolation: WS_OTHER sees no conditional patterns from WS", async () => {
    const rows = await v3Storage.getConditionalPatterns({
      workspaceId: WS_OTHER,
      queryKey: "acme roadmap",
    });
    expect(rows).toHaveLength(0);
  });
});

describe("getCoOccurrencePatterns — direct mnemo_relation read, no MV involved", () => {
  it("reads the seeded relation's co_recall_count and hebbian_weight directly", async () => {
    const { factCoA, factCoB } = seed();
    const rows = await v3Storage.getCoOccurrencePatterns({ workspaceId: WS, sourceId: factCoA });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: factCoB, coRecallCount: 3, hebbianWeight: 0.8 });
  });

  it("is symmetric: querying from the partner side finds the source as partner", async () => {
    const { factCoA, factCoB } = seed();
    const rows = await v3Storage.getCoOccurrencePatterns({ workspaceId: WS, sourceId: factCoB });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.partnerId).toBe(factCoA);
  });

  it("workspace isolation: WS_OTHER sees no co-occurrence patterns from WS", async () => {
    const { factCoA } = seed();
    const rows = await v3Storage.getCoOccurrencePatterns({
      workspaceId: WS_OTHER,
      sourceId: factCoA,
    });
    expect(rows).toHaveLength(0);
  });
});

describe("buildAnticipationFeed — real 4-way blend at the core level (deterministic nowMs)", () => {
  it("blends sequential + periodic + conditional + co-occurrence with the real fixed weights", async () => {
    const { factA, factB, factPeriodic, factConditional, factCoA, factCoB, ANCHOR } = seed();
    const feed = await buildAnticipationFeed(v3Storage, WS, {
      recentlyRecalledId: factA,
      queryContext: "acme roadmap",
      nowMs: ANCHOR.getTime(),
      limit: 50,
    });
    const byId = new Map(feed.items.map((it) => [it.id, it]));

    // Sequential: factB reached only via the sequential branch (A->B).
    const bItem = byId.get(factB);
    expect(bItem).toBeDefined();
    expect(bItem!.source === "sequential" || bItem!.source === "blended").toBe(true);
    expect(bItem!.score).toBeCloseTo(1.0 * 0.35, 4);

    // Periodic: reached only via the periodic branch (no recentlyRecalledId
    // link to it, no queryContext match).
    const periodicItem = byId.get(factPeriodic);
    expect(periodicItem).toBeDefined();
    expect(periodicItem!.source).toBe("periodic");
    expect(periodicItem!.score).toBeCloseTo(1.0 * 0.25, 4);

    // Conditional: reached via queryContext="acme roadmap".
    const conditionalItem = byId.get(factConditional);
    expect(conditionalItem).toBeDefined();
    expect(conditionalItem!.source === "conditional" || conditionalItem!.source === "blended").toBe(
      true
    );

    // Co-occurrence: factA has no seeded relation to factCoB, so factCoB
    // should NOT appear from factA's cue. Confirm the co-occurrence branch
    // separately, cued off factCoA.
    const coFeed = await buildAnticipationFeed(v3Storage, WS, {
      recentlyRecalledId: factCoA,
      nowMs: ANCHOR.getTime(),
      limit: 50,
    });
    const coItem = coFeed.items.find((it) => it.id === factCoB);
    expect(coItem).toBeDefined();
    expect(coItem!.source === "co-occurrence" || coItem!.source === "blended").toBe(true);
    expect(coItem!.score).toBeCloseTo(Math.min(1, 3 / 10) * 0.15, 4);
  });

  it("without recentlyRecalledId, the conditional branch still contributes (disproves the old 'only periodicity counts' claim)", async () => {
    const { factConditional, ANCHOR } = seed();
    const feed = await buildAnticipationFeed(v3Storage, WS, {
      queryContext: "acme roadmap",
      nowMs: ANCHOR.getTime(),
      limit: 50,
    });
    const item = feed.items.find((it) => it.id === factConditional);
    expect(item).toBeDefined();
    expect(item!.source).toBe("conditional");
  });

  it("workspace isolation: WS_OTHER's feed is empty even with the same cue/context", async () => {
    const { factA, ANCHOR } = seed();
    const feed = await buildAnticipationFeed(v3Storage, WS_OTHER, {
      recentlyRecalledId: factA,
      queryContext: "acme roadmap",
      nowMs: ANCHOR.getTime(),
      limit: 50,
    });
    expect(feed.items).toHaveLength(0);
  });
});

describe("GET /anticipation — HTTP-level proof (lookAhead=0, slot-independent signals only)", () => {
  it("returns the sequential and conditional items via the real route", async () => {
    const { factA, factB, factConditional } = seed();
    const res = await app.request(
      `/anticipation?recentlyRecalledId=${factA}&context=${encodeURIComponent("acme roadmap")}&lookAhead=0&limit=50`,
      { headers: authed() }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; source: string; score: number }>;
    };
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(factB);
    expect(ids).toContain(factConditional);
  });

  it("workspace isolation over HTTP: a key bound to WS_OTHER sees no items even citing WS's own fact ids as the cue", async () => {
    const { factA } = seed();
    const res = await app.request(
      `/anticipation?recentlyRecalledId=${factA}&context=${encodeURIComponent("acme roadmap")}&lookAhead=0&limit=50`,
      { headers: authedOther() }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(0);
  });
});
