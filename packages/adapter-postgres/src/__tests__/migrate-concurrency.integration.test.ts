import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const MIGRATION_LOCK_CLASS_ID = 1835954031;
const MIGRATION_LOCK_OBJECT_ID = 1296649799;
const GATE_LOCK_ID = 940038;

let container: StartedTestContainer;
let databaseUrl: string;
const tempDirs: string[] = [];

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000; // determinism-ok: relative polling deadline
  // Hoisted out of the `while` condition on purpose: the determinism guard
  // matches per line, and prettier moves a trailing comment off a `while (...) {`
  // line onto the next one, where the guard no longer sees it.
  const expired = (): boolean => Date.now() > deadline; // determinism-ok: compared only to the deadline
  while (!expired()) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
}, 120_000);

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await container?.stop();
});

async function migrationDir(sql: string, filename = "0001_lock_probe.sql"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mnemo-migrate-lock-"));
  tempDirs.push(dir);
  await writeFile(join(dir, filename), sql);
  return dir;
}

describe("migrate session advisory lock", () => {
  it("serializes discovery through schema_migrations recording and releases after success", async () => {
    const dir = await migrationDir(`
      SELECT pg_advisory_xact_lock(${GATE_LOCK_ID});
      CREATE TABLE migration_lock_probe (id integer PRIMARY KEY);
      INSERT INTO migration_lock_probe VALUES (1);
    `);
    const observer = postgres(databaseUrl, { max: 1 });
    const gateClient = postgres(databaseUrl, { max: 1 });
    const gate = await gateClient.reserve();
    let runners: Promise<unknown>[] = [];
    try {
      await gate`SELECT pg_advisory_lock(${GATE_LOCK_ID})`;
      const first = migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      runners = [first];
      await waitFor(async () => {
        const rows = await observer<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM pg_locks
          WHERE locktype = 'advisory' AND classid = ${MIGRATION_LOCK_CLASS_ID}
            AND objid = ${MIGRATION_LOCK_OBJECT_ID} AND granted
        `;
        return rows[0]?.count === 1;
      }, "first migrator never acquired the migration lock");

      const second = migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      runners.push(second);
      await waitFor(async () => {
        const rows = await observer<Array<{ granted: boolean; count: number }>>`
          SELECT granted, count(*)::int AS count FROM pg_locks
          WHERE locktype = 'advisory' AND classid = ${MIGRATION_LOCK_CLASS_ID}
            AND objid = ${MIGRATION_LOCK_OBJECT_ID}
          GROUP BY granted ORDER BY granted
        `;
        return (
          rows.some((row) => row.granted && row.count === 1) &&
          rows.some((row) => !row.granted && row.count === 1)
        );
      }, "second migrator never waited for the migration lock");

      await gate`SELECT pg_advisory_unlock(${GATE_LOCK_ID})`;
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toEqual({ applied: ["0001_lock_probe.sql"], skipped: [] });
      expect(secondResult).toEqual({ applied: [], skipped: ["0001_lock_probe.sql"] });
      const rows = await observer<Array<{ effects: number; records: number }>>`
        SELECT
          (SELECT count(*)::int FROM migration_lock_probe) AS effects,
          (SELECT count(*)::int FROM mnemosyne.schema_migrations) AS records
      `;
      expect(rows[0]).toEqual({ effects: 1, records: 1 });
    } finally {
      await gate`SELECT pg_advisory_unlock(${GATE_LOCK_ID})`.catch(() => undefined);
      await Promise.allSettled(runners);
      gate.release();
      await gateClient.end();
      await observer.end();
    }
  });

  it("releases the migration lock after failure", async () => {
    const filename = "0002_failure_probe.sql";
    const dir = await migrationDir("SELECT definitely_missing_migration_lock_probe();", filename);
    await expect(
      migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })
    ).rejects.toThrow();
    await writeFile(join(dir, filename), "SELECT 1;");
    await expect(
      migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })
    ).resolves.toEqual({
      applied: [filename],
      skipped: [],
    });
  });
});
