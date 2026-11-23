/**
 * WP-4 — collapse integrity against REAL Postgres (LIFECYCLE-3/4/7/8).
 *
 * The lifecycle evaluation could only run the pipeline on the in-memory adapter
 * (the stack's collapse 503'd on the LLM resolver), so the Postgres half of
 * these findings — what a failed collapse leaves behind, what two collapses of
 * one session write, what a topic merge does to the predecessor row — had never
 * been observed. This file observes it, through the HTTP route, with a scripted
 * LLM and the RLS-subject `DrizzleStorageAdapter`.
 *
 *   - LIFECYCLE-8: a fault injected at the strategy INSERT (a trigger that
 *     raises) rolls back the facts, decision, episode and outbox rows written
 *     before it; the session stays `active` and retryable, and the retry
 *     writes exactly one complete set.
 *   - LIFECYCLE-7: a repeated collapse and two concurrent collapses of one
 *     session produce one episode and one extraction set.
 *   - LIFECYCLE-3/4: distinct facts under one key all survive; a keyed value
 *     update supersedes the live row bitemporally.
 *
 * Hermetic & CI-safe: fresh container per run. Requires Docker and Node 22.
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

const WS = "4c0a2e5e-0004-4004-8004-000000000004";
const PLAINTEXT_KEY = "mns_live_collapseintegritytestkey04";
const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";
const DIMS = 8;

let container: StartedTestContainer;
let databaseUrl: string;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let pgClient: postgres.Sql;
let storage: StorageAdapter;

/** The scripted extraction: each test sets what the "model" answers. */
let nextReply: Record<string, unknown> = {};
/** When set, the reply whose marker appears in the prompt wins over nextReply. */
let replyByMarker: Record<string, Record<string, unknown>> | null = null;
let llmCalls = 0;

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };
}

// One vector for every text: RecMem sees perfect recurrence. No fact gets an
// embedding here (no outbox worker), so the surprise gate always sees PE = 1.
const fakeEmbed: EmbedAdapter = {
  id: "fake-embed",
  model: "fake-model",
  dimensions: DIMS,
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(
      () => new Float32Array(Array.from({ length: DIMS }, () => 1 / Math.sqrt(DIMS)))
    );
  },
  async embedSingle(): Promise<Float32Array> {
    return new Float32Array(Array.from({ length: DIMS }, () => 1 / Math.sqrt(DIMS)));
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

const fakeLlm: LLMAdapter = {
  id: "fake-llm",
  model: "fake-model",
  async generate(input: LLMInput): Promise<LLMOutput> {
    const prompt = input.messages[0]?.content ?? "";
    const marked = replyByMarker
      ? Object.entries(replyByMarker).find(([marker]) => prompt.includes(marker))?.[1]
      : undefined;
    llmCalls++;
    return {
      content: JSON.stringify(marked ?? nextReply),
      tokensUsed: { input: 10, output: 10 },
      model: "fake-model",
      finishReason: "stop",
    };
  },
  async generateStructured<T>(_input: LLMInput, schema: { parse: (d: unknown) => T }): Promise<T> {
    return schema.parse(nextReply);
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

class FakeCache implements CacheAdapter {
  readonly id = "fake-cache";
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

  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;

  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  pgClient = postgres(databaseUrl, { max: 3, onnotice: () => void 0 });
  await pgClient`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_collapse_integrity_04"}, ${WS}, ${keyHash}, ${"collapse-integrity"}, ${"collapse-integrity"},
            ARRAY['memory:write', 'memory:read', 'memory:delete']::text[])
  `;

  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);

  const { db, pgClient: pgC } = adapterPgMod.createDrizzleClient(databaseUrl);
  const drizzle = new adapterPgMod.DrizzleStorageAdapter(db, pgC, undefined);
  storage = drizzle as unknown as StorageAdapter;
  const vectorAdapter = new adapterVectorMod.PgVectorAdapter({
    connectionString: databaseUrl,
    dimensions: DIMS,
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const noop = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
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
  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return drizzle.appendOutbox(e);
    },
    async claimBatch(n) {
      return drizzle.claimOutbox(n);
    },
    async markProcessed(ids) {
      return drizzle.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return drizzle.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };

  const cognitive = v3CoreMod.createCore({
    storage: drizzle,
    vector: vectorAdapter,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    llm: fakeLlm,
    cache: new FakeCache(),
    logger: noopLogger,
    telemetry: noop,
  });

  const deps = {
    cognitive,
    storage: drizzle,
    apiKeys: { close: async () => {} },
    llm: undefined,
    embedModel: "fake-model",
    cache: new FakeCache(),
    telemetry: noop,
  } as unknown as ServerDeps;

  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  apiKeyLookupClose = apiKeys.close;
  (deps as unknown as { apiKeys: unknown }).apiKeys = apiKeys;

  app = createApp({ deps, version: "collapse-integrity-test" });
}, 180_000);

afterAll(async () => {
  await pgClient?.end().catch(() => void 0);
  await apiKeyLookupClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

async function startSessionWithTurns(n = 4, topic = "orders-api token cache"): Promise<string> {
  const startRes = await app.request("/session/start", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ agentId: "agent-collapse-integrity" }),
  });
  expect(startRes.status).toBe(201);
  const { id } = (await startRes.json()) as { id: string };
  for (let i = 0; i < n; i++) {
    const res = await app.request(`/session/${id}/turn`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${topic} discussion turn ${i}`,
      }),
    });
    expect(res.status).toBe(204);
  }
  return id;
}

function collapse(sessionId: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/session/${sessionId}/collapse`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ strategy: "explicit" }),
    })
  );
}

