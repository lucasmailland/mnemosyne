/**
 * Integration test: DrizzleSyncJobStore over mnemo_federation_sync_job (0063).
 *
 * Boots a real pgvector container, applies every migration and checks what the
 * federation sync routes rely on: a job reads back after the store is rebuilt
 * (a restart), only from its own workspace, a finished job is final, and a job
 * left pending or running by a dead process reads as failed with a reason.
 * Runs via `test:integration` (needs Docker).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzleSyncJobStore, INTERRUPTED_SYNC_JOB_ERROR } from "../DrizzleSyncJobStore.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const WS_ACME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const WS_LARKSPUR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";

let container: StartedTestContainer;
let url: string;
let store: DrizzleSyncJobStore;
let pg: { end: () => Promise<void> };
let raw: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: "mnemo_test",
      POSTGRES_PASSWORD: "mnemo_test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  url = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl: url, log: () => {} });
  const { db, pgClient } = createDrizzleClient(url);
  store = new DrizzleSyncJobStore(db);
  pg = pgClient as unknown as { end: () => Promise<void> };
  raw = postgres(url, { onnotice: () => void 0, max: 1 });
}, 120_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await pg?.end?.();
  await container?.stop();
});

function job(id: string, workspaceId = WS_ACME) {
  return {
    id,
    peerId: "acme.example",
    workspaceId,
    status: "pending" as const,
    startedAt: "2026-01-02T03:04:05.000Z",
  };
}

describe("DrizzleSyncJobStore", () => {
  it("a finished job reads back from a new store over the same database", async () => {
    await store.create(job("job-done"));
    await store.update("job-done", WS_ACME, { status: "running" });
    await store.update("job-done", WS_ACME, {
      status: "done",
      completedAt: "2026-01-02T03:05:00.000Z",
      outcome: { peerId: "acme.example", itemsProcessed: 2 },
    });

    const { db, pgClient } = createDrizzleClient(url);
    try {
      const restarted = new DrizzleSyncJobStore(db);
      expect(await restarted.get("job-done", WS_ACME)).toEqual({
        id: "job-done",
        peerId: "acme.example",
        workspaceId: WS_ACME,
        status: "done",
        startedAt: "2026-01-02T03:04:05.000Z",
        completedAt: "2026-01-02T03:05:00.000Z",
        outcome: { peerId: "acme.example", itemsProcessed: 2 },
      });
    } finally {
      await (pgClient as unknown as { end: () => Promise<void> }).end();
    }
  });

  it("another workspace does not see the job, even with its id", async () => {
    expect(await store.get("job-done", WS_LARKSPUR)).toBeNull();
    await store.update("job-done", WS_LARKSPUR, { status: "failed", error: "hijack" });
    expect((await store.get("job-done", WS_ACME))?.status).toBe("done");
  });

  it("a finished job is never changed again", async () => {
    await store.update("job-done", WS_ACME, { status: "failed", error: "late" });
    const got = await store.get("job-done", WS_ACME);
    expect(got?.status).toBe("done");
    expect(got).not.toHaveProperty("error");
  });

  it("a running job with a live heartbeat stays running", async () => {
    await store.create(job("job-live"));
    await store.update("job-live", WS_ACME, { status: "running" });
    expect((await store.get("job-live", WS_ACME))?.status).toBe("running");
  });

  it.each(["pending", "running"])(
    "a %s job whose process died reads as failed, and stays failed",
    async (status) => {
      const id = `job-dead-${status}`;
      await store.create(job(id));
      // The process stopped bumping it long ago.
      await raw`
        UPDATE mnemosyne.mnemo_federation_sync_job
        SET status = ${status}, heartbeat_at = '2026-01-02T03:04:05Z'
        WHERE id = ${id}`;
      const got = await store.get(id, WS_ACME);
      expect(got).toMatchObject({ status: "failed", error: INTERRUPTED_SYNC_JOB_ERROR });
      expect(got?.completedAt).toBeDefined();

      await store.update(id, WS_ACME, { status: "done" });
      expect((await store.get(id, WS_ACME))?.status).toBe("failed");
    }
  );

  it("a query without the workspace GUC sees no jobs (RLS)", async () => {
    const rows = await raw.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return tx`SELECT id FROM mnemosyne.mnemo_federation_sync_job`;
    });
    expect(rows).toHaveLength(0);
  });
});
