/**
 * flatten-legacy-dual-core PR9g (design.md D6.5) — real-Postgres proof for
 * `GraphRepository.backfillSemanticNeighbors` (`DrizzleStorageAdapter`'s
 * `StorageAdapter.backfillSemanticNeighbors`): the adapter-side, set-based
 * `INSERT ... JOIN LATERAL` kNN backfill over `mnemo_fact.embedding`'s HNSW
 * index, ported verbatim from legacy `core/src/graph/semantic-neighbors.ts`.
 *
 * Runs BOTH migration streams in production order (core, then
 * adapter-postgres — see `docker/Dockerfile.migrate` and
 * `fresh-install-migrate.integration.test.ts`'s "full prod migrate order"
 * block), because `public.mnemo_semantic_neighbor` is created by the LEGACY
 * core migration stream (`core/migrations/0073_mnemo_semantic_neighbor.sql`)
 * — adapter-postgres's own baseline (0001) only conditionally GRANTs DML on
 * it `IF EXISTS`, it never creates the table. This is the schema-location
 * verdict `StorageAdapter.backfillSemanticNeighbors`'s doc comment
 * (`@mnemo-ai/types/ports.ts`) documents in full.
 *
 * Proves:
 *   1. Near-duplicate embedded facts get linked, orthogonal ones don't
 *      (threshold-gated).
 *   2. The write is idempotent — repeated backfills reproduce the identical
 *      edge set (delete-then-insert, `ON CONFLICT ... DO UPDATE`).
 *   3. `getGraphSnapshot(includeSemantic: true)`'s pre-existing read side
 *      (PR9f's `loadSemanticEdges`) sees exactly what this PR's write side
 *      just wrote — a full round trip against real Postgres.
 *   4. Workspace isolation — a backfill in one workspace never touches
 *      another's rows.
 *
 * Prerequisites: Docker daemon running, `@mnemo-ai/core` built (`pnpm build`
 * from the repo root) — this test invokes core's built migrate CLI directly.
 * Run with: pnpm --filter @mnemo-ai/adapter-postgres test:integration
 * (Node 22 required — testcontainers/undici; see CLAUDE.md.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__ -> packages/adapter-postgres -> packages -> repo root -> packages/core
const CORE_MIGRATE_CLI = resolve(__dirname, "..", "..", "..", "core", "dist", "migrate.js");

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;

function v3Adapter() {
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  return { adapter: new DrizzleStorageAdapter(db, pgClient), pgClient };
}

let wsCounter = 0;
function freshWorkspaceId(): string {
  wsCounter++;
  return `00000000-0000-0000-0000-${String(wsCounter).padStart(12, "0")}`;
}

function halfvecLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * `mnemo_fact.embedding` is a fixed `halfvec(1536)` column — build full
 * 1536-dim vectors with a single distinguishing pivot dimension so cosine is
 * still trivial to reason about by hand.
 */
function embed1536(pivot: number): number[] {
  const v = new Array(1536).fill(0);
  v[0] = pivot;
  return v;
}
const BASE = embed1536(1);
const NEAR = (() => {
  const v = embed1536(0.99);
  v[1] = 0.14; // cosine(BASE, NEAR) ~ 0.99
  return v;
})();
const ORTHOGONAL = (() => {
  const v = new Array(1536).fill(0);
  v[5] = 1;
  return v;
})();

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  // Production order: core's migrations first (creates public.mnemo_semantic_neighbor),
  // then adapter-postgres's baseline (grants mnemo_app_role DML on it).
  execFileSync("node", [CORE_MIGRATE_CLI, "--database-url", databaseUrl], {
    stdio: "pipe",
    encoding: "utf8",
  });
  await migrate({ databaseUrl, log: () => void 0 });
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

async function seedEmbeddedFacts(
  adapter: ReturnType<typeof v3Adapter>["adapter"],
  pgClient: ReturnType<typeof v3Adapter>["pgClient"],
  ws: string
) {
  const ea = await adapter.createEntity({ workspaceId: ws, name: "EA", kind: "concept" });
  const eb = await adapter.createEntity({ workspaceId: ws, name: "EB", kind: "concept" });
  const ec = await adapter.createEntity({ workspaceId: ws, name: "EC", kind: "concept" });

  const fa = await adapter.createFact({
    workspaceId: ws,
    scope: "global",
    statement: "fact a",
    subject: "s",
    kind: "trait",
    entityId: ea.id,
  });
  const fb = await adapter.createFact({
    workspaceId: ws,
    scope: "global",
    statement: "fact b",
    subject: "s",
    kind: "trait",
    entityId: eb.id,
  });
  const fc = await adapter.createFact({
    workspaceId: ws,
    scope: "global",
    statement: "fact c",
    subject: "s",
    kind: "trait",
    entityId: ec.id,
  });

  await pgClient.unsafe(
    `UPDATE mnemosyne.mnemo_fact SET embedding = $1::public.halfvec WHERE id = $2`,
    [halfvecLiteral(BASE), fa.id]
  );
  await pgClient.unsafe(
    `UPDATE mnemosyne.mnemo_fact SET embedding = $1::public.halfvec WHERE id = $2`,
    [halfvecLiteral(NEAR), fb.id]
  );
  await pgClient.unsafe(
    `UPDATE mnemosyne.mnemo_fact SET embedding = $1::public.halfvec WHERE id = $2`,
    [halfvecLiteral(ORTHOGONAL), fc.id]
  );

  return { ea, eb, ec, fa, fb, fc };
}