async function countsFor(sessionId: string, tag: string) {
  const [facts] = await pgClient`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_fact
    WHERE workspace_id = ${WS} AND session_id = ${sessionId} AND status = 'active'`;
  const [decisions] = await pgClient`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_decision
    WHERE workspace_id = ${WS} AND title LIKE ${`${tag}%`} AND status = 'active'`;
  const [strategies] = await pgClient`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_strategy
    WHERE workspace_id = ${WS} AND trigger LIKE ${`${tag}%`}`;
  const [episodes] = await pgClient`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_episode
    WHERE workspace_id = ${WS} AND source_conversation_id = ${sessionId}`;
  const [session] = await pgClient`
    SELECT status, collapse_attempts, context_snapshot FROM mnemosyne.mnemo_session
    WHERE id = ${sessionId}`;
  return {
    facts: facts!.n as number,
    decisions: decisions!.n as number,
    strategies: strategies!.n as number,
    episodes: episodes!.n as number,
    status: session!.status as string,
    attempts: session!.collapse_attempts as number,
    snapshot: session!.context_snapshot as Record<string, unknown> | null,
  };
}

function extraction(tag: string): Record<string, unknown> {
  return {
    goal: `${tag} goal`,
    outcome: "resolved",
    facts: [
      { content: `${tag}: session tokens are cached in Redis for 15 minutes` },
      { content: `${tag}: revoked tokens are deleted from the cache` },
    ],
    // Keyless on purpose: a duplicate would not be hidden by a topic merge.
    decisions: [{ title: `${tag} shorten the TTL`, body: "revocation lag", kind: "decision" }],
    strategies: [{ trigger: `${tag} a token is revoked`, action: "delete it from Redis" }],
  };
}

describe("LIFECYCLE-8 — a failed collapse leaves nothing behind", () => {
  it("rolls back every write on a mid-persist failure, and the retry writes one complete set", async () => {
    const sessionId = await startSessionWithTurns();
    nextReply = extraction("L8");

    await pgClient.unsafe(`
      CREATE OR REPLACE FUNCTION mnemosyne.test_fail_strategy() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected strategy failure'; END $$;
      CREATE TRIGGER test_fail_strategy BEFORE INSERT ON mnemosyne.mnemo_strategy
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.test_fail_strategy();
    `);
    const [outboxBefore] = await pgClient`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_outbox WHERE workspace_id = ${WS}`;

    let failed: Response;
    try {
      failed = await collapse(sessionId);
    } finally {
      await pgClient.unsafe(
        "DROP TRIGGER IF EXISTS test_fail_strategy ON mnemosyne.mnemo_strategy"
      );
    }
    expect(failed.status).toBeGreaterThanOrEqual(500);

    const afterFailure = await countsFor(sessionId, "L8");
    expect(afterFailure).toMatchObject({
      facts: 0,
      decisions: 0,
      strategies: 0,
      episodes: 0,
      status: "active",
      attempts: 1,
    });
    const [outboxAfter] = await pgClient`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_outbox WHERE workspace_id = ${WS}`;
    // The vector_upsert jobs createFact enqueued rolled back with the facts.
    expect(outboxAfter!.n).toBe(outboxBefore!.n);

    // LIFECYCLE-14: the session says why it is still active.
    const pending = (await (
      await app.request(`/session/${sessionId}`, { headers: authed() })
    ).json()) as { collapse: Record<string, unknown> };
    expect(pending.collapse).toMatchObject({ attempts: 1, collapsedAt: null, episodeId: null });
    expect(String(pending.collapse.lastError)).toMatch(/injected strategy failure/);
    expect(pending.collapse.nextAttemptAt).not.toBeNull();

    const retry = await collapse(sessionId);
    expect(retry.status).toBe(202);

    const afterRetry = await countsFor(sessionId, "L8");
    expect(afterRetry).toMatchObject({
      facts: 2,
      decisions: 1,
      strategies: 1,
      episodes: 1,
      status: "collapsed",
    });
    expect(afterRetry.snapshot?.episodeId).toBeTruthy();
    const unlinked = await pgClient`
      SELECT id FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND session_id = ${sessionId} AND episode_id IS NULL`;
    expect(unlinked).toHaveLength(0);

    const done = (await (
      await app.request(`/session/${sessionId}`, { headers: authed() })
    ).json()) as { collapse: Record<string, unknown> };
    expect(done.collapse).toMatchObject({
      factCount: 2,
      episodeId: afterRetry.snapshot?.episodeId,
      outcome: "resolved",
      // A successful commit clears the error of the failed attempt.
      lastError: null,
    });
    expect(done.collapse.collapsedAt).not.toBeNull();
  });
});

