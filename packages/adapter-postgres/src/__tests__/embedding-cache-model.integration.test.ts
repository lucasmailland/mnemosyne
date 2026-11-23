/**
 * Integration test: the L3 embedding LRU must be model-aware.
 *
 * `mnemo_embedding_cache` is keyed `(workspace_id, text_hash)` — the hash of
 * the query text alone. The model that produced the vector is stored in a
 * `model` column that nothing ever read: `getCachedEmbedding` matched on the
 * text hash and returned whatever vector was there.
 *
 * That was inert while the column was `halfvec(1536)`, because a non-1536
 * model could never write a row in the first place (see migration 0037). Once
 * the column accepts every width, it stops being inert and becomes a live
 * hazard: switch a workspace from OpenAI (1536) to bge-m3 (1024) and the first
 * repeat query returns the stale 1536-wide vector, which is then handed to a
 * cosine search against 1024-wide rows. pgvector does not score that poorly —
 * it raises `different halfvec dimensions 1536 and 1024` and the recall dies.
 * `_embedding-width.ts` documents that exact failure for the search path.
 *
 * So the read must match on model, and a write under a new model must replace
 * the vector rather than merely bump `hit_count`.
 *
 * Requires Docker + Node >=22 — same testcontainers pattern as
 * decision-topic-key.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;

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

  await migrate({ databaseUrl, log: () => undefined });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop();
});

describe("embedding LRU is model-aware", () => {
  const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

  it("stores a 1024-wide vector at all", async () => {
    await adapter.putCachedEmbedding({
      workspaceId: WS,
      textHash: "hash-narrow",
      embedding: new Float32Array(1024).fill(0.25),
      model: "bge-m3",
    });

    const got = await adapter.getCachedEmbedding(WS, "hash-narrow", "bge-m3");

    expect(got).not.toBeNull();
    expect(got!.length).toBe(1024);
  });

  it("does not return a vector embedded by a different model", async () => {
    await adapter.putCachedEmbedding({
      workspaceId: WS,
      textHash: "hash-shared",
      embedding: new Float32Array(1536).fill(0.5),
      model: "text-embedding-3-small",
    });

    const wrongModel = await adapter.getCachedEmbedding(WS, "hash-shared", "bge-m3");

    expect(wrongModel).toBeNull();
  });

  it("returns the vector when the model matches", async () => {
    await adapter.putCachedEmbedding({
      workspaceId: WS,
      textHash: "hash-match",
      embedding: new Float32Array(1536).fill(0.75),
      model: "text-embedding-3-small",
    });

    const got = await adapter.getCachedEmbedding(WS, "hash-match", "text-embedding-3-small");

    expect(got).not.toBeNull();
    expect(got!.length).toBe(1536);
  });

  it("re-embedding the same text under a new model replaces the stored vector", async () => {
    await adapter.putCachedEmbedding({
      workspaceId: WS,
      textHash: "hash-switch",
      embedding: new Float32Array(1536).fill(0.1),
      model: "text-embedding-3-small",
    });
    await adapter.putCachedEmbedding({
      workspaceId: WS,
      textHash: "hash-switch",
      embedding: new Float32Array(1024).fill(0.9),
      model: "bge-m3",
    });

    const current = await adapter.getCachedEmbedding(WS, "hash-switch", "bge-m3");
    const superseded = await adapter.getCachedEmbedding(
      WS,
      "hash-switch",
      "text-embedding-3-small"
    );

    expect(current).not.toBeNull();
    expect(current!.length).toBe(1024);
    expect(superseded).toBeNull();
  });
});
