/**
 * Integration test: P59 — real-Postgres regression proof for the repaired L3
 * query-result cache (`FactRepository.lookupQueryCache` / `insertQueryCache`).
 *
 * Before this test existed, no test had ever executed this SQL against real
 * Postgres. The broken statements referenced columns that never existed on
 * the physical `mnemo_query_cache` table (`query_hash`/`embedding`/
 * `result_ids`/`result_kinds`/`expires_at`) and raised `column ... does not
 * exist` on every invocation since the legacy `0022` migration — invisible
 * because the call sites swallowed the error with `.catch(() => null)` and
 * unit tests only ever exercised `InMemoryStorageAdapter`, which mirrored the
 * fictional shape. This file is the required regression proof design.md
 * calls out (§Testing Strategy) — it fails loudly on any non-existent
 * column, wrong cast, or NOT NULL violation.
 *
 * Requires Docker + Node >=22 — see CLAUDE.md "Node version" note and
 * decision-topic-key.integration.test.ts / fact-lsh.integration.test.ts for
 * the same testcontainers pattern this file mirrors.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;
let rawSql: postgres.Sql;

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
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
  rawSql = postgres(databaseUrl, { connection: { search_path: "mnemosyne,public" } });
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await rawSql?.end();
  await container?.stop();
});

/**
 * `mnemo_query_cache.query_embedding` is a dimensionless `halfvec` (D4) —
 * the length is what the guard operates on, not any particular dimension
 * count, so most tests below use a small deterministic dimension for speed.
 * Every component is set to `value`, which keeps cosine math predictable:
 * two vectors built with the same `value` have cosine 1; `value`/`-value`
 * have cosine -1.
 */
function makeEmbedding(dim: number, value = 1): Float32Array {
  return new Float32Array(dim).fill(value);
}

function vectorLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(",")}]`;
}

describe("FactRepository L3 query cache — real Postgres (P59 regression proof)", () => {
  const DIM = 8;

  it("insertQueryCache writes a row against the real columns — no 'column does not exist'", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);

    await expect(
      adapter.insertQueryCache({
        workspaceId,
        embedding,
        resultIds: ["fact-1", "fact-2"],
        resultKinds: ["fact", "fact"],
        topK: 10,
      })
    ).resolves.toBeUndefined();

    const [row] = await rawSql<
      Array<{
        top_k: number;
        scope: string | null;
        scope_ref: string | null;
        agent_id: string | null;
        hit_count: number;
        result_memory_ids: string[];
        result_memory_kinds: string[];
      }>
    >`
      SELECT top_k, scope, scope_ref, agent_id, hit_count, result_memory_ids, result_memory_kinds
      FROM mnemosyne.mnemo_query_cache
      WHERE workspace_id = ${workspaceId}
    `;
    expect(row).toMatchObject({
      top_k: 10,
      scope: "global",
      scope_ref: null,
      agent_id: null,
      hit_count: 1,
      result_memory_ids: ["fact-1", "fact-2"],
      result_memory_kinds: ["fact", "fact"],
    });
  });

  it("lookupQueryCache returns a hit for a matching query within the freshness window", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);

    await adapter.insertQueryCache({
      workspaceId,
      embedding,
      resultIds: ["fact-a"],
      resultKinds: ["fact"],
      topK: 10,
    });

    const hit = await adapter.lookupQueryCache({
      workspaceId,
      embedding,
      threshold: 0.95,
      topK: 10,
      maxAgeMs: 300_000,
    });

    expect(hit).toEqual({ resultIds: ["fact-a"], resultKinds: ["fact"] });
  });

  it("cosine threshold: a below-0.95 embedding misses, a >=0.95 embedding hits", async () => {
    const workspaceId = crypto.randomUUID();
    const stored = makeEmbedding(DIM, 1);

    await adapter.insertQueryCache({
      workspaceId,
      embedding: stored,
      resultIds: ["fact-cos"],
      resultKinds: ["fact"],
      topK: 10,
    });

    const farQuery = makeEmbedding(DIM, -1); // cosine = -1 vs. stored
    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding: farQuery,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toBeNull();

    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding: stored,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toEqual({ resultIds: ["fact-cos"], resultKinds: ["fact"] });
  });

  it("ages a row out of the 5-minute freshness window — no hit outside it", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);

    await adapter.insertQueryCache({
      workspaceId,
      embedding,
      resultIds: ["fact-stale"],
      resultKinds: ["fact"],
      topK: 10,
    });

    // insertQueryCache always writes last_used_at = now() (D6: insert-only,
    // so last_used_at === created_at at write time). Directly age the row
    // past L3_MAX_AGE_MS (300_000ms / 5 min, D5).
    await rawSql`
      UPDATE mnemosyne.mnemo_query_cache
      SET last_used_at = now() - interval '10 minutes'
      WHERE workspace_id = ${workspaceId}
    `;

    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toBeNull();
  });

  it("topK is matched exactly — a top_k=10 row never serves a topK:5 lookup", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);

    await adapter.insertQueryCache({
      workspaceId,
      embedding,
      resultIds: ["fact-topk"],
      resultKinds: ["fact"],
      topK: 10,
    });

    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding,
        threshold: 0.95,
        topK: 5,
        maxAgeMs: 300_000,
      })
    ).resolves.toBeNull();

    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toEqual({ resultIds: ["fact-topk"], resultKinds: ["fact"] });
  });

  it("D4 dimension guard: a 1536-dim and a 1024-dim row coexist without a 'different halfvec dimensions' error", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding1536 = makeEmbedding(1536, 1);
    const embedding1024 = makeEmbedding(1024, 1);

    await adapter.insertQueryCache({
      workspaceId,
      embedding: embedding1536,
      resultIds: ["fact-1536"],
      resultKinds: ["fact"],
      topK: 10,
    });
    await adapter.insertQueryCache({
      workspaceId,
      embedding: embedding1024,
      resultIds: ["fact-1024"],
      resultKinds: ["fact"],
      topK: 10,
    });

    // Neither lookup raises "different halfvec dimensions N and M" — the
    // public.vector_dims(query_embedding) = $dims predicate excludes the
    // other row from the distance comparison entirely.
    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding: embedding1536,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toEqual({ resultIds: ["fact-1536"], resultKinds: ["fact"] });

    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding: embedding1024,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toEqual({ resultIds: ["fact-1024"], resultKinds: ["fact"] });
  });

  it("D9 fail-closed: a manually inserted agent-owned/scope-owned row is never returned", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);
    const literal = vectorLiteral(embedding);

    // Simulates a future writer that populates scope/agent_id — today's
    // lookup predicate (scope='global' AND scope_ref IS NULL AND
    // agent_id IS NULL) must fail closed against it (design.md D9).
    await rawSql.unsafe(`
      INSERT INTO mnemosyne.mnemo_query_cache
        (id, workspace_id, query_embedding, result_memory_ids, result_memory_kinds,
         scope, scope_ref, agent_id, top_k)
      VALUES
        ('${crypto.randomUUID()}', '${workspaceId}', '${literal}'::halfvec,
         ARRAY['fact-agent-owned'], ARRAY['fact'], 'conversation', NULL, 'agent-x', 10)
    `);

    await expect(
      adapter.lookupQueryCache({
        workspaceId,
        embedding,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toBeNull();
  });

  it("insert-only: two identical writes create two rows, never an upsert", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);
    const input = {
      workspaceId,
      embedding,
      resultIds: ["fact-dup"],
      resultKinds: ["fact"],
      topK: 10,
    };

    await adapter.insertQueryCache(input);
    await adapter.insertQueryCache(input);

    const [row] = await rawSql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_query_cache
      WHERE workspace_id = ${workspaceId}
    `;
    expect(row?.count).toBe(2);
  });

  it("replaceFact's workspace-wide bust still empties the workspace's cache rows", async () => {
    const workspaceId = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);

    const source = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "L3 cache bust source",
      subject: "l3-cache-bust",
      kind: "other",
      sensitivity: "internal",
    });

    await adapter.insertQueryCache({
      workspaceId,
      embedding,
      resultIds: [source.id],
      resultKinds: ["fact"],
      topK: 10,
    });

    const [before] = await rawSql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_query_cache
      WHERE workspace_id = ${workspaceId}
    `;
    expect(before?.count).toBe(1);

    await adapter.replaceFact({
      id: source.id,
      workspaceId,
      statement: "L3 cache bust source, replaced",
      requestedBy: "user-1",
    });

    const [after] = await rawSql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_query_cache
      WHERE workspace_id = ${workspaceId}
    `;
    expect(after?.count).toBe(0);
  });

  it("workspace isolation: an identical query in a different workspace never returns another workspace's entry", async () => {
    const workspaceA = crypto.randomUUID();
    const workspaceB = crypto.randomUUID();
    const embedding = makeEmbedding(DIM, 1);

    await adapter.insertQueryCache({
      workspaceId: workspaceA,
      embedding,
      resultIds: ["fact-ws-a"],
      resultKinds: ["fact"],
      topK: 10,
    });

    await expect(
      adapter.lookupQueryCache({
        workspaceId: workspaceB,
        embedding,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toBeNull();

    await expect(
      adapter.lookupQueryCache({
        workspaceId: workspaceA,
        embedding,
        threshold: 0.95,
        topK: 10,
        maxAgeMs: 300_000,
      })
    ).resolves.toEqual({ resultIds: ["fact-ws-a"], resultKinds: ["fact"] });
  });
});