describe("LIFECYCLE-14 — a session the sweep gave up on", () => {
  it("is archived with the reason and still reports it", async () => {
    const sessionId = await startSessionWithTurns();

    await storage.archiveSession!(sessionId, WS, "collapse_failed");

    const body = (await (
      await app.request(`/session/${sessionId}`, { headers: authed() })
    ).json()) as { status: string; collapse: Record<string, unknown> };
    expect(body.status).toBe("archived");
    expect(body.collapse.archiveReason).toBe("collapse_failed");
  });
});

describe("LIFECYCLE-7 — one session, one extraction", () => {
  it("a repeated collapse writes nothing new and does not call the model", async () => {
    const sessionId = await startSessionWithTurns();
    nextReply = extraction("L7seq");

    expect((await collapse(sessionId)).status).toBe(202);
    const callsAfterFirst = llmCalls;
    const second = await collapse(sessionId);

    expect(second.status).toBe(202);
    expect(((await second.json()) as { status: string }).status).toBe("completed");
    expect(llmCalls).toBe(callsAfterFirst);
    expect(await countsFor(sessionId, "L7seq")).toMatchObject({
      facts: 2,
      decisions: 1,
      strategies: 1,
      episodes: 1,
      status: "collapsed",
    });
  });

  it("concurrent collapses of one session commit once", async () => {
    const sessionId = await startSessionWithTurns();
    nextReply = extraction("L7con");

    const responses = await Promise.all([
      collapse(sessionId),
      collapse(sessionId),
      collapse(sessionId),
    ]);

    for (const res of responses) expect(res.status).toBe(202);
    expect(await countsFor(sessionId, "L7con")).toMatchObject({
      facts: 2,
      decisions: 1,
      strategies: 1,
      episodes: 1,
      status: "collapsed",
    });
  });
});

