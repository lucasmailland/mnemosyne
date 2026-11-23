import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "session_app";
const APP_PASS = "session_app_pass";
const WS_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let superClient: ReturnType<typeof createDrizzleClient>;
let appClient: ReturnType<typeof createDrizzleClient>;

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
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("SessionRepository appendTurn RLS", () => {
  it("rejects a workspace-B turn for a workspace-A session as a safe non-superuser", async () => {
    const superAdapter = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
    const appAdapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
    const session = await superAdapter.createSession({ workspaceId: WS_A });

    await appAdapter.appendTurn(session.id, {
      workspaceId: WS_A,
      sessionId: session.id,
      turnIndex: 0,
      role: "user",
      content: "same workspace",
    });

    await expect(
      appAdapter.appendTurn(session.id, {
        workspaceId: WS_B,
        sessionId: session.id,
        turnIndex: 1,
        role: "user",
        content: "cross workspace",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const rows = await superSql<Array<{ workspace_id: string }>>`
      SELECT workspace_id::text
      FROM mnemosyne.mnemo_session_turn
      WHERE session_id = ${session.id}
      ORDER BY turn_index
    `;
    expect(rows).toEqual([{ workspace_id: WS_A }]);
  });
});
