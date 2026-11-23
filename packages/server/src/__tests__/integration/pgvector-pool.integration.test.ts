/**
 * The vector adapter's own pool, against real Postgres as a NOSUPERUSER role.
 *
 * CHAOS-9: `/health/ready` reported `vector: "down"` after the first recall,
 * while semantic recall kept working. The probe read `mnemo_fact` outside a
 * workspace transaction; on a connection where a search had set the workspace
 * GUC locally, the GUC reads back as '' and the RLS policy's `::uuid` cast
 * throws. The probe now checks what it can check without tenant data: the
 * table, the extension and the role's read privilege.
 *
 * PG-TIMEOUTS: this pool gets the same statement/lock/idle limits as the
 * storage pools.
 *
 * Requires Docker (testcontainers).
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgVectorAdapter } from "@mnemo-ai/adapter-vector";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app_vector";
const APP_PASS = "mnemo_app_vector_pass";
const WS = "33333333-3333-4333-8333-333333333333";

let container: StartedTestContainer;
let appUrl: string;
let admin: ReturnType<typeof postgres>;
const adapters: PgVectorAdapter[] = [];

function vectorAdapter(extra: Partial<ConstructorParameters<typeof PgVectorAdapter>[0]> = {}) {
  const a = new PgVectorAdapter({ connectionString: appUrl, dimensions: 4, ...extra });
  adapters.push(a);
  return a;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  admin = postgres(superUrl, { max: 2, onnotice: () => void 0 });
  await admin.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  const { stdout } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(stdout).toContain("Done. Applied:");
  await admin.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public TO ${APP_USER};
  `);
  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;

  // The RLS qual only runs when there is a row to filter: the false alarm
  // needs a non-empty table, as in any real deployment.
  await admin`
    INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement)
    VALUES ('fact-vector-health', ${WS}, 'global', 'other', 's', 'a fact')
  `;
}, 180_000);

afterAll(async () => {
  for (const a of adapters) await a.close().catch(() => undefined);
  await admin?.end({ timeout: 2 }).catch(() => undefined);
  await container?.stop().catch(() => undefined);
});

describe("CHAOS-9: vector health does not read tenant rows", () => {
  it("stays ok after a workspace-scoped search reused the connection", async () => {
    const vector = vectorAdapter();
    expect((await vector.healthCheck()).status).toBe("ok");

    // A search sets the workspace GUC with SET LOCAL on a pooled connection;
    // after commit it reads back as '' on that connection.
    await vector.search({
      workspaceId: WS,
      vector: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      limit: 5,
    } as never);

    for (let i = 0; i < 3; i++) {
      const h = await vector.healthCheck();
      expect(h, JSON.stringify(h)).toMatchObject({ status: "ok" });
    }
  });

  it("still reports down when the embeddings table is missing", async () => {
    const vector = vectorAdapter({ table: "mnemo_table_that_does_not_exist" });
    expect((await vector.healthCheck()).status).toBe("down");
  });

  it("still reports down when the database is unreachable", async () => {
    const vector = new PgVectorAdapter({
      connectionString: appUrl.replace(/:(\d+)\//, ":1/"),
      dimensions: 4,
    });
    adapters.push(vector);
    expect((await vector.healthCheck()).status).toBe("down");
  });
});

describe("PG-TIMEOUTS: the vector pool is bounded too", () => {
  it("sends statement, lock and idle-in-transaction limits", async () => {
    const vector = vectorAdapter();
    const sql = (vector as unknown as { sql: ReturnType<typeof postgres> }).sql;
    const [row] = await sql<Array<Record<string, string>>>`
      SELECT current_setting('statement_timeout') AS statement,
             current_setting('lock_timeout') AS lock,
             current_setting('idle_in_transaction_session_timeout') AS idle
    `;
    expect(row).toEqual({ statement: "1min", lock: "15s", idle: "1min" });
  });
});