describe("LIFECYCLE-3/4 — topic keys on Postgres", () => {
  it("keeps three distinct facts the model put under one key", async () => {
    const sessionId = await startSessionWithTurns();
    nextReply = {
      goal: "deploy rules",
      outcome: "resolved",
      facts: [
        { content: "ledger-api deploys only on Tuesdays", topicKey: "ledger-api-deploy" },
        { content: "ledger-api deploys need two approvals", topicKey: "ledger-api-deploy" },
        { content: "ledger-api deploys are frozen in December", topicKey: "ledger-api-deploy" },
      ],
      decisions: [],
      strategies: [],
    };

    expect((await collapse(sessionId)).status).toBe(202);

    const rows = await pgClient`
      SELECT statement, topic_key FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND session_id = ${sessionId} AND status = 'active'
      ORDER BY statement`;
    expect(rows.map((r) => r.statement)).toEqual([
      "ledger-api deploys are frozen in December",
      "ledger-api deploys need two approvals",
      "ledger-api deploys only on Tuesdays",
    ]);
    expect(rows.every((r) => r.topic_key === null)).toBe(true);
  });

  it("a keyed value update supersedes the live row bitemporally", async () => {
    const seeded = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "The orders-api rate limit is 300 requests per minute per API key.",
      subject: "orders-api",
      kind: "other",
      confidence: 0.9,
      topicKey: "orders-api-rate-limit",
    });
    const sessionId = await startSessionWithTurns();
    nextReply = {
      goal: "raise the limit",
      outcome: "resolved",
      facts: [
        {
          content: "The orders-api rate limit is 500 requests per minute per API key.",
          topicKey: "orders-api-rate-limit",
        },
      ],
      decisions: [],
      strategies: [],
    };

    expect((await collapse(sessionId)).status).toBe(202);

    const rows = await pgClient`
      SELECT id, statement, status, valid_to FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND topic_key = 'orders-api-rate-limit'
      ORDER BY created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: seeded.id, status: "forgotten" });
    expect(rows[0]!.valid_to).not.toBeNull();
    expect(rows[1]!.status).toBe("active");
    expect(rows[1]!.statement).toContain("500");
    const supersedes = await pgClient`
      SELECT 1 FROM mnemosyne.mnemo_relation
      WHERE workspace_id = ${WS} AND relation = 'supersedes'
        AND source_id = ${rows[1]!.id} AND target_id = ${seeded.id}`;
    expect(supersedes).toHaveLength(1);
  });
});

describe("AGENTSIM-2 — a skipped session's hand-written facts get an episode", () => {
  it("links facts written with the sessionId when the session has no turns", async () => {
    const sessionId = await startSessionWithTurns(0);
    const fact = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "agentsim-2: written by hand with the session id",
      subject: "agentsim",
      kind: "other",
      confidence: 0.9,
      sessionId,
    });

    const res = await collapse(sessionId);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { skipReason?: string }).skipReason).toBe("too_few_turns");

    const [row] = await pgClient`
      SELECT episode_id FROM mnemosyne.mnemo_fact WHERE id = ${fact.id}`;
    expect(row!.episode_id).not.toBeNull();
    const [episode] = await pgClient`
      SELECT source_conversation_id, linked_fact_ids FROM mnemosyne.mnemo_episode
      WHERE id = ${row!.episode_id}`;
    expect(episode!.source_conversation_id).toBe(sessionId);
    const [session] = await pgClient`
      SELECT status FROM mnemosyne.mnemo_session WHERE id = ${sessionId}`;
    expect(session!.status).toBe("archived");
  });
});

describe("collapse → scoped conflict check job on Postgres", () => {
  it("the job appended inside the commit commits and rolls back with it", async () => {
    const job = (sessionId: string) => ({
      workspaceId: WS,
      eventType: "queue_job" as const,
      payload: {
        job: "scoped_semantic_conflict_check",
        data: { factId: sessionId, workspaceId: WS, candidates: [] },
      },
    });
    const jobs = async (sessionId: string) =>
      (
        await pgClient`
          SELECT count(*)::int AS n FROM mnemosyne.mnemo_outbox
          WHERE workspace_id = ${WS} AND payload->'data'->>'factId' = ${sessionId}`
      )[0]!.n as number;

    const rolledBack = await startSessionWithTurns(0);
    await expect(
      storage.commitSessionCollapse!({ workspaceId: WS, sessionId: rolledBack }, async (tx) => {
        await tx.appendOutbox(job(rolledBack));
        throw new Error("injected");
      })
    ).rejects.toThrow("injected");
    expect(await jobs(rolledBack)).toBe(0);

    const committed = await startSessionWithTurns(0);
    const out = await storage.commitSessionCollapse!(
      { workspaceId: WS, sessionId: committed },
      async (tx) => {
        await tx.appendOutbox(job(committed));
      }
    );
    expect(out.committed).toBe(true);
    expect(await jobs(committed)).toBe(1);
  });
});

describe("Review round — skipped-session provenance is atomic and single-winner", () => {
  async function sessionWithHandFacts(tag: string): Promise<string> {
    const sessionId = await startSessionWithTurns(0);
    for (const n of [1, 2]) {
      await storage.createFact({
        workspaceId: WS,
        scope: "global",
        statement: `${tag}: hand-written fact ${n}`,
        subject: tag,
        kind: "other",
        confidence: 0.9,
        sessionId,
      });
    }
    return sessionId;
  }
  const episodesOf = async (sessionId: string) =>
    (
      await pgClient`
        SELECT count(*)::int AS n FROM mnemosyne.mnemo_episode
        WHERE workspace_id = ${WS} AND source_conversation_id = ${sessionId}`
    )[0]!.n as number;

  it("concurrent skips of one session write one episode", async () => {
    const sessionId = await sessionWithHandFacts("race");

    const responses = await Promise.all([
      collapse(sessionId),
      collapse(sessionId),
      collapse(sessionId),
    ]);

    for (const res of responses) expect(res.status).toBe(202);
    expect(await episodesOf(sessionId)).toBe(1);
    const unlinked = await pgClient`
      SELECT id FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND session_id = ${sessionId} AND episode_id IS NULL`;
    expect(unlinked).toHaveLength(0);
    const [session] = await pgClient`
      SELECT status, metadata->>'archiveReason' AS reason FROM mnemosyne.mnemo_session
      WHERE id = ${sessionId}`;
    expect(session).toMatchObject({ status: "archived", reason: "too_few_turns" });
  });

  it("a link failure leaves no orphan episode and the session is still archived", async () => {
    const sessionId = await sessionWithHandFacts("orphan");
    await pgClient.unsafe(`
      CREATE OR REPLACE FUNCTION mnemosyne.test_fail_episode_link() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.episode_id IS NOT NULL AND OLD.episode_id IS NULL THEN
          RAISE EXCEPTION 'injected link failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_episode_link BEFORE UPDATE ON mnemosyne.mnemo_fact
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.test_fail_episode_link();
    `);
    let res: Response;
    try {
      res = await collapse(sessionId);
    } finally {
      await pgClient.unsafe(
        "DROP TRIGGER IF EXISTS test_fail_episode_link ON mnemosyne.mnemo_fact"
      );
    }

    expect(res.status).toBe(202);
    expect(await episodesOf(sessionId)).toBe(0);
    const [session] = await pgClient`
      SELECT status FROM mnemosyne.mnemo_session WHERE id = ${sessionId}`;
    expect(session!.status).toBe("archived");
  });
});

describe("Review round — topic locks in a deterministic order", () => {
  it("two collapses updating the same topics in opposite orders both commit", async () => {
    for (const [key, statement] of [
      ["lock-order-a", "lock-order A is v0"],
      ["lock-order-b", "lock-order B is v0"],
    ] as const) {
      await storage.createFact({
        workspaceId: WS,
        scope: "global",
        statement,
        subject: "lock-order",
        kind: "other",
        confidence: 0.9,
        topicKey: key,
      });
    }
    const s1 = await startSessionWithTurns(4, "marker-session-one");
    const s2 = await startSessionWithTurns(4, "marker-session-two");
    const fact = (key: string, statement: string) => ({ content: statement, topicKey: key });
    replyByMarker = {
      "marker-session-one": {
        goal: "one",
        outcome: "resolved",
        facts: [
          fact("lock-order-a", "lock-order A is v1"),
          fact("lock-order-b", "lock-order B is v1"),
        ],
        decisions: [],
        strategies: [],
      },
      "marker-session-two": {
        goal: "two",
        outcome: "resolved",
        facts: [
          fact("lock-order-b", "lock-order B is v2"),
          fact("lock-order-a", "lock-order A is v2"),
        ],
        decisions: [],
        strategies: [],
      },
    };
    // Widen the window: each successor INSERT holds its topic lock for 300 ms,
    // so without an ordered up-front lock the two commits interleave A/B vs B/A.
    await pgClient.unsafe(`
      CREATE OR REPLACE FUNCTION mnemosyne.test_slow_fact_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$;
      CREATE TRIGGER test_slow_fact_insert BEFORE INSERT ON mnemosyne.mnemo_fact
      FOR EACH ROW EXECUTE FUNCTION mnemosyne.test_slow_fact_insert();
    `);
    let responses: Response[];
    try {
      responses = await Promise.all([collapse(s1), collapse(s2)]);
    } finally {
      replyByMarker = null;
      await pgClient.unsafe("DROP TRIGGER IF EXISTS test_slow_fact_insert ON mnemosyne.mnemo_fact");
    }

    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    const live = await pgClient`
      SELECT topic_key, statement FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND topic_key IN ('lock-order-a', 'lock-order-b')
        AND status = 'active'
      ORDER BY topic_key`;
    expect(live).toHaveLength(2);
    for (const row of live) expect(String(row.statement)).toMatch(/is v[12]$/);
  }, 60_000);
});
