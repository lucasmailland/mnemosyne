/**
 * Q-1 (end-to-end verification of the eval fixes) — a collapse whose
 * extraction repeats a live statement, against real Postgres.
 *
 * The verifier saw about 2 of 6 re-collapses with the real model answer 500:
 * `duplicate key value violates unique constraint "uniq_mnemo_fact_dedup"` on
 * the collapse's `insert into mnemo_fact`. The persist step is one transaction,
 * so the whole collapse rolled back and the session stayed `active`. These
 * tests drive the HTTP routes with a scripted extraction, and storage connected
 * as `mnemo_app` (NOSUPERUSER, NOBYPASSRLS, member of `mnemo_app_role`, as in
 * production under FORCE RLS):
 *
 *   - a statement already live is reused and linked to the episode;
 *   - a remember() that commits the statement between the collapse's check and
 *     its INSERT (the INSERT sees it first) does not abort the collapse;
 *   - a remember() that arrives while the collapse's INSERT is uncommitted
 *     waits, then answers 201 with the collapse's row (CHAOS-7);
 *   - a keyed update whose new value is already live in another row does not
 *     abort the collapse either.
 *
 * Hermetic: fresh container per run. Requires Docker and Node 22.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CacheAdapter,
  EmbedAdapter,
  LLMAdapter,
  LLMInput,
  LLMOutput,
  StorageAdapter,
  VectorAdapter,
} from "@mnemo-ai/types";

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
const APP_ROLE = "mnemo_app";
const APP_PASSWORD = "mnemo_app_q1_pass";

const TENANT_ID = "tenant-collapse-exact-duplicate";
const WS = "9b1f9c00-0000-4000-8000-0000000000a1";
const KEY = "mns_live_collapseexactduplicateq1";

// One vector for every text: the RecMem gate sees perfect recurrence. The
// vector search answers nothing, so the surprise gate never hides a statement
// and each one reaches the persist step.
const DIMS = 1536;
const UNIT = new Float32Array(Array.from({ length: DIMS }, () => 1 / Math.sqrt(DIMS)));

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let storage: StorageAdapter;

/** The extraction each session gets, chosen by a marker in its turns. */
const replyByMarker: Record<string, Record<string, unknown>> = {};

function authed(): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
}

const fakeEmbed: EmbedAdapter = {
  id: "q1-embed",
  model: "q1-model",
  dimensions: DIMS,
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => UNIT);
  },
  async embedSingle(): Promise<Float32Array> {
    return UNIT;
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

const fakeVector: VectorAdapter = {
  id: "q1-vector",
  dimensions: DIMS,
  async search() {
    return [];
  },
  async upsert() {},
  async delete() {},
  async deleteByFilter() {
    return 0;
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
  async close() {},
} as unknown as VectorAdapter;

const fakeLlm: LLMAdapter = {
  id: "q1-llm",
  model: "q1-model",
  async generate(input: LLMInput): Promise<LLMOutput> {
    const prompt = input.messages.map((m) => m.content).join("\n");
    const marked = Object.entries(replyByMarker).find(([marker]) => prompt.includes(marker))?.[1];
    return {
      // Anything that is not a collapse (remember()'s write-time classifier)
      // gets a verdict that writes nothing.
      content: marked ? JSON.stringify(marked) : "COMPATIBLE",
      tokensUsed: { input: 10, output: 10 },
      model: "q1-model",
      finishReason: "stop",
    };
  },
  async generateStructured<T>(_input: LLMInput, schema: { parse: (d: unknown) => T }): Promise<T> {
    return schema.parse({});
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

/** Session routes need an L1 cache. */
class FakeCache implements CacheAdapter {
  readonly id = "q1-cache";
  readonly capabilities = {
    sortedSets: false,
    pubSub: false,
    patterns: true,
    atomic: true,
    hashes: false,
  };
  store = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const v = this.store.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  }
  async close(): Promise<void> {}
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
  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });

  admin = postgres(superUrl, { max: 3, onnotice: () => void 0 });
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Q-1 tenant"})`;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Q-1 workspace"}, ${"q1-collapse-dedup"}, ${TENANT_ID})
  `;
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_q1_collapse"}, ${WS}, ${keyHash}, ${"q1"}, ${"q1"},
            ARRAY['memory:read','memory:write','memory:delete']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  const [adapterPgMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const { db, pgClient } = adapterPgMod.createDrizzleClient(appUrl);
  const drizzle = new adapterPgMod.DrizzleStorageAdapter(db, pgClient, undefined);
  storage = drizzle as unknown as StorageAdapter;

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
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const telemetry = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outbox: import("@mnemo-ai/types").OutboxAdapter = {
    append: (e) => drizzle.appendOutbox(e),
    claimBatch: (n) => drizzle.claimOutbox(n),
    markProcessed: (ids) => drizzle.markOutboxProcessed(ids),
    markFailed: (id, err) => drizzle.markOutboxFailed(id, err),
    getStats: async () => ({ pending: 0, failed: 0, oldestPendingMs: 0 }),
  };
  const cache = new FakeCache();
  const cognitive = v3CoreMod.createCore({
    storage: drizzle,
    vector: fakeVector,
    embed: fakeEmbed,
    outbox,
    llm: fakeLlm,
    cache,
    logger: noopLogger,
    telemetry,
  });
  const deps = {
    apiKeys,
    cognitive,
    storage: drizzle,
    llm: undefined,
    embedModel: "q1-model",
    cache,
    telemetry,
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "q1-collapse-exact-duplicate" });
}, 240_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

async function sessionFor(marker: string, extraction: Record<string, unknown>): Promise<string> {
  replyByMarker[marker] = {
    goal: `${marker} goal`,
    outcome: "resolved",
    decisions: [],
    strategies: [],
    ...extraction,
  };
  const start = await app.request("/session/start", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ agentId: "agent-q1" }),
  });
  const startBody = (await start.json()) as { id: string };
  if (start.status !== 201)
    throw new Error(`session/start ${start.status}: ${JSON.stringify(startBody)}`);
  const { id } = startBody;
  for (let i = 0; i < 4; i++) {
    const res = await app.request(`/session/${id}/turn`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${marker} discussion turn ${i}`,
      }),
    });
    expect(res.status).toBe(204);
  }
  return id;
}

