/**
 * Regression guard for the cron/admin workspace-enumeration path
 * (WorkspaceRepository.listWorkspaceIds, exposed via DrizzleStorageAdapter).
 *
 * The query once selected FROM the non-existent relation
 * `mnemosyne.mnemo_facts` (plural). Against a real database that throws
 * Postgres 42P01 `relation "mnemosyne.mnemo_facts" does not exist`, breaking
 * the partition / KEK-rotate / consolidation crons that enumerate workspaces.
 * The relation is the singular `mnemosyne.mnemo_fact` everywhere else.
 *
 * A wrong relation name throws before the method can return, so asserting that
 * listWorkspaceIds() resolves to an array against the real schema guards
 * against the plural creeping back.
 *
 * TEST-1: converted from an env-var-gated *.test.ts (see
 * worth-bayes.integration.test.ts for the full rationale) to a real
 * testcontainers integration test.
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

describe("DrizzleStorageAdapter.listWorkspaceIds", () => {
  let adapter: DrizzleStorageAdapter;
  let pgClient: ReturnType<typeof createDrizzleClient>["pgClient"];

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
  }, 120_000);

  afterAll(async () => {
    await pgClient?.end().catch(() => void 0);
    await container?.stop().catch(() => void 0);
  });

  it("resolves against the real mnemo_fact relation (regression: was mnemo_facts)", async () => {
    const ids = await adapter.listWorkspaceIds();
    expect(Array.isArray(ids)).toBe(true);
  });
});
