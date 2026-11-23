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

describe("DrizzleStorageAdapter — hyperedge CRUD (Wave D)", () => {
  let adapter: DrizzleStorageAdapter;
  let endClient: () => Promise<void>;
  const workspaceId = "00000000-0000-0000-0000-0000000000d4";

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

  it("rejects createHyperedge with fewer than 3 members", async () => {
    await expect(adapter.createHyperedge({ workspaceId, memberIds: ["a", "b"] })).rejects.toThrow(
      /at least 3/i
    );
  });

  it("creates, reads, lists, updates, archives a hyperedge", async () => {
    const created = await adapter.createHyperedge({
      workspaceId,
      memberIds: ["m1", "m2", "m3"],
      label: "trio",
    });
    expect(created.memberIds).toEqual(["m1", "m2", "m3"]);
    expect(created.activationCount).toBe(0);

    const got = await adapter.getHyperedge(created.id, workspaceId);
    expect(got?.label).toBe("trio");

    const page = await adapter.queryHyperedges({ workspaceId, memberId: "m2", limit: 50 });
    expect(page.items.some((h) => h.id === created.id)).toBe(true);

    const updated = await adapter.updateHyperedge(created.id, { label: "renamed" });
    expect(updated.label).toBe("renamed");

    await adapter.archiveHyperedge(created.id, workspaceId);
    // PRIM-12: a deleted hyperedge reads as gone; history is an explicit opt-in.
    expect(await adapter.getHyperedge(created.id, workspaceId)).toBeNull();
    const closed = await adapter.getHyperedge(created.id, workspaceId, { includeClosed: true });
    expect(closed?.validTo).not.toBeNull();
  });

  it("bumpHyperedgeActivation increments activation_count", async () => {
    const h = await adapter.createHyperedge({ workspaceId, memberIds: ["x1", "x2", "x3"] });
    await adapter.bumpHyperedgeActivation(h.id, workspaceId);
    await adapter.bumpHyperedgeActivation(h.id, workspaceId);
    const got = await adapter.getHyperedge(h.id, workspaceId);
    expect(got?.activationCount).toBe(2);
  });
});
