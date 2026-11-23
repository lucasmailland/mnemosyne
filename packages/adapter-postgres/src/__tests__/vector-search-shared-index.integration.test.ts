/**
 * Q-2 (verify-recall) — semantic recall in a shared database, as the
 * NOSUPERUSER NOBYPASSRLS application role production runs as.
 *
 * The HNSW index on mnemo_fact is global: workspace isolation (RLS plus the
 * explicit workspace_id predicate) filters rows AFTER the index returned its
 * ef_search candidates. When other workspaces own the nearest vectors, the
 * caller's workspace got fewer than `limit` hits, or none. PgVectorAdapter now
 * enables hnsw.iterative_scan for every search (pgvector >= 0.8) and raises
 * ef_search on older versions.
 *
 * Requires Docker + Node 22 (testcontainers).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { PgVectorAdapter } from "../../../adapter-vector/src/PgVectorAdapter.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "shared_index_app";
const APP_PASS = "shared_index_app_pass";
const WS_A = "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7";
const WS_B = "b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7";
const DIM = 1536;
const TOP_K = 25;
const A_FACTS = 40;
const B_FACTS = 600;

let container: StartedTestContainer;
let appUrl: string;
let superSql: ReturnType<typeof postgres>;
let superClient: ReturnType<typeof createDrizzleClient>;
let seeder: DrizzleStorageAdapter;
const adapters: PgVectorAdapter[] = [];

/** The query vector: e0. Workspace B sits at cosine ~0.99, workspace A at ~0.45. */
function query(): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = 1;
  return v;
}
/** Deterministic PRNG so the fixture (and the HNSW graph) is the same on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
/**
 * A unit vector whose cosine to e0 is `along`; the rest is random noise over a
 * 32-dim subspace, so the HNSW graph stays connected like real embeddings
 * (pairwise-orthogonal noise would make A's nodes unreachable from B's).
 */
function near(random: () => number, along: number): number[] {
  const noise = Array.from({ length: 32 }, () => random() - 0.5);
  const norm = Math.hypot(...noise);
  const v = new Array<number>(DIM).fill(0);
  v[0] = along;
  const rest = Math.sqrt(1 - along * along);
  noise.forEach((n, i) => (v[1 + i] = (n / norm) * rest));
  return v;
}

async function seed(workspaceId: string, count: number, along: number, seedNo: number) {
  const ids: string[] = [];
  const batch = 25;
  for (let start = 0; start < count; start += batch) {
    const made = await Promise.all(
      Array.from({ length: Math.min(batch, count - start) }, (_, k) =>
        seeder.createFact({
          workspaceId,
          scope: "global",
          statement: `shared-index fixture ${workspaceId.slice(0, 2)} ${start + k}`,
          subject: `fixture-${start + k}`,
          kind: "other",
        } as never)
      )
    );
    ids.push(...made.map((f) => f.id));
  }
  // createFact leaves embeddings to the outbox; write them directly.
  const random = rng(seedNo);
  const literals = ids.map((_, i) => `[${near(random, along - (i % 7) * 0.0005).join(",")}]`);
  await superSql`
    UPDATE mnemosyne.mnemo_fact f
       SET embedding = v.e::halfvec, embedding_stale = false
      FROM unnest(${ids}::text[], ${literals}::text[]) AS v(id, e)
     WHERE f.id = v.id`;
}

function makeAdapter(extra: Record<string, unknown> = {}): PgVectorAdapter {
  const a = new PgVectorAdapter({ connectionString: appUrl, ...extra });
  adapters.push(a);
  return a;
}

async function searchA(a: PgVectorAdapter) {
  return a.search({ workspaceId: WS_A, vector: query(), limit: TOP_K, minSimilarity: 0 });
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);
  superClient = createDrizzleClient(superUrl);
  seeder = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);

  // A is far from the query; B (many rows) is right on top of it.
  await seed(WS_A, A_FACTS, 0.45, 1);
  await seed(WS_B, B_FACTS, 0.99, 2);
  await superSql`ANALYZE mnemosyne.mnemo_fact`;
}, 300_000);

afterAll(async () => {
  await Promise.all(adapters.map((a) => a.close().catch(() => void 0)));
  await superClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("Q-2 — workspace-filtered vector search over a shared HNSW index", () => {
  it("fixture: workspace B really owns the nearest vectors", async () => {
    const rows = await superSql<Array<{ workspace_id: string }>>`
      SELECT workspace_id FROM mnemosyne.mnemo_fact
       WHERE embedding IS NOT NULL
       ORDER BY embedding::halfvec(1536) <=> ${`[${Array.from(query()).join(",")}]`}::halfvec(1536)
       LIMIT 100`;
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("returns the caller's full top-K although another workspace is nearer", async () => {
    const hits = await searchA(makeAdapter());
    expect(hits).toHaveLength(TOP_K);
    // strict_order keeps the ranking exact up to the index's float4 distances.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score + 1e-4);
    }
  });

  it("returns the full top-K with an kind scope too", async () => {
    const hits = await makeAdapter().search({
      workspaceId: WS_A,
      vector: query(),
      limit: TOP_K,
      minSimilarity: 0,
      filter: { primitiveKind: "other" },
    });
    expect(hits).toHaveLength(TOP_K);
  });

  it("never leaks workspace B's rows", async () => {
    const hits = await makeAdapter().search({
      workspaceId: WS_A,
      vector: query(),
      limit: A_FACTS + 10,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(A_FACTS);
  });

  it("pgvector < 0.8 fallback (iterativeScan: false) raises ef_search and still fills top-K", async () => {
    const hits = await searchA(makeAdapter({ iterativeScan: false }));
    expect(hits).toHaveLength(TOP_K);
  });

  it("latency: filtered search stays interactive (timings logged)", async () => {
    const a = makeAdapter();
    await searchA(a);
    const t0 = performance.now();
    const runs = 10;
    for (let i = 0; i < runs; i++) await searchA(a);
    const ms = (performance.now() - t0) / runs;
    console.log(`[Q-2] mean filtered search latency: ${ms.toFixed(1)} ms over ${runs} runs`);
    expect(ms).toBeLessThan(500);
  });
});
