/**
 * listWorkspaceIds under the role production actually runs as.
 *
 * The server refuses to boot as a superuser or a BYPASSRLS role, so in a
 * correctly-secured deployment it connects as a plain login role holding
 * mnemo_app_role. Workspace enumeration had no workspace to set
 * `mnemosyne.workspace_id` to, read mnemo_fact directly, and FORCE ROW LEVEL
 * SECURITY hid every row: it returned [] while the workspace held live facts.
 * Every per-workspace cron (embedding migration, decay, retention, health
 * snapshots) and the consolidation scheduler then iterated zero workspaces,
 * without a single error.
 *
 * list-workspace-ids.integration.test.ts connects as the superuser and inserts
 * nothing, so it could never see this; this test enumerates as the app role.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "enumerate_app";
const APP_PASS = "enumerate_app_pass";
const WS_FACTS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_FORGOTTEN = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let superClient: ReturnType<typeof createDrizzleClient>;
let appClient: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);

  superClient = createDrizzleClient(superUrl);
  appClient = createDrizzleClient(appUrl);

  const superAdapter = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
  for (const workspaceId of [WS_FACTS, WS_FORGOTTEN]) {
    await superAdapter.createFact({
      workspaceId,
      actorId: "key:enumerate",
      scope: "global",
      statement: `a live fact in ${workspaceId}`,
      subject: "s",
      kind: "other",
      sensitivity: "internal",
    } as never);
  }
  await superSql`
    UPDATE mnemosyne.mnemo_fact SET status = 'forgotten' WHERE workspace_id = ${WS_FORGOTTEN}
  `;
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("listWorkspaceIds as the application role", () => {
  it("sees a workspace with live facts despite FORCE ROW LEVEL SECURITY", async () => {
    const appAdapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
    expect(await appAdapter.listWorkspaceIds()).toEqual([WS_FACTS]);
  });

  it("does not open read access to mnemo_fact itself", async () => {
    const rows = await appClient.pgClient<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_fact
    `.catch(() => [{ n: 0 }]);
    expect(rows[0]!.n).toBe(0);
  });
});
