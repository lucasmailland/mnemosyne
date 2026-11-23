/** Due reminder discovery must work without a workspace GUC under the production role. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "reminder_app";
const APP_PASS = "reminder_app_pass";
const WS_DUE = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_FUTURE = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WS_CONDITIONED = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const WS_TRIGGERED = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
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
  appClient = createDrizzleClient(appUrl);

  await superSql`
    INSERT INTO mnemosyne.mnemo_reminder (id, workspace_id, content, condition, trigger_at, status)
    VALUES
      ('due', ${WS_DUE}, 'due', NULL, now() - interval '1 minute', 'pending'),
      ('due-blank', ${WS_DUE}, 'due blank', '  ', now() - interval '1 minute', 'pending'),
      ('future', ${WS_FUTURE}, 'future', NULL, now() + interval '1 day', 'pending'),
      ('conditioned', ${WS_CONDITIONED}, 'conditioned', 'on recall', now() - interval '1 minute', 'pending'),
      ('triggered', ${WS_TRIGGERED}, 'triggered', NULL, now() - interval '1 minute', 'triggered')
  `;
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("listDueReminderWorkspaceIds as the application role", () => {
  it("lists only workspaces with due, pending, condition-less reminders", async () => {
    const adapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
    expect(await adapter.listDueReminderWorkspaceIds()).toEqual([WS_DUE]);
  });

  it("does not allow direct reminder reads without a workspace GUC", async () => {
    const rows = await appClient.pgClient<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_reminder
    `.catch(() => [{ n: 0 }]);
    expect(rows[0]!.n).toBe(0);
  });
});
