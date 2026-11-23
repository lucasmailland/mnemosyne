import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const WS_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

let container: StartedTestContainer;
let client: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASS,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl, log: () => void 0 });
  client = createDrizzleClient(databaseUrl);
}, 120_000);

afterAll(async () => {
  await client?.pgClient.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("SessionRepository recordCollapseFailure", () => {
  const readSession = async (id: string, workspaceId: string) =>
    client.pgClient.begin(async (tx) => {
      await tx.unsafe("SELECT mnemo_set_workspace($1::uuid)", [workspaceId]);
      return tx.unsafe(
        `SELECT status, collapse_attempts, collapse_next_attempt_at::text,
          metadata->>'collapseLastError' AS collapse_last_error
         FROM mnemosyne.mnemo_session WHERE id = $1`,
        [id]
      );
    });

  it("backs off on repeated failures for an active legacy session", async () => {
    const adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
    const session = await adapter.createSession({ workspaceId: WS_A });

    await adapter.recordCollapseFailure(session.id, WS_A, "boom");
    await adapter.recordCollapseFailure(session.id, WS_A, "boom");

    const rows = await readSession(session.id, WS_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.collapse_attempts).toBe(2);
    expect(rows[0]!.collapse_last_error).toBe("boom");
    const minutesUntilRetry =
      (new Date(rows[0]!.collapse_next_attempt_at!).getTime() - Date.now()) / 60_000; // determinism-ok: next attempt is set from the database clock
    expect(minutesUntilRetry).toBeGreaterThanOrEqual(9);
    expect(minutesUntilRetry).toBeLessThanOrEqual(11);
  });

  it("does not modify a collapsed session", async () => {
    const adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
    const session = await adapter.createSession({ workspaceId: WS_A });
    await client.pgClient.begin(async (tx) => {
      await tx.unsafe("SELECT mnemo_set_workspace($1::uuid)", [WS_A]);
      await tx.unsafe(
        `UPDATE mnemosyne.mnemo_session SET status = 'collapsed', collapse_attempts = 4
         WHERE id = $1 AND workspace_id = $2`,
        [session.id, WS_A]
      );
    });

    await adapter.recordCollapseFailure(session.id, WS_A, "boom");
    const rows = await readSession(session.id, WS_A);
    expect(rows[0]!.status).toBe("collapsed");
    expect(rows[0]!.collapse_attempts).toBe(4);
  });

  it("does not modify a session when called with the wrong workspace", async () => {
    const adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
    const session = await adapter.createSession({ workspaceId: WS_A });

    await adapter.recordCollapseFailure(session.id, WS_B, "boom");
    const rows = await readSession(session.id, WS_A);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.collapse_attempts).toBe(0);
    expect(rows[0]!.collapse_next_attempt_at).toBeNull();
    expect(rows[0]!.collapse_last_error).toBeNull();
  });
});
