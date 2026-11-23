/**
 * TEST-1: converted from an env-var-gated *.test.ts (see worth-bayes.integration.test.ts
 * for the full rationale) to a real testcontainers integration test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../index.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;

describe("Meta-cognition views (Wave F)", () => {
  let adapter: DrizzleStorageAdapter;
  let endClient: () => Promise<void>;
  const workspaceId = "00000000-0000-0000-0000-0000000000f6";

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
    await migrate({ databaseUrl, log: () => void 0 });

    const { db, pgClient } = createDrizzleClient(databaseUrl);
    adapter = new DrizzleStorageAdapter(db, pgClient);
    endClient = () => pgClient.end();
  }, 120_000);

  afterAll(async () => {
    await endClient?.().catch(() => void 0);
    await container?.stop().catch(() => void 0);
  });

  it("getConfidenceMap returns rows for workspace", async () => {
    await expect(adapter.getConfidenceMap(workspaceId)).resolves.toBeInstanceOf(Array);
  });

  it("getConfidenceMap respects limit option", async () => {
    const rows = await adapter.getConfidenceMap(workspaceId, { limit: 10 });
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  it("getKnowledgeGaps returns rows for workspace", async () => {
    await expect(adapter.getKnowledgeGaps(workspaceId)).resolves.toBeInstanceOf(Array);
  });

  it("refreshMetacognitionViews completes without error", async () => {
    await expect(adapter.refreshMetacognitionViews()).resolves.toBeUndefined();
  });
});
