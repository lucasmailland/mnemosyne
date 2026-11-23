/**
 * WP-3 review round — the three relevance holes Codex found, against real
 * Postgres + pgvector with the production adapters (DrizzleStorageAdapter,
 * PgVectorAdapter) behind the real recall facade:
 *
 *   1. hybrid: a decision the lexical arm matched below `minSimilarity` used to
 *      come back as "lexical-only" and skip the floor;
 *   2. the L3 query cache rebuilt a "nothing relevant" answer as a plain
 *      non-empty one on the next identical question;
 *   3. ownership was checked after the semantic window was cut, so a personal
 *      fact ranked below a full window of workspace facts never came back.
 *
 * Requires Docker + Node 22 (testcontainers).
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";
const DIMS = 1536;

let container: StartedTestContainer;
let sql: postgres.Sql;
let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
let vector: import("@mnemo-ai/adapter-vector").PgVectorAdapter;
let createCore: typeof import("@mnemo-ai/core/cognitive").createCore;
let drizzleClose: () => Promise<void>;

/** Unit vector at `cos` from axis 0, leaning on its own `axis` so rows stay distinct. */
function vecAt(cos: number, axis: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[0] = cos;
  v[axis] = Math.sqrt(1 - cos * cos);
  return v;
}
const QUERY = new Float32Array(vecAt(1, 1));

function auth(workspaceId: string, admin = false) {
  return {
    workspaceId,
    actorId: "key:review",
    actorType: "agent",
    userId: null,
    scopes: admin ? ["memory:read", "memory:admin"] : ["memory:read"],
  } as unknown as import("@mnemo-ai/types").AuthContext;
}

function core() {
  const noop = () => undefined;
  return createCore({
    storage,
    vector,
    embed: {
      id: "fixed",
      model: "review-model",
      dimensions: DIMS,
      embed: async (texts: string[]) => texts.map(() => QUERY),
      embedSingle: async () => QUERY,
    } as never,
    outbox: { append: async () => undefined } as never,
    logger: { debug: noop, info: noop, warn: noop, error: noop, fatal: noop } as never,
    telemetry: {
      startSpan: () => ({ setAttribute: noop, setStatus: noop, end: noop }),
      counter: noop,
      histogram: noop,
      gauge: noop,
      shutdown: async () => undefined,
    } as never,
  });
}

async function fact(workspaceId: string, statement: string, embedding: number[], extra = {}) {
  const f = await storage.createFact({
    workspaceId,
    actorId: "key:review",
    scope: "global",
    statement,
    subject: "review",
    kind: "other",
    sensitivity: "internal",
    ...extra,
  } as never);
  await sql`
    UPDATE mnemosyne.mnemo_fact
       SET embedding = ${`[${embedding.join(",")}]`}::public.halfvec, embedding_stale = false
     WHERE id = ${f.id}
  `;
  return f;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
  const { stdout } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(stdout).toContain("Done. Applied:");

  sql = postgres(databaseUrl, { max: 2, onnotice: () => void 0 });
  const [adapterPg, adapterVector, cognitive] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const { db, pgClient } = adapterPg.createDrizzleClient(databaseUrl);
  storage = new adapterPg.DrizzleStorageAdapter(db, pgClient, undefined);
  drizzleClose = () => pgClient.end();
  vector = new adapterVector.PgVectorAdapter({ connectionString: databaseUrl });
  createCore = cognitive.createCore;
}, 180_000);

afterAll(async () => {
  await vector?.close().catch(() => undefined);
  await drizzleClose?.().catch(() => undefined);
  await sql?.end().catch(() => undefined);
  await container?.stop().catch(() => undefined);
});

describe("1 — hybrid: the floor holds for lexical matches", () => {
  const WS = "a1a1a1a1-0001-4001-8001-000000000001";

  it("a decision matched by FTS at cosine 0.4 stays out under minSimilarity 0.9", async () => {
    const relevant = await fact(WS, "Card charges are idempotent per merchant.", vecAt(0.95, 2));
    const weak = await storage.createDecision({
      workspaceId: WS,
      kind: "policy",
      title: "Atlas retries failed card charges three times",
      body: "Exponential backoff between attempts.",
    });
    await storage.updateEmbeddingVector("decision", weak.id, WS, vecAt(0.4, 3), "review-model");
    const mnemo = core();

    const floored = await mnemo.recall(
      {
        workspaceId: WS,
        text: "retry failed card charges",
        mode: "hybrid",
        minSimilarity: 0.9,
        includeLowWorth: true,
      },
      auth(WS)
    );
    expect(floored.hits.map((h) => h.id)).toEqual([relevant.id]);

    const open = await mnemo.recall(
      { workspaceId: WS, text: "retry failed card charges", mode: "hybrid" },
      auth(WS)
    );
    const decisionHit = open.hits.find((h) => h.id === weak.id);
    expect(decisionHit?.similarity).toBeCloseTo(0.4, 2);
  });
});

