/**
 * Q-3 (end-to-end verification of the eval fixes) — migration 0048 widens
 * `mnemo_fact_kind_check` to the categories agents file facts under
 * (architecture, bugfix, config, discovery, policy, process).
 *
 * Proven against real Postgres as the production role (`mnemo_app_role`
 * member: NOSUPERUSER NOBYPASSRLS, FORCE RLS), plus the down and a re-run of
 * the up, which no other test exercises.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MnemoFact } from "@mnemo-ai/types";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { splitSqlStatements } from "../sql-split.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_q3_pass";

const WS = "63636363-6363-4363-8363-636363636363";
const AGENT_KINDS = ["architecture", "bugfix", "config", "discovery", "policy", "process"] as const;

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let adapter: DrizzleStorageAdapter;
let closeApp: () => Promise<void>;
let superUrl: string;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl: superUrl, log: () => void 0 });

  superSql = postgres(superUrl, { onnotice: () => void 0, max: 3 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public TO ${APP_USER};
  `);

  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;
  const { db, pgClient } = createDrizzleClient(appUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
  closeApp = () => pgClient.end();
}, 180_000);

afterAll(async () => {
  await closeApp?.().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

function createFact(kind: string) {
  return adapter.createFact({
    workspaceId: WS,
    scope: "global",
    statement: `q3 ${kind} fact ${crypto.randomUUID()}`,
    subject: "q3",
    kind: kind as MnemoFact["kind"],
  });
}

describe("migration 0048 — fact kinds agents send", () => {
  it.each(AGENT_KINDS)("stores a '%s' fact as the restricted role", async (kind) => {
    const fact = await createFact(kind);
    const [row] = await superSql<Array<{ kind: string }>>`
      SELECT kind FROM mnemosyne.mnemo_fact WHERE id = ${fact.id}`;
    expect(row!.kind).toBe(kind);
  });

  it("still refuses a kind nobody declared", async () => {
    await expect(createFact("deployment")).rejects.toThrow();
  });

  it("down refuses while a new kind is in use, then restores the old CHECK; up re-runs", async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "baseline");
    const up = await readFile(join(dir, "0048_fact_kind_agent_subtypes.sql"), "utf8");
    const down = await readFile(join(dir, "0048_fact_kind_agent_subtypes.down.sql"), "utf8");
    expect(up).toMatch(/migrate:no-transaction/);
    const runUp = async () => {
      for (const stmt of splitSqlStatements(up)) await superSql.unsafe(stmt);
    };
    // The down carries its own BEGIN/COMMIT: one connection, like psql.
    const runDown = async () => {
      const one = postgres(superUrl, { onnotice: () => void 0, max: 1 });
      try {
        await one.unsafe(down);
      } finally {
        await one.end().catch(() => void 0);
      }
    };
    const kindCheck = async () =>
      (
        await superSql<Array<{ def: string; valid: boolean }>>`
          SELECT pg_get_constraintdef(oid) AS def, convalidated AS valid
          FROM pg_constraint WHERE conname = 'mnemo_fact_kind_check'`
      )[0]!;

    await createFact("config");
    await expect(runDown()).rejects.toThrow(/re-kind them first/);
    expect((await kindCheck()).def).toContain("'config'::text");

    await superSql`
      DELETE FROM mnemosyne.mnemo_fact
      WHERE kind IN ('architecture', 'bugfix', 'config', 'discovery', 'policy', 'process')`;
    await runDown();
    expect((await kindCheck()).def).not.toContain("'config'::text");
    await expect(createFact("config")).rejects.toThrow();

    await runUp();
    await runUp(); // idempotent
    const check = await kindCheck();
    expect(check.valid).toBe(true);
    for (const kind of AGENT_KINDS) expect(check.def).toContain(`'${kind}'::text`);
    await expect(createFact("process")).resolves.toMatchObject({ kind: "process" });
  });
});
