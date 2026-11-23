import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const MODEL = "current-model";
const VECTOR = Array(1536).fill(0.25) as number[];

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
  await migrate({ databaseUrl, log: () => undefined });
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop();
});

async function createFact(workspaceId: string) {
  return adapter.createFact({
    workspaceId,
    scope: "global",
    statement: "embedding migration probe",
    subject: "probe",
    kind: "other",
  });
}

describe("hasActiveEmbeddingMigration", () => {
  it("ignores a NULL vector with a NULL model while leaving it eligible for backfill", async () => {
    const ws = "11111111-1111-4111-8111-111111111111";
    const fact = await createFact(ws);

    expect(await adapter.hasActiveEmbeddingMigration(ws, MODEL)).toBe(false);
    expect(await adapter.listStaleEmbeddings("fact", ws, MODEL, 10)).toContainEqual({
      id: fact.id,
      text: fact.statement,
    });
  });

  it("detects an old-model vector", async () => {
    const ws = "22222222-2222-4222-8222-222222222222";
    const fact = await createFact(ws);
    await adapter.updateEmbeddingVector("fact", fact.id, ws, VECTOR, "old-model");

    expect(await adapter.hasActiveEmbeddingMigration(ws, MODEL)).toBe(true);
  });

  it("ignores a clean current-model vector", async () => {
    const ws = "33333333-3333-4333-8333-333333333333";
    const fact = await createFact(ws);
    await adapter.updateEmbeddingVector("fact", fact.id, ws, VECTOR, MODEL);

    expect(await adapter.hasActiveEmbeddingMigration(ws, MODEL)).toBe(false);
  });

  it("detects a stale current-model vector", async () => {
    const ws = "44444444-4444-4444-8444-444444444444";
    const fact = await createFact(ws);
    await adapter.updateEmbeddingVector("fact", fact.id, ws, VECTOR, MODEL);
    await adapter.updateFact(fact.id, ws, { statement: "edited after embedding" });

    expect(await adapter.hasActiveEmbeddingMigration(ws, MODEL)).toBe(true);
  });

  it("applies the vector requirement to decisions too", async () => {
    const ws = "55555555-5555-4555-8555-555555555555";
    const decision = await adapter.createDecision({
      workspaceId: ws,
      title: "Migration",
      body: "Use current embeddings",
      kind: "decision",
    });

    expect(await adapter.hasActiveEmbeddingMigration(ws, MODEL)).toBe(false);
    await adapter.updateEmbeddingVector("decision", decision.id, ws, VECTOR, "old-model");
    expect(await adapter.hasActiveEmbeddingMigration(ws, MODEL)).toBe(true);
  });
});
