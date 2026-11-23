/**
 * TEST-1: converted from an env-var-gated *.test.ts (see worth-bayes.integration.test.ts
 * for the full rationale) to a real testcontainers integration test. This file
 * additionally gated on a DIFFERENT env var (TEST_DATABASE_URL, not the
 * MNEMO_TEST_DATABASE_URL the other 5 files used) via a separate pool-config
 * helper — same dead-code effect, different cause. Standardized on the
 * createDrizzleClient pattern the rest of this directory uses.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../index.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;

describe("DrizzleStorageAdapter.listSessionTopicKeysBySource", () => {
  let adapter: DrizzleStorageAdapter;
  let pgClient: ReturnType<typeof createDrizzleClient>["pgClient"];
  const workspaceId = "00000000-0000-0000-0000-000000000001";
  const sessionId = "00000000-0000-0000-0000-000000000002";

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

    const client = createDrizzleClient(databaseUrl);
    adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
    pgClient = client.pgClient;

    // seed 3 facts: 2 per_turn (alpha, beta) + 1 collapse (gamma)
    await adapter.createFact({
      workspaceId,
      agentId: "agent1",
      scope: "global",
      statement: "alpha fact",
      subject: "s",
      kind: "other",
      confidence: 0.8,
      sessionId,
      topicKey: "alpha",
      extractionSource: "per_turn",
    });
    await adapter.createFact({
      workspaceId,
      agentId: "agent1",
      scope: "global",
      statement: "beta fact",
      subject: "s",
      kind: "other",
      confidence: 0.8,
      sessionId,
      topicKey: "beta",
      extractionSource: "per_turn",
    });
    await adapter.createFact({
      workspaceId,
      agentId: "agent1",
      scope: "global",
      statement: "gamma fact",
      subject: "s",
      kind: "other",
      confidence: 0.8,
      sessionId,
      topicKey: "gamma",
      extractionSource: "collapse",
    });
  }, 120_000);

  afterAll(async () => {
    await pgClient?.end().catch(() => void 0);
    await container?.stop().catch(() => void 0);
  });

  it("returns only per_turn topic_keys", async () => {
    const keys = await adapter.listSessionTopicKeysBySource!(workspaceId, sessionId, "per_turn");
    expect(keys.sort()).toEqual(["alpha", "beta"]);
  });

  it("returns collapse topic_keys when source is collapse", async () => {
    const keys = await adapter.listSessionTopicKeysBySource!(workspaceId, sessionId, "collapse");
    expect(keys.sort()).toEqual(["gamma"]);
  });

  it("returns empty array for unknown session", async () => {
    const keys = await adapter.listSessionTopicKeysBySource!(
      workspaceId,
      "00000000-0000-0000-0000-000000000099",
      "per_turn"
    );
    expect(keys).toEqual([]);
  });
});
