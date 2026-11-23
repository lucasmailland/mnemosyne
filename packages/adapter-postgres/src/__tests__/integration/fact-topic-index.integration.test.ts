import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { migrate } from "../../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const SOURCE_MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
  "baseline",
);

describe("0007 active fact topic-key index", () => {
  let container: StartedTestContainer;
  let adminUrl: string;
  const tempDirs: string[] = [];
  let databaseSequence = 0;

  beforeAll(async () => {
    container = await new GenericContainer(PG_IMAGE)
      .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: "postgres" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();
    adminUrl = urlFor("postgres");
  }, 120_000);

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await container?.stop();
  });

  function urlFor(database: string): string {
    return `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${database}`;
  }

  async function createDatabase(): Promise<string> {
    databaseSequence += 1;
    const name = `topic_index_${databaseSequence}`;
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    return urlFor(name);
  }

  async function migrationDir(include0007: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mnemo-topic-index-"));
    tempDirs.push(dir);
    const files = (await readdir(SOURCE_MIGRATIONS))
      .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
      .filter((file) => include0007 || !file.startsWith("0007_"));
    await Promise.all(files.map((file) => copyFile(join(SOURCE_MIGRATIONS, file), join(dir, file))));
    return dir;
  }

  async function add0007(dir: string): Promise<void> {
    await copyFile(
      join(SOURCE_MIGRATIONS, "0007_fact_topic_key_unique.sql"),
      join(dir, "0007_fact_topic_key_unique.sql"),
    );
  }

  async function insertFact(
    sql: ReturnType<typeof postgres>,
    id: string,
    topicKey: string,
    status: "active" | "merged" | "forgotten" = "active",
  ): Promise<void> {
    await sql`
      INSERT INTO mnemosyne.mnemo_fact
        (id, workspace_id, scope, kind, subject, statement, topic_key, status)
      VALUES
        (${id}, '11111111-1111-1111-1111-111111111111', 'global', 'other', 'subject', ${id}, ${topicKey}, ${status})
    `;
  }

  async function readIndex(sql: ReturnType<typeof postgres>) {
    const rows = await sql<Array<{ indisunique: boolean; indisvalid: boolean; predicate: string }>>`
      SELECT i.indisunique, i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_fact_topic_active_unique'
    `;
    return rows[0];
  }

  it("creates a valid partial unique index on clean data", async () => {
    const databaseUrl = await createDatabase();
    const dir = await migrationDir(true);
    await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const index = await readIndex(sql);
      expect(index).toMatchObject({ indisunique: true, indisvalid: true });
      expect(index?.predicate).toContain("topic_key IS NOT NULL");
      expect(index?.predicate).toContain("status = 'active'::text");
    } finally {
      await sql.end();
    }
  });

  it("rejects active duplicates with diagnostics and does not record 0007", async () => {
    const databaseUrl = await createDatabase();
    const dir = await migrationDir(false);
    await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await insertFact(sql, "duplicate-1", "deploy-target");
      await insertFact(sql, "duplicate-2", "deploy-target");
      await add0007(dir);

      await expect(migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })).rejects.toThrow(
        /workspace_id=.*topic_key=deploy-target.*count=2/i,
      );
      const rows = await sql`
        SELECT filename FROM mnemosyne.schema_migrations
        WHERE filename = '0007_fact_topic_key_unique.sql'
      `;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  it("allows duplicate topic keys when no more than one row is active", async () => {
    const databaseUrl = await createDatabase();
    const dir = await migrationDir(false);
    await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await insertFact(sql, "historical-1", "deploy-target", "forgotten");
      await insertFact(sql, "historical-2", "deploy-target", "merged");
      await add0007(dir);

      await expect(migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })).resolves.toMatchObject({
        applied: ["0007_fact_topic_key_unique.sql"],
      });
      expect(await readIndex(sql)).toMatchObject({ indisunique: true, indisvalid: true });
    } finally {
      await sql.end();
    }
  });

  it("drops and rebuilds an invalid fixed-name concurrent index", async () => {
    const databaseUrl = await createDatabase();
    const dir = await migrationDir(false);
    await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await insertFact(sql, "invalid-1", "deploy-target");
      await insertFact(sql, "invalid-2", "deploy-target");
      await expect(sql.unsafe(`
        CREATE UNIQUE INDEX CONCURRENTLY idx_fact_topic_active_unique
        ON mnemosyne.mnemo_fact (workspace_id, topic_key)
        WHERE topic_key IS NOT NULL AND status = 'active'
      `)).rejects.toThrow();
      expect(await readIndex(sql)).toMatchObject({ indisunique: true, indisvalid: false });

      await sql`DELETE FROM mnemosyne.mnemo_fact WHERE id = 'invalid-2'`;
      await add0007(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });

      expect(await readIndex(sql)).toMatchObject({ indisunique: true, indisvalid: true });
    } finally {
      await sql.end();
    }
  });
});