describe("backfillSemanticNeighbors — real Postgres kNN over mnemo_fact.embedding", () => {
  it("links near-duplicate facts, excludes orthogonal ones below threshold", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();
    const { fa, fb, fc } = await seedEmbeddedFacts(adapter, pgClient, ws);

    const written = await adapter.backfillSemanticNeighbors({
      workspaceId: ws,
      k: 8,
      threshold: 0.75,
    });
    expect(written).toBe(2); // fa->fb and fb->fa; fc pairs stay below threshold both ways

    const rows = await pgClient<Array<{ s: string; t: string }>>`
      SELECT source_fact_id AS s, target_fact_id AS t
      FROM public.mnemo_semantic_neighbor
      WHERE workspace_id = ${ws}::uuid
    `;
    const pairs = new Set(rows.map((r) => [r.s, r.t].sort().join("|")));
    expect(pairs.has([fa.id, fb.id].sort().join("|"))).toBe(true);
    expect(pairs.has([fa.id, fc.id].sort().join("|"))).toBe(false);
    expect(pairs.has([fb.id, fc.id].sort().join("|"))).toBe(false);
  });

  it("is idempotent across repeated backfills (delete-then-insert reproduces the identical edge set)", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();
    await seedEmbeddedFacts(adapter, pgClient, ws);

    const first = await adapter.backfillSemanticNeighbors({
      workspaceId: ws,
      k: 8,
      threshold: 0.75,
    });
    const rowsAfterFirst = await pgClient<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM public.mnemo_semantic_neighbor WHERE workspace_id = ${ws}::uuid
    `;

    const second = await adapter.backfillSemanticNeighbors({
      workspaceId: ws,
      k: 8,
      threshold: 0.75,
    });
    const rowsAfterSecond = await pgClient<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM public.mnemo_semantic_neighbor WHERE workspace_id = ${ws}::uuid
    `;

    expect(second).toBe(first);
    expect(rowsAfterSecond[0]?.n).toBe(rowsAfterFirst[0]?.n);
  });

  it("does not cross workspace boundaries", async () => {
    const { adapter, pgClient } = v3Adapter();
    const wsA = freshWorkspaceId();
    const wsB = freshWorkspaceId();
    await seedEmbeddedFacts(adapter, pgClient, wsA);

    const writtenForB = await adapter.backfillSemanticNeighbors({ workspaceId: wsB });
    expect(writtenForB).toBe(0);

    const rowsB = await pgClient<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM public.mnemo_semantic_neighbor WHERE workspace_id = ${wsB}::uuid
    `;
    expect(rowsB[0]?.n).toBe(0);
  });

  it("getGraphSnapshot(includeSemantic: true) reads back exactly what the backfill wrote", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();
    const { ea, eb, ec } = await seedEmbeddedFacts(adapter, pgClient, ws);

    await adapter.backfillSemanticNeighbors({ workspaceId: ws, k: 8, threshold: 0.75 });

    const snapshot = await adapter.getGraphSnapshot({ workspaceId: ws, includeSemantic: true });
    const semanticEdges = snapshot.edges.filter((e) => e.relation === "semantically_related");

    expect(semanticEdges).toHaveLength(1);
    const pair = [semanticEdges[0]!.source, semanticEdges[0]!.target].sort();
    expect(pair).toEqual([ea.id, eb.id].sort());
    expect(pair).not.toContain(ec.id);
    expect(semanticEdges[0]!.provenance).toBe("semantic_knn");
  });

  it("getGraphSnapshot(maxSensitivity) drops a semantic edge drawn from a fact above the ceiling", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();
    const { ea, eb, fb } = await seedEmbeddedFacts(adapter, pgClient, ws);
    await adapter.backfillSemanticNeighbors({ workspaceId: ws, k: 8, threshold: 0.75 });
    await pgClient.unsafe(
      `UPDATE mnemosyne.mnemo_fact SET sensitivity = 'restricted' WHERE id = $1`,
      [fb.id]
    );

    const capped = await adapter.getGraphSnapshot({
      workspaceId: ws,
      includeSemantic: true,
      maxSensitivity: "internal",
    });
    // Both entities stay (they are internal); only the edge their facts drew goes.
    expect(capped.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([ea.id, eb.id]));
    expect(capped.edges).toEqual([]);

    const admin = await adapter.getGraphSnapshot({
      workspaceId: ws,
      includeSemantic: true,
      maxSensitivity: "restricted",
    });
    expect(admin.edges.filter((e) => e.relation === "semantically_related")).toHaveLength(1);
  });
});