async function collapse(sessionId: string) {
  const res = await app.request(`/session/${sessionId}/collapse`, {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ strategy: "explicit" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function remember(statement: string) {
  const res = await app.request("/remember", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ statement }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function liveRows(statement: string) {
  return admin<Array<{ id: string; session_id: string | null; episode_id: string | null }>>`
    SELECT id, session_id, episode_id FROM mnemosyne.mnemo_fact
    WHERE workspace_id = ${WS} AND statement = ${statement}
      AND status = 'active' AND valid_to IS NULL`;
}

async function sessionState(sessionId: string) {
  const [session] = await admin<Array<{ status: string }>>`
    SELECT status FROM mnemosyne.mnemo_session WHERE id = ${sessionId}`;
  const episodes = await admin<Array<{ linked_fact_ids: string[] }>>`
    SELECT linked_fact_ids FROM mnemosyne.mnemo_episode
    WHERE workspace_id = ${WS} AND source_conversation_id = ${sessionId}`;
  return { status: session!.status, episodes };
}

/** Holds the collapse inside its INSERT of `statement` until a remember() has run. */
async function slowCollapseInsert(
  when: "BEFORE" | "AFTER",
  prefix: string
): Promise<() => Promise<void>> {
  await admin.unsafe(`
    CREATE OR REPLACE FUNCTION mnemosyne.test_q1_slow_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.extraction_source = 'collapse' AND NEW.statement LIKE '${prefix}%' THEN
        PERFORM pg_sleep(1.5);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_q1_slow_insert ${when} INSERT ON mnemosyne.mnemo_fact
    FOR EACH ROW EXECUTE FUNCTION mnemosyne.test_q1_slow_insert();
  `);
  return async () => {
    await admin.unsafe("DROP TRIGGER IF EXISTS test_q1_slow_insert ON mnemosyne.mnemo_fact");
  };
}

/** Resolves once a backend of the app role sleeps inside the trigger. */
async function waitForSleepingInsert(): Promise<void> {
  const deadline = Date.now() + 30_000; // determinism-ok: polling deadline on the wall clock, not an assertion value
  while (Date.now() /* determinism-ok: polling deadline on the wall clock */ < deadline) {
    const [row] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE usename = ${APP_ROLE} AND wait_event = 'PgSleep'`;
    if (row!.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the collapse never reached its INSERT");
}

describe("Q-1 — a collapse that repeats a live statement", () => {
  it("reuses the live fact, links it to the episode and writes the rest", async () => {
    const live = "q1-repeat: the orders-api rate limit is 500 requests per minute";
    const fresh = "q1-repeat: the orders-api retries a failed webhook 3 times";
    const seeded = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement: live,
      subject: "general",
      kind: "other",
      confidence: 0.9,
    });
    const sessionId = await sessionFor("q1-repeat", {
      facts: [{ content: live }, { content: fresh }],
    });

    const res = await collapse(sessionId);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("completed");
    expect((await liveRows(live)).map((r) => r.id)).toEqual([seeded.id]);
    const [created] = await liveRows(fresh);
    expect(created?.session_id).toBe(sessionId);
    const state = await sessionState(sessionId);
    expect(state.status).toBe("collapsed");
    expect(state.episodes).toHaveLength(1);
    expect(state.episodes[0]!.linked_fact_ids).toEqual(
      expect.arrayContaining([seeded.id, created!.id])
    );
    // The reused row keeps the origin it had: this session did not write it.
    expect((await liveRows(live))[0]!.episode_id).toBeNull();
  });

  it("a remember() that commits the statement before the collapse's INSERT does not abort it", async () => {
    const statement = "q1-race-a: the ledger export runs at 02:15 UTC";
    const fresh = "q1-race-a: the ledger export keeps 7 days of files";
    const sessionId = await sessionFor("q1-race-a", {
      facts: [{ content: statement }, { content: fresh }],
    });
    // Sleep BEFORE the row exists, i.e. after the duplicate check and before
    // the unique index sees the collapse's INSERT.
    const drop = await slowCollapseInsert("BEFORE", statement);
    let collapsed: Awaited<ReturnType<typeof collapse>>;
    let written: Awaited<ReturnType<typeof remember>>;
    try {
      const collapsing = collapse(sessionId);
      await waitForSleepingInsert();
      written = await remember(statement);
      collapsed = await collapsing;
    } finally {
      await drop();
    }

    expect(written.status).toBe(201);
    expect(collapsed.status).toBe(202);
    expect(collapsed.body.status).toBe("completed");
    const rows = await liveRows(statement);
    expect(rows.map((r) => r.id)).toEqual([written.body.id]);
    const state = await sessionState(sessionId);
    expect(state.status).toBe("collapsed");
    expect(state.episodes[0]!.linked_fact_ids).toEqual(
      expect.arrayContaining([written.body.id as string])
    );
    expect(await liveRows(fresh)).toHaveLength(1);
  });

  it("a remember() racing the collapse's uncommitted INSERT gets the collapse's row", async () => {
    const statement = "q1-race-b: the payments-api deploys through ArgoCD";
    const sessionId = await sessionFor("q1-race-b", { facts: [{ content: statement }] });
    // Sleep AFTER the row is in the index, inside the open transaction.
    const drop = await slowCollapseInsert("AFTER", statement);
    let collapsed: Awaited<ReturnType<typeof collapse>>;
    let written: Awaited<ReturnType<typeof remember>>;
    try {
      const collapsing = collapse(sessionId);
      await waitForSleepingInsert();
      written = await remember(statement);
      collapsed = await collapsing;
    } finally {
      await drop();
    }

    expect(collapsed.status).toBe(202);
    expect(written.status).toBe(201);
    const rows = await liveRows(statement);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe(sessionId);
    expect(written.body.id).toBe(rows[0]!.id);
    expect((await sessionState(sessionId)).episodes[0]!.linked_fact_ids).toContain(rows[0]!.id);
  });

  it("a keyed update whose new value is already live in another row does not abort it", async () => {
    const before = "q1-merge: the gateway timeout is 30 seconds";
    const after = "q1-merge: the gateway timeout is 60 seconds";
    const keyed = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement: before,
      subject: "general",
      kind: "other",
      confidence: 0.9,
      topicKey: "q1-merge/gateway-timeout",
    });
    const unkeyed = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement: after,
      subject: "general",
      kind: "other",
      confidence: 0.9,
    });
    const sessionId = await sessionFor("q1-merge", {
      facts: [{ content: after, topicKey: "q1-merge/gateway-timeout" }],
    });

    const res = await collapse(sessionId);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("completed");
    expect((await liveRows(after)).map((r) => r.id)).toEqual([unkeyed.id]);
    // The merge rolled back to its savepoint: the keyed row is still live.
    expect((await liveRows(before)).map((r) => r.id)).toEqual([keyed.id]);
    const state = await sessionState(sessionId);
    expect(state.status).toBe("collapsed");
    expect(state.episodes[0]!.linked_fact_ids).toContain(unkeyed.id);
  });
});
