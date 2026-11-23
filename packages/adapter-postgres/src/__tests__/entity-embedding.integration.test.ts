/**
 * P16 — Entity embedding integration tests.
 *
 * Covers tasks 7.4 and 7.5:
 *   7.4 — EntityRepository.createEntity inserts a vector_upsert outbox entry
 *         with kind:'entity' and the correct text payload.
 *         EntityRepository.findSimilarEntities returns cosine-ranked rows and
 *         respects the minSim filter.
 *   7.5 — EmbeddingRepository.listStaleEmbeddings("entity", ...) returns rows
 *         with embedding_stale = true; updateEmbeddingVector("entity", ...) writes
 *         the embedding and sets embedding_stale = false.
 */

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

let container: StartedTestContainer;
let databaseUrl: string;
let adapter: DrizzleStorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop();
});

// ─── 7.4 createEntity outbox emission ────────────────────────────────────────

describe("P16 — EntityRepository.createEntity: outbox vector_upsert emission", () => {
  it("inserts a vector_upsert outbox entry with kind='entity' and correct text", async () => {
    const entity = await adapter.createEntity({
      workspaceId: WS,
      name: "Qubo",
      kind: "organization",
      description: "Edge AI hardware company",
    });

    const sql = postgres(databaseUrl);
    try {
      const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload
        FROM mnemosyne.mnemo_outbox
        WHERE workspace_id = ${WS}
          AND event_type = 'vector_upsert'
          AND (payload->>'id') = ${entity.id}
        ORDER BY created_at DESC
        LIMIT 5
      `;

      expect(rows.length).toBeGreaterThanOrEqual(1);
      const entry = rows[0]!;
      expect(entry.payload.kind).toBe("entity");
      expect(entry.payload.text).toBe("Qubo Edge AI hardware company");
    } finally {
      await sql.end();
    }
  });

  it("createEntity with no description still creates outbox entry with empty description", async () => {
    const entity = await adapter.createEntity({
      workspaceId: WS,
      name: "Acme",
      kind: "organization",
    });

    const sql = postgres(databaseUrl);
    try {
      const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload
        FROM mnemosyne.mnemo_outbox
        WHERE workspace_id = ${WS}
          AND event_type = 'vector_upsert'
          AND (payload->>'id') = ${entity.id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.payload.kind).toBe("entity");
      // name + ' ' + '' = 'Acme '
      expect(rows[0]!.payload.text).toBe("Acme ");
    } finally {
      await sql.end();
    }
  });
});

// ─── 7.4 findSimilarEntities ─────────────────────────────────────────────────

describe("P16 — DrizzleStorageAdapter.findSimilarEntities: cosine search and minSim filter", () => {
  it("returns empty array when no entities have embeddings", async () => {
    // Create an entity without embedding.
    await adapter.createEntity({ workspaceId: WS, name: "Bare", kind: "concept" });

    const results = await adapter.findSimilarEntities(
      WS,
      new Array(1536).fill(0.1),
      10,
      0.5,
    );
    // All entities have null embedding_stale=true but no vector yet — result must be empty.
    expect(results).toEqual([]);
  });

  it("returns entity after embedding is written, respects minSim filter", async () => {
    const entity = await adapter.createEntity({
      workspaceId: WS,
      name: "Mnemosyne",
      kind: "project",
      description: "Persistent memory layer",
    });

    // Seed a known unit vector.
    const dim = 1536;
    const vec = new Array(dim).fill(0);
    vec[0] = 1.0; // unit vector in dimension 0

    await adapter.updateEmbeddingVector("entity", entity.id, WS, vec, "test-model");

    // Query with a very similar vector — cosine similarity should be ~1.0.
    const results = await adapter.findSimilarEntities(WS, vec, 5, 0.9);
    const found = results.find((r) => r.id === entity.id);
    expect(found).toBeDefined();
    expect(found!.cosine).toBeGreaterThan(0.9);

    // Query with a high minSim that no entity can meet (set minSim > 1.0 is invalid,
    // but we use a vector orthogonal to the entity's to get cosine ≈ 0).
    const orthogonal = new Array(dim).fill(0);
    orthogonal[1] = 1.0; // dimension 1
    const noResults = await adapter.findSimilarEntities(WS, orthogonal, 5, 0.9);
    const notFound = noResults.find((r) => r.id === entity.id);
    expect(notFound).toBeUndefined();
  });
});

// ─── 7.5 listStaleEmbeddings + updateEmbeddingVector ─────────────────────────

describe("P16 — EmbeddingRepository: listStaleEmbeddings and updateEmbeddingVector for entity", () => {
  it("newly created entity appears in listStaleEmbeddings('entity', ...) before embedding", async () => {
    const entity = await adapter.createEntity({
      workspaceId: WS,
      name: "StaleTest",
      kind: "concept",
    });

    const stale = await adapter.listStaleEmbeddings("entity", WS, "test-model", 100);
    const found = stale.find((r) => r.id === entity.id);
    expect(found).toBeDefined();
    // text should be derived from name + ' ' + COALESCE(description, '')
    expect(found!.text).toContain("StaleTest");
  });

  it("updateEmbeddingVector('entity') writes embedding and sets embedding_stale=false", async () => {
    const entity = await adapter.createEntity({
      workspaceId: WS,
      name: "EmbeddedEntity",
      kind: "concept",
      description: "Has a real embedding",
    });

    const dim = 1536;
    const vec = new Array(dim).fill(0);
    vec[0] = 0.5;
    vec[1] = 0.5;

    await adapter.updateEmbeddingVector("entity", entity.id, WS, vec, "test-model-v2");

    // After update, the entity should NOT appear in stale list for "test-model-v2".
    const staleAfter = await adapter.listStaleEmbeddings("entity", WS, "test-model-v2", 100);
    const stillStale = staleAfter.find((r) => r.id === entity.id);
    expect(stillStale).toBeUndefined();

    // Verify the embedding was actually written (cosine search should find it).
    const results = await adapter.findSimilarEntities(WS, vec, 5, 0.5);
    const found = results.find((r) => r.id === entity.id);
    expect(found).toBeDefined();
    expect(found!.cosine).toBeGreaterThan(0.5);
  });
});
