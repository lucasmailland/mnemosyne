/**
 * Integration test: the agent policy change log (migration 0067) as the
 * application role (NOSUPERUSER NOBYPASSRLS). A policy write leaves its change
 * row in the same transaction, the poll function reads every workspace's ids
 * without a GUC, the table itself stays per-workspace, and the purge keeps the
 * last hour. Runs via `test:integration` (needs Docker).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { AccessPolicyRecord } from "@mnemo-ai/types";

import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzleAccessPolicyStore } from "../DrizzleAccessPolicyStore.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_DB = "mnemo_test";
const APP_USER = "policy_app";
const APP_PASS = "policy_app_pass";
const WS_ACME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa67";
const WS_LARKSPUR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb67";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createDrizzleClient>;
let store: DrizzleAccessPolicyStore;

function policy(workspaceId: string, agentId: string): AccessPolicyRecord {
  return {
    agentId,
    workspaceId,
    readScopes: ["memory:read"],
    writeScopes: [],
    selfEdit: { enabled: false },
    taskScopes: { canCreate: false, canDelegate: false, canDelegateTo: [] },
    limits: {
      maxWritesPerMinute: 120,
      maxRecallsPerMinute: 600,
      maxSessionsConcurrent: 10,
      maxSelfEditsPerSession: 3,
    },
    requireApprovalFor: [],
    federationAccess: "none",
  } as AccessPolicyRecord;
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: "mnemo_super",
      POSTGRES_PASSWORD: "mnemo_super",
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://mnemo_super:mnemo_super@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);
  app = createDrizzleClient(`postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`);
  store = new DrizzleAccessPolicyStore(app.db);
}, 120_000);

afterAll(async () => {
  await app?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("mnemo_access_policy_change as the application role", () => {
  it("every put and delete leaves a change row the poll reads across workspaces", async () => {
    const before = await store.changesSince(0);
    const cursor = Math.max(0, ...before.map((c) => c.seq));

    await store.putPolicy(policy(WS_ACME, "agent-a"));
    await store.putPolicy(policy(WS_ACME, "agent-a")); // update
    await store.putPolicy(policy(WS_LARKSPUR, "agent-b"));
    expect(await store.deletePolicy(WS_ACME, "agent-a")).toBe(true);

    const after = (await store.changesSince(cursor)).filter((c) => c.seq > cursor);
    expect(after.map(({ workspaceId, agentId }) => [workspaceId, agentId])).toEqual([
      [WS_ACME, "agent-a"],
      [WS_ACME, "agent-a"],
      [WS_LARKSPUR, "agent-b"],
      [WS_ACME, "agent-a"],
    ]);
    // Inside the look-back window, rows at or below the cursor come back too.
    const top = Math.max(...after.map((c) => c.seq));
    expect((await store.changesSince(top)).map((c) => c.seq)).toEqual(
      expect.arrayContaining(after.map((c) => c.seq))
    );
  });

  it("a rolled-back policy write leaves no change row", async () => {
    const top = Math.max(0, ...(await store.changesSince(0)).map((c) => c.seq));
    await expect(
      app.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT mnemo_set_workspace(${WS_ACME}::uuid)`);
        await tx.execute(sql`
          INSERT INTO mnemosyne.mnemo_access_policy (id, workspace_id, agent_id)
          VALUES (${`${WS_ACME}:agent-rollback`}, ${WS_ACME}, 'agent-rollback')`);
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    const rows = await store.changesSince(top);
    expect(rows.some((c) => c.agentId === "agent-rollback")).toBe(false);
  });

  it("the table itself shows nothing without a workspace, and one workspace's rows inside it", async () => {
    const bare = await app.pgClient<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_access_policy_change`;
    expect(bare[0]!.n).toBe(0);

    const scoped = await app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${WS_LARKSPUR}::uuid)`);
      return tx.execute(
        sql`SELECT DISTINCT workspace_id FROM mnemosyne.mnemo_access_policy_change`
      );
    });
    const rows = ((scoped as { rows?: unknown[] }).rows ?? scoped) as Array<{
      workspace_id: string;
    }>;
    expect(rows.map((r) => r.workspace_id)).toEqual([WS_LARKSPUR]);
  });

  it("the purge drops rows older than an hour and keeps the rest", async () => {
    await superSql`
      INSERT INTO mnemosyne.mnemo_access_policy_change (workspace_id, agent_id, changed_at)
      VALUES (${WS_ACME}, 'agent-old', now() - interval '2 hours')`; // determinism-ok: relative to the database clock the purge reads
    const total = async () =>
      (
        await superSql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM mnemosyne.mnemo_access_policy_change`
      )[0]!.n;
    const before = await total();

    expect(await store.purgeChanges()).toBe(1);
    expect(await total()).toBe(before - 1);
    const left = await superSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_access_policy_change
      WHERE agent_id = 'agent-old'`;
    expect(left[0]!.n).toBe(0);
  });
});