describe("2 — the L3 query cache keeps the verdict", () => {
  const WS = "a1a1a1a1-0002-4002-8002-000000000002";

  it("below-floor matches answer 'nothing relevant' cold and on the identical repeat", async () => {
    await fact(WS, "The coffee machine on the third floor is broken.", vecAt(0.3, 4));
    const mnemo = core();
    const ask = () =>
      mnemo.recall(
        { workspaceId: WS, text: "who is the CTO", relevanceFloor: 0.5 },
        auth(WS, true)
      );

    const cold = await ask();
    const repeat = await ask();

    expect(cold.hits.length).toBeGreaterThan(0);
    expect(cold.nothingRelevant).toBe(true);
    expect(repeat.nothingRelevant).toBe(true);
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_query_cache WHERE workspace_id = ${WS}
    `;
    expect(n).toBe(0);
  });

  it("a relevant answer is cached, served from cache with cosines re-measured, and re-judged", async () => {
    const WS2 = "a1a1a1a1-0003-4003-8003-000000000003";
    const f = await fact(WS2, "The CTO is Ana Pérez.", vecAt(0.8, 5));
    const mnemo = core();
    const ask = (relevanceFloor: number) =>
      mnemo.recall({ workspaceId: WS2, text: "who is the CTO", relevanceFloor }, auth(WS2, true));

    const cold = await ask(0.5);
    expect(cold.nothingRelevant).toBe(false);
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_query_cache WHERE workspace_id = ${WS2}
    `;
    expect(n).toBe(1);

    const cached = await ask(0.5);
    expect(cached.hits.map((h) => h.id)).toEqual([f.id]);
    expect(cached.hits[0]!.similarity).toBeCloseTo(0.8, 2);
    expect(cached.nothingRelevant).toBe(false);
    expect((await ask(0.9)).nothingRelevant).toBe(true);
  });
});

describe("3 — ownership is filtered before the semantic window is cut", () => {
  const WS = "a1a1a1a1-0004-4004-8004-000000000004";
  const OWNER = "user:review-user";

  it("PgVectorAdapter: a personal fact below a full window of workspace facts still comes back", async () => {
    for (let i = 0; i < 5; i++)
      await fact(WS, `Workspace fact ${i}.`, vecAt(0.9 - i * 0.01, 10 + i));
    const mine = await fact(WS, "My laptop is a MacBook Pro.", vecAt(0.5, 20), {
      scopeOwner: OWNER,
    });

    const window = await vector.search({ workspaceId: WS, vector: QUERY, limit: 3 });
    expect(window.map((h) => h.id)).not.toContain(mine.id);

    const owned = await vector.search({
      workspaceId: WS,
      vector: QUERY,
      limit: 3,
      filter: { scopeOwner: OWNER },
    });
    expect(owned.map((h) => h.id)).toEqual([mine.id]);
  });

  it("recallableCandidates: the same, for decisions", async () => {
    for (let i = 0; i < 3; i++) {
      const d = await storage.createDecision({
        workspaceId: WS,
        kind: "policy",
        title: `Workspace decision ${i}`,
        body: "about laptops",
      });
      await storage.updateEmbeddingVector("decision", d.id, WS, vecAt(0.9, 30 + i), "review-model");
    }
    const mine = await storage.createDecision({
      workspaceId: WS,
      kind: "policy",
      title: "I buy my own laptops",
      body: "personal decision",
      scopeOwner: OWNER,
    });
    await storage.updateEmbeddingVector("decision", mine.id, WS, vecAt(0.5, 40), "review-model");

    const rows = await storage.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 2,
      embedding: Array.from(QUERY),
      terms: ["laptops"],
      scopeOwner: OWNER,
    });
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it("end to end: a personal-only recall returns the personal fact", async () => {
    const res = await core().recall(
      { workspaceId: WS, text: "what laptop do I use", limit: 1, filter: { scopeOwner: OWNER } },
      auth(WS)
    );
    expect(res.hits[0]?.scopeOwner).toBe(OWNER);
  });
});
