/**
 * Regression test for migrations 0009 (halfvec unconstrain) + 0010
 * (dimension-scoped HNSW restoration).
 *
 * A fresh database must migrate the full baseline chain cleanly and accept BOTH 1536
 * (OpenAI text-embedding-3-small) and 1024 (Bedrock Titan/Cohere) embeddings
 * in mnemo_fact.embedding, with a dimension-scoped partial HNSW index
 * covering each dimension. This is exactly the failure mode that has shipped
 * before (F4 matview crash, episode column gap): migrations that only work
 * on already-patched databases, never proven against a truly fresh install.
 *
 * Requires Docker. This file is *.integration.test.ts, which the default
 * `test` script (vitest.config.ts) EXCLUDES — `pnpm --filter
 * @mnemo-ai/adapter-postgres test -- fresh-install-migrate` exits green
 * having run ZERO tests. Run it via the dedicated integration config
 * instead, same as every other `*.integration.test.ts` file in this
 * directory:
 *   pnpm --filter @mnemo-ai/adapter-postgres test:integration -- fresh-install-migrate
 * or directly:
 *   pnpm exec vitest run --config vitest.integration.config.ts fresh-install-migrate
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { migrate } from "../migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__ -> packages/adapter-postgres -> packages -> repo root -> packages/core
const CORE_MIGRATE_CLI = resolve(__dirname, "..", "..", "..", "core", "dist", "migrate.js");
const BASELINE_MIGRATIONS_DIR = resolve(__dirname, "..", "..", "migrations", "baseline");
// Counted at test-run time, not hardcoded — this file's own assertion used to
// read a hardcoded `15`, silently stale since migration 0016 (found while
// running the full integration suite after the multi-tenancy closure plan
// added 0022; migrations 0016-0021 had already been added since without this
// test ever being updated, so it was failing well before 0022 existed).
//
// Excludes `*.down.sql` rollback files — same rule migrate.ts's own
// `listMigrationFilenames()` applies. Surfaced by flatten-legacy-dual-core
// Slice 1 pt.2's migration 0028, the first adapter-postgres baseline
// migration to ship a `.down.sql`: `"0028_narrow_fact_scope_check.down.sql".endsWith(".sql")`
// is also true, so the unfiltered count silently included the down file and
// this test failed (28 applied vs. 29 "expected") — not `migrate()`'s bug,
// this assertion's own filter was too loose.
const EXPECTED_BASELINE_MIGRATION_COUNT = readdirSync(BASELINE_MIGRATIONS_DIR).filter(
  (f) => f.endsWith(".sql") && !f.endsWith(".down.sql")
).length;

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;
let raw: ReturnType<typeof postgres>;

const WS = "ffffffff-ffff-4fff-ffff-ffffffffffff";

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });

  raw = postgres(databaseUrl, { onnotice: () => void 0, max: 3 });
}, 120_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("fresh install: full migrate chain (0001->latest)", () => {
  it("runs the full baseline migration chain on a clean database", async () => {
    // migrate() in beforeAll already resolved without throwing — this
    // asserts the tracking table agrees: every baseline migration file is
    // recorded exactly once (no skips, no partial/failed rows left behind
    // by a rolled-back transaction). Compared against the actual file
    // count, not a hardcoded number, so this can't go stale again as new
    // migrations are added.
    const rows = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM mnemosyne.schema_migrations
    `;
    expect(rows[0]?.count).toBe(EXPECTED_BASELINE_MIGRATION_COUNT);
  });

  it("mnemo_fact.embedding accepts 1536 and 1024 vectors after migrate", async () => {
    await raw`
      INSERT INTO mnemosyne.mnemo_fact
        (id, workspace_id, scope, kind, subject, statement, embedding)
      VALUES
        ('fact-1536-fresh-install', ${WS}, 'global', 'preference', 'probe-subject',
         'fact-1536', array_fill(0.1, ARRAY[1536])::public.halfvec)
    `;
    await raw`
      INSERT INTO mnemosyne.mnemo_fact
        (id, workspace_id, scope, kind, subject, statement, embedding)
      VALUES
        ('fact-1024-fresh-install', ${WS}, 'global', 'preference', 'probe-subject',
         'fact-1024', array_fill(0.2, ARRAY[1024])::public.halfvec)
    `;

    const rows = await raw<Array<{ id: string; dims: number }>>`
      SELECT id, public.vector_dims(embedding) AS dims
      FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS}
      ORDER BY id
    `;

    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r.dims]));
    expect(byId.get("fact-1024-fresh-install")).toBe(1024);
    expect(byId.get("fact-1536-fresh-install")).toBe(1536);
  });

  it("mnemo_embedding_cache.embedding accepts 1536 and 1024 vectors after migrate", async () => {
    // Migration 0009 unconstrained every `mnemo_*` embedding column to a bare
    // `halfvec` so a workspace can pick its own model width. One table was
    // missed: `mnemo_embedding_cache.embedding` stayed `halfvec(1536)`, still
    // carrying the shape 0001 gave it.
    //
    // The consequence is invisible rather than loud. `putCachedEmbedding` is
    // called behind `.catch(reportCacheFailure)`, so on a 1024-width model
    // (bge-m3, Titan, Cohere) every write raised a dimension error, was
    // swallowed as "cache operation failed — degrading to uncached path", and
    // the L3 embedding LRU silently never stored a single row. Measured on a
    // live bge-m3 stack: `SELECT count(*) FROM mnemo_embedding_cache` = 0
    // after hundreds of recalls, each one paying a full embed round-trip.
    await raw`
      INSERT INTO mnemosyne.mnemo_embedding_cache
        (id, workspace_id, text_hash, embedding, model)
      VALUES
        (gen_random_uuid(), ${WS}, 'hash-1536',
         array_fill(0.1, ARRAY[1536])::public.halfvec, 'text-embedding-3-small')
    `;
    await raw`
      INSERT INTO mnemosyne.mnemo_embedding_cache
        (id, workspace_id, text_hash, embedding, model)
      VALUES
        (gen_random_uuid(), ${WS}, 'hash-1024',
         array_fill(0.2, ARRAY[1024])::public.halfvec, 'bge-m3')
    `;

    const rows = await raw<Array<{ text_hash: string; dims: number }>>`
      SELECT text_hash, public.vector_dims(embedding) AS dims
      FROM mnemosyne.mnemo_embedding_cache
      WHERE workspace_id = ${WS}
      ORDER BY text_hash
    `;

    const byHash = new Map(rows.map((r) => [r.text_hash, r.dims]));
    expect(byHash.get("hash-1024")).toBe(1024);
    expect(byHash.get("hash-1536")).toBe(1536);
  });

  it("dimension-scoped HNSW indexes exist and only those", async () => {
    const rows = await raw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'mnemosyne' AND indexname LIKE '%hnsw%'
      ORDER BY 1
    `;

    expect(rows.map((r) => r.indexname)).toEqual([
      "idx_fact_emb_1024_hnsw",
      "idx_fact_emb_1536_hnsw",
      "idx_mnemo_fact_embedding_hnsw_1024",
      "idx_mnemo_fact_embedding_hnsw_1536",
    ]);
  });

  // ── EXPLAIN regression pin ──────────────────────────────────────────────────
  //
  // The previous two tests prove the indexes exist and that both dimensions
  // are insertable — neither proves the planner actually USES the indexes
  // for a query shaped the way PgVectorAdapter.search() emits it
  // (dimension-typed ::halfvec(N) casts + a literal-spliced
  // vector_dims(embedding) = N predicate; see PgVectorAdapter.ts and its
  // "splice as literal, not a bind parameter" comment). That planner-usage
  // claim was previously only verified by hand (commit 3e7f5e5d and the
  // plan file's manual psql EXPLAIN transcript) — never pinned by a test. If
  // postgres.js's cast-emission behaviour, the connection's search_path, or
  // a future Postgres/pgvector version ever changes how this expression
  // resolves, recall silently regresses to a sequential scan (still
  // functionally correct, just unindexed) with every other test in this
  // suite staying green, since none of them assert on the query PLAN.
  //
  // Depends on the two rows inserted by the "accepts 1536 and 1024" test
  // above (same container, same describe block, vitest runs `it`s within a
  // file sequentially by default) — EXPLAIN's index choice doesn't strictly
  // require matching rows to exist, but having them present exercises the
  // real end-to-end shape rather than an empty-table edge case.
  //
  // `enable_seqscan = off` is set SET LOCAL inside an explicit transaction
  // (mirroring how PgVectorAdapter itself scopes GUCs to one query via
  // `sql.begin`) so it never leaks into other tests/connections in the pool.

  function halfvecLiteral(dimensions: number, fill: number): string {
    return `[${Array(dimensions).fill(fill).join(",")}]`;
  }

  it("planner uses idx_mnemo_fact_embedding_hnsw_1536 for a 1536-dim adapter-shaped query (EXPLAIN)", async () => {
    const literal = halfvecLiteral(1536, 0.1);

    const plan = await raw.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      return tx<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN (COSTS OFF) SELECT id FROM mnemosyne.mnemo_fact
        WHERE public.vector_dims(embedding) = 1536
        ORDER BY (embedding::public.halfvec(1536)) <=> ${literal}::public.halfvec(1536)
        LIMIT 5
      `;
    });

    const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(planText).toContain("idx_mnemo_fact_embedding_hnsw_1536");
  });

  it("planner uses idx_mnemo_fact_embedding_hnsw_1024 for a 1024-dim adapter-shaped query (EXPLAIN)", async () => {
    const literal = halfvecLiteral(1024, 0.2);

    const plan = await raw.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      return tx<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN (COSTS OFF) SELECT id FROM mnemosyne.mnemo_fact
        WHERE public.vector_dims(embedding) = 1024
        ORDER BY (embedding::public.halfvec(1024)) <=> ${literal}::public.halfvec(1024)
        LIMIT 5
      `;
    });

    const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(planText).toContain("idx_mnemo_fact_embedding_hnsw_1024");
  });
});

// ── DB-3: the real production migration order ────────────────────────────────
//
// Every test above (and the beforeAll for this whole file) runs ONLY
// adapter-postgres's own migrations. Real prod also runs packages/core's
// migrations first (see docker/Dockerfile.migrate: "applies BOTH migration
// streams the dual-core runtime needs"). That matters here specifically:
// 0001_v3_complete_baseline.sql's conditional GRANT on
// public.mnemo_semantic_neighbor (created by core migration 0073, not by
// anything in adapter-postgres) checks `IF EXISTS` and silently no-ops when
// the table isn't there yet — which is every test above, since they never run
// core's migrations. That conditional is correct in production (core always
// runs first) but was never actually proven against the real ordering by any
// test — a regression in either stream's ordering assumption would ship
// undetected. This block runs BOTH streams, in production order, against a
// separate fresh container.
describe("fresh install: full prod migrate order (core -> adapter-postgres)", () => {
  let prodContainer: StartedTestContainer;
  let prodSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    prodContainer = await new GenericContainer(PG_IMAGE)
      .withEnvironment({
        POSTGRES_USER: PG_USER,
        POSTGRES_PASSWORD: PG_PASSWORD,
        POSTGRES_DB: PG_DB,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    const host = prodContainer.getHost();
    const port = prodContainer.getMappedPort(5432);
    const prodDatabaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

    // 1. Core migrations first, via the built CLI (production fidelity — same
    //    invocation docker/Dockerfile.migrate uses).
    try {
      execFileSync("node", [CORE_MIGRATE_CLI, "--database-url", prodDatabaseUrl], {
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(
        `core migrate CLI exited non-zero:\n--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? ""}\n${e.message}`
      );
    }

    // 2. Then adapter-postgres's migrations.
    await migrate({ databaseUrl: prodDatabaseUrl, log: () => void 0 });

    prodSql = postgres(prodDatabaseUrl, { onnotice: () => void 0, max: 3 });
  }, 120_000);

  afterAll(async () => {
    await prodSql?.end().catch(() => void 0);
    await prodContainer?.stop().catch(() => void 0);
  });

  it("public.mnemo_semantic_neighbor exists (created by core)", async () => {
    const rows = await prodSql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'mnemo_semantic_neighbor'
      ) AS exists
    `;
    expect(rows[0]?.exists).toBe(true);
  });

  it("mnemo_app_role has DML grants on public.mnemo_semantic_neighbor (adapter-postgres's conditional GRANT fired)", async () => {
    const rows = await prodSql<Array<{ privilege: boolean }>>`
      SELECT has_table_privilege('mnemo_app_role', 'public.mnemo_semantic_neighbor', 'SELECT') AS privilege
    `;
    expect(rows[0]?.privilege).toBe(true);
  });
});
