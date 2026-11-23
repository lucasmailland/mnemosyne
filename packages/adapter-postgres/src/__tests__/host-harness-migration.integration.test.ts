import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { migrate } from "../migrate.js";
import { splitSqlStatements } from "../sql-split.js";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const MIGRATION_NAME = "0038_host_harness_lifecycle.sql";
const SOURCE_MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "baseline"
);
const PROVISION_APP_ROLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "docker",
  "scripts",
  "provision-app-role.mjs"
);
const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WS = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const HARNESS_TABLES = [
  "mnemo_harness_ingestion_event",
  "mnemo_harness_workspace_control",
  "mnemo_harness_loss",
  "mnemo_harness_retraction",
  "mnemo_harness_message_tombstone",
  "mnemo_managed_collapse_operation",
  "mnemo_managed_collapse_effect",
  "mnemo_extraction_provenance",
] as const;

const INDEX_TABLES: Record<string, string> = {
  idx_session_workspace_id_unique: "mnemo_session",
  idx_session_source_generation_unique: "mnemo_session",
  idx_session_turn_source_message_unique: "mnemo_session_turn",
  idx_harness_event_workspace_id_unique: "mnemo_harness_ingestion_event",
  idx_harness_event_id_unique: "mnemo_harness_ingestion_event",
  idx_harness_source_sequence_unique: "mnemo_harness_ingestion_event",
  idx_harness_tombstone_source_message_unique: "mnemo_harness_message_tombstone",
  idx_managed_collapse_session_generation_unique: "mnemo_managed_collapse_operation",
  idx_managed_collapse_operation_workspace_id_unique: "mnemo_managed_collapse_operation",
  idx_managed_collapse_effect_unique: "mnemo_managed_collapse_effect",
  idx_session_managed_activity: "mnemo_session",
  idx_session_collapse_due: "mnemo_session",
  idx_session_terminal_retention: "mnemo_session",
  idx_harness_event_retryable: "mnemo_harness_ingestion_event",
  idx_harness_loss_session: "mnemo_harness_loss",
  idx_harness_retraction_session: "mnemo_harness_retraction",
  idx_harness_tombstone_session: "mnemo_harness_message_tombstone",
  idx_managed_collapse_effect_pending: "mnemo_managed_collapse_effect",
  idx_extraction_provenance_primitive: "mnemo_extraction_provenance",
};

const INDEX_EXPECTATIONS: Record<string, { keys: string[]; predicate: string }> = {
  idx_session_workspace_id_unique: { keys: ["workspace_id", "id"], predicate: "" },
  idx_session_source_generation_unique: {
    keys: [
      "workspace_id",
      "source_host",
      "source_client_instance_id",
      "source_session_id",
      "source_generation",
    ],
    predicate:
      "source_hostisnotnullandsource_client_instance_idisnotnullandsource_session_idisnotnullandsource_generationisnotnull",
  },
  idx_session_turn_source_message_unique: {
    keys: ["workspace_id", "session_id", "source_message_id"],
    predicate: "source_message_idisnotnull",
  },
  idx_harness_event_workspace_id_unique: { keys: ["workspace_id", "id"], predicate: "" },
  idx_harness_event_id_unique: { keys: ["workspace_id", "event_id"], predicate: "" },
  idx_harness_source_sequence_unique: {
    keys: [
      "workspace_id",
      "source_host",
      "source_client_instance_id",
      "source_session_id",
      "enqueue_sequence",
    ],
    predicate: "",
  },
  idx_harness_tombstone_source_message_unique: {
    keys: [
      "workspace_id",
      "source_host",
      "source_client_instance_id",
      "source_session_id",
      "source_generation",
      "source_message_id",
    ],
    predicate: "",
  },
  idx_managed_collapse_session_generation_unique: {
    keys: ["workspace_id", "session_id", "source_generation"],
    predicate: "",
  },
  idx_managed_collapse_operation_workspace_id_unique: {
    keys: ["workspace_id", "operation_id"],
    predicate: "",
  },
  idx_managed_collapse_effect_unique: {
    keys: ["collapse_operation_id", "effect_kind", "target_kind", "target_id"],
    predicate: "",
  },
  idx_session_managed_activity: {
    keys: ["workspace_id", "last_activity_at"],
    predicate: "source_hostisnotnullandstatus='active'",
  },
  idx_session_collapse_due: {
    keys: ["workspace_id", "collapse_next_attempt_at"],
    predicate: "status='collapse_pending'",
  },
  idx_session_terminal_retention: {
    keys: ["workspace_id", "COALESCE(collapsed_at, archived_at)", "id"],
    predicate: "source_hostisnotnullandstatus=anyarray['collapsed','archived']",
  },
  idx_harness_event_retryable: {
    keys: ["workspace_id", "received_at"],
    predicate: "ledger_state='retryable'",
  },
  idx_harness_loss_session: { keys: ["workspace_id", "session_id"], predicate: "" },
  idx_harness_retraction_session: { keys: ["workspace_id", "session_id"], predicate: "" },
  idx_harness_tombstone_session: { keys: ["workspace_id", "session_id"], predicate: "" },
  idx_managed_collapse_effect_pending: {
    keys: ["workspace_id", "next_attempt_at"],
    predicate: "status=anyarray['pending','failed']",
  },
  idx_extraction_provenance_primitive: {
    keys: ["workspace_id", "primitive_kind", "primitive_id"],
    predicate: "",
  },
};

describe("0038 host harness lifecycle migration", () => {
  let container: StartedTestContainer;
  let adminUrl: string;
  let baseDir: string;
  let migrationSql: string;
  let statements: string[];
  let databaseSequence = 0;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    migrationSql = await readFile(join(SOURCE_MIGRATIONS, MIGRATION_NAME), "utf8");
    statements = splitSqlStatements(migrationSql);
    container = await new GenericContainer(PG_IMAGE)
      .withEnvironment({
        POSTGRES_USER: PG_USER,
        POSTGRES_PASSWORD: PG_PASSWORD,
        POSTGRES_DB: "postgres",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();
    adminUrl = urlFor("postgres");
    baseDir = await migrationDir(false);

    const templateUrl = await createDatabase("harness_template");
    await migrate({ databaseUrl: templateUrl, migrationsDir: baseDir, log: () => undefined });
    const template = postgres(adminUrl, { max: 1 });
    await template.unsafe("ALTER DATABASE harness_template IS_TEMPLATE true");
    await template.end();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await container?.stop();
  });

  function urlFor(database: string): string {
    return `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${database}`;
  }

  async function createDatabase(name?: string, template?: string): Promise<string> {
    databaseSequence += 1;
    const database = name ?? `harness_${databaseSequence}`;
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE ${database}${template ? ` TEMPLATE ${template}` : ""}`);
    } finally {
      await admin.end();
    }
    return urlFor(database);
  }

  async function migrationDir(include0038: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mnemo-harness-migration-"));
    tempDirs.push(dir);
    const files = (await readdir(SOURCE_MIGRATIONS))
      .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
      .filter((file) => (include0038 ? file <= MIGRATION_NAME : file < MIGRATION_NAME));
    await Promise.all(
      files.map((file) => copyFile(join(SOURCE_MIGRATIONS, file), join(dir, file)))
    );
    return dir;
  }

  async function add0038(dir: string, content = migrationSql): Promise<void> {
    await writeFile(join(dir, MIGRATION_NAME), content);
  }

  async function provisionerRuntimePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mnemo-provision-runtime-"));
    tempDirs.push(dir);
    await copyFile(PROVISION_APP_ROLE, join(dir, "provision-app-role.mjs"));
    await symlink(join(ADAPTER_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    return join(dir, "provision-app-role.mjs");
  }

  async function seedWorkspaces(
    sql: ReturnType<typeof postgres>,
    workspaceIds: readonly string[] = [WS]
  ): Promise<void> {
    await sql`
      INSERT INTO mnemosyne.mnemo_tenant (id, name)
      VALUES (${TENANT}, 'Harness tenant')
      ON CONFLICT (id) DO NOTHING
    `;
    for (const workspaceId of workspaceIds) {
      await sql`
        INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id)
        VALUES (${workspaceId}, ${`Workspace ${workspaceId}`}, ${TENANT})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  it("applies fresh with all eight tables, managed columns, status, indexes, grants, and RLS", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const dir = await migrationDir(false);
    await add0038(dir);
    await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const tables = await sql<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'mnemosyne' AND table_name LIKE 'mnemo_%'
      `;
      const names = new Set(tables.map((row) => row.table_name));
      for (const table of HARNESS_TABLES) {
        expect(names).toContain(table);
      }

      await expect(sql`
        INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status)
        VALUES ('pending-session', ${WS}, 'collapse_pending')
      `).resolves.toBeDefined();

      const indexes = await sql<Array<{ relname: string; indisvalid: boolean }>>`
        SELECT c.relname, i.indisvalid
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mnemosyne' AND c.relname LIKE '%harness%'
           OR n.nspname = 'mnemosyne' AND c.relname LIKE 'idx_session_%terminal%'
      `;
      expect(indexes.length).toBeGreaterThan(0);
      expect(indexes.every((index) => index.indisvalid)).toBe(true);

      const catalogIndexes = await sql<
        Array<{ relname: string; keys: string[]; predicate: string; definition_matches: boolean }>
      >`
        SELECT c.relname,
          ARRAY(
            SELECT pg_get_indexdef(i.indexrelid, key_position, true)
            FROM generate_series(1, i.indnkeyatts) AS key_position
            ORDER BY key_position
          ) AS keys,
          lower(regexp_replace(regexp_replace(
            COALESCE(pg_get_expr(i.indpred, i.indrelid), ''),
            '::text', '', 'g'
          ), '[[:space:]()]', '', 'g')) AS predicate,
          mnemosyne.mnemo_index_definition_matches(i.indexrelid) AS definition_matches
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mnemosyne' AND c.relname IN ${sql(Object.keys(INDEX_EXPECTATIONS))}
        ORDER BY c.relname
      `;
      expect(catalogIndexes).toHaveLength(Object.keys(INDEX_EXPECTATIONS).length);
      for (const index of catalogIndexes) {
        expect(index.keys, `${index.relname} key definition`).toEqual(
          INDEX_EXPECTATIONS[index.relname]!.keys
        );
        expect(index.predicate, `${index.relname} predicate`).toBe(
          INDEX_EXPECTATIONS[index.relname]!.predicate
        );
        expect(index.definition_matches, `${index.relname} normalized definition`).toBe(true);
      }

      const security = await sql<
        Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mnemosyne'
          AND c.relname IN (
            'mnemo_harness_ingestion_event', 'mnemo_harness_workspace_control',
            'mnemo_harness_loss', 'mnemo_harness_retraction',
            'mnemo_harness_message_tombstone', 'mnemo_managed_collapse_operation',
            'mnemo_managed_collapse_effect', 'mnemo_extraction_provenance'
          )
      `;
      expect(security).toHaveLength(8);
      expect(security.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

      const expectedPrivileges: Record<string, string[]> = {
        mnemo_harness_workspace_control: ["SELECT", "INSERT", "UPDATE"],
        mnemo_harness_ingestion_event: ["SELECT", "INSERT", "UPDATE"],
        mnemo_harness_loss: ["SELECT", "INSERT"],
        mnemo_harness_retraction: ["SELECT", "INSERT"],
        mnemo_harness_message_tombstone: ["SELECT", "INSERT"],
        mnemo_managed_collapse_operation: ["SELECT", "INSERT", "UPDATE"],
        mnemo_managed_collapse_effect: ["SELECT", "INSERT", "UPDATE"],
        mnemo_extraction_provenance: ["SELECT", "INSERT"],
      };
      for (const row of security) {
        for (const privilege of expectedPrivileges[row.relname]!) {
          const privileges = await sql<Array<{ direct: boolean; inherited: boolean }>>`
            SELECT
              has_table_privilege('mnemo_app_role', ${`mnemosyne.${row.relname}`}, ${privilege}) AS direct,
              has_table_privilege('app_user', ${`mnemosyne.${row.relname}`}, ${privilege}) AS inherited
          `;
          expect(privileges[0], `${row.relname} ${privilege}`).toEqual({
            direct: true,
            inherited: true,
          });
        }
        const deletion = await sql<Array<{ can_delete: boolean }>>`
          SELECT has_table_privilege('app_user', ${`mnemosyne.${row.relname}`}, 'DELETE') AS can_delete
        `;
        expect(deletion[0]?.can_delete, `${row.relname} DELETE`).toBe(false);
      }

      await seedWorkspaces(sql, [WS, WS_B]);
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE app_user");
        await tx`SELECT set_config('mnemosyne.workspace_id', ${WS}, true)`;
        const visible = await tx<Array<{ workspace_id: string }>>`
          SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control
        `;
        expect(visible).toEqual([{ workspace_id: WS }]);
        await expect(
          tx.savepoint(
            (savepoint) => savepoint`
              INSERT INTO mnemosyne.mnemo_harness_workspace_control (workspace_id)
              VALUES ('33333333-3333-4333-8333-333333333333')
            `
          )
        ).rejects.toThrow(/row-level security/i);
      });
    } finally {
      await sql.end();
    }
  });

  it("has forced RLS and policies before the first app-role grant can commit", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const firstGrant = statements.findIndex((statement) => /^GRANT\s/i.test(statement));
      expect(firstGrant).toBeGreaterThan(0);
      for (const statement of statements.slice(0, firstGrant)) await sql.unsafe(statement);

      const rows = await sql<
        Array<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
          policies: number;
        }>
      >`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, COUNT(p.polname)::int AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'mnemosyne' AND c.relname IN ${sql(HARNESS_TABLES)}
        GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      `;
      expect(rows).toHaveLength(HARNESS_TABLES.length);
      expect(
        rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1)
      ).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("backfills existing workspace controls and seeds every future workspace", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      await seedWorkspaces(sql, [WS]);
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      expect(
        await sql`SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control WHERE workspace_id = ${WS}`
      ).toHaveLength(1);

      await seedWorkspaces(sql, [WS_B]);
      expect(
        await sql`SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control WHERE workspace_id = ${WS_B}`
      ).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  it("preserves the exact Task 2 ACL matrix after the production provisioner", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const dir = await migrationDir(false);
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      execFileSync(process.execPath, [await provisionerRuntimePath()], {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          MNEMO_APP_DB_PASSWORD: "harness-test-password",
          MNEMO_APP_DB_USER: "harness_app",
        },
        stdio: "pipe",
      });

      const expectedAcl: Record<
        (typeof HARNESS_TABLES)[number],
        { select: boolean; insert: boolean; update: boolean; delete: boolean }
      > = {
        mnemo_harness_workspace_control: {
          select: true,
          insert: true,
          update: true,
          delete: false,
        },
        mnemo_harness_ingestion_event: {
          select: true,
          insert: true,
          update: true,
          delete: false,
        },
        mnemo_harness_loss: { select: true, insert: true, update: false, delete: false },
        mnemo_harness_retraction: { select: true, insert: true, update: false, delete: false },
        mnemo_harness_message_tombstone: {
          select: true,
          insert: true,
          update: false,
          delete: false,
        },
        mnemo_managed_collapse_operation: {
          select: true,
          insert: true,
          update: true,
          delete: false,
        },
        mnemo_managed_collapse_effect: {
          select: true,
          insert: true,
          update: true,
          delete: false,
        },
        mnemo_extraction_provenance: {
          select: true,
          insert: true,
          update: false,
          delete: false,
        },
      };
      for (const table of HARNESS_TABLES) {
        const rows = await sql<
          Array<{ select: boolean; insert: boolean; update: boolean; delete: boolean }>
        >`
          SELECT
            has_table_privilege('app_user', ${`mnemosyne.${table}`}, 'SELECT') AS select,
            has_table_privilege('app_user', ${`mnemosyne.${table}`}, 'INSERT') AS insert,
            has_table_privilege('app_user', ${`mnemosyne.${table}`}, 'UPDATE') AS update,
            has_table_privilege('app_user', ${`mnemosyne.${table}`}, 'DELETE') AS delete
        `;
        expect(rows[0], table).toEqual(expectedAcl[table]);
      }

      await seedWorkspaces(sql);
      await sql`
        INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status)
        VALUES ('acl-cascade-session', ${WS}, 'active')
      `;
      await sql`
        INSERT INTO mnemosyne.mnemo_managed_collapse_operation
          (operation_id, workspace_id, session_id, source_generation, lease_owner)
        VALUES ('acl-cascade-operation', ${WS}, 'acl-cascade-session', 0, 'test')
      `;
      await sql`
        INSERT INTO mnemosyne.mnemo_managed_collapse_effect
          (workspace_id, collapse_operation_id, effect_kind, target_kind, target_id)
        VALUES (${WS}, 'acl-cascade-operation', 'publish', 'fact', 'fact-1')
      `;
      await sql`
        INSERT INTO mnemosyne.mnemo_extraction_provenance
          (workspace_id, collapse_operation_id, session_id, primitive_kind, primitive_id,
           origin_actor_id, origin_actor_type, sensitivity, sensitivity_ceiling)
        VALUES (${WS}, 'acl-cascade-operation', 'acl-cascade-session', 'fact', 'fact-1',
                'system:test', 'system', 'internal', 'internal')
      `;
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE app_user");
        await tx`SELECT set_config('mnemosyne.workspace_id', ${WS}, true)`;
        await expect(
          tx.savepoint(
            (savepoint) => savepoint`
              DELETE FROM mnemosyne.mnemo_managed_collapse_operation
              WHERE operation_id = 'acl-cascade-operation'
            `
          )
        ).rejects.toThrow(/permission denied/i);
      });
      const cascadeProtected = await sql<Array<{ effects: number; provenance: number }>>`
        SELECT
          (SELECT count(*)::int FROM mnemosyne.mnemo_managed_collapse_effect
           WHERE collapse_operation_id = 'acl-cascade-operation') AS effects,
          (SELECT count(*)::int FROM mnemosyne.mnemo_extraction_provenance
           WHERE collapse_operation_id = 'acl-cascade-operation') AS provenance
      `;
      expect(cascadeProtected[0]).toEqual({ effects: 1, provenance: 1 });

      const unrelated = await sql<Array<{ can_delete: boolean }>>`
        SELECT has_table_privilege('app_user', 'mnemosyne.mnemo_fact', 'DELETE') AS can_delete
      `;
      expect(unrelated[0]?.can_delete).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("enforces workspace-consistent foreign keys for every new parent link", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      await seedWorkspaces(sql, [WS, WS_B]);
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      const expected = [
        "mnemo_session_predecessor_workspace_fkey",
        "mnemo_session_turn_ingestion_event_workspace_fkey",
        "mnemo_session_turn_session_workspace_fkey",
        "mnemo_harness_ingestion_event_session_workspace_fkey",
        "mnemo_harness_loss_session_workspace_fkey",
        "mnemo_harness_loss_event_workspace_fkey",
        "mnemo_harness_retraction_session_workspace_fkey",
        "mnemo_harness_retraction_event_workspace_fkey",
        "mnemo_harness_retraction_predecessor_workspace_fkey",
        "mnemo_harness_tombstone_session_workspace_fkey",
        "mnemo_managed_collapse_operation_session_workspace_fkey",
        "mnemo_managed_collapse_effect_operation_workspace_fkey",
        "mnemo_extraction_provenance_operation_workspace_fkey",
        "mnemo_extraction_provenance_session_workspace_fkey",
      ];
      const constraints = await sql<Array<{ conname: string; definition: string }>>`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conname IN ${sql(expected)} ORDER BY conname
      `;
      expect(constraints.map((row) => row.conname)).toEqual([...expected].sort());
      expect(
        constraints.every((row) =>
          row.conname.startsWith("mnemo_session_turn_")
            ? /FOREIGN KEY \(ingestion_event_workspace_id,/.test(row.definition)
            : /FOREIGN KEY \(workspace_id,/.test(row.definition)
        )
      ).toBe(true);
      expect(
        constraints.find((row) => row.conname === "mnemo_session_predecessor_workspace_fkey")
          ?.definition
      ).toMatch(
        /REFERENCES mnemosyne\.mnemo_session\(workspace_id, id\) ON DELETE SET NULL \(predecessor_session_id\)/i
      );
      expect(
        constraints.find(
          (row) => row.conname === "mnemo_session_turn_ingestion_event_workspace_fkey"
        )?.definition
      ).toMatch(
        /REFERENCES mnemosyne\.mnemo_harness_ingestion_event\(workspace_id, id\) ON DELETE SET NULL \(ingestion_event_id\)/i
      );

      await sql`INSERT INTO mnemosyne.mnemo_session (id, workspace_id) VALUES ('session-a', ${WS})`;
      await expect(sql`
        INSERT INTO mnemosyne.mnemo_harness_ingestion_event
          (workspace_id, event_id, source_host, source_client_instance_id, source_session_id,
           enqueue_sequence, event_type, payload_hash, normalization_version, occurred_at, session_id,
           origin_actor_id, origin_actor_type, origin_sensitivity_ceiling)
        VALUES (${WS_B}, 'event-cross', 'codex', 'client', 'source', 1, 'session.start',
                repeat('a', 64), 1, now(), 'session-a', 'key:test', 'agent', 'internal')
      `).rejects.toThrow(/session_workspace_fkey/i);
    } finally {
      await sql.end();
    }
  });

  it("denies app_user cross-workspace turns and cascades only the deleted workspace session", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      await seedWorkspaces(sql, [WS, WS_B]);
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      await sql`
        INSERT INTO mnemosyne.mnemo_session (id, workspace_id)
        VALUES ('session-a', ${WS}), ('session-b', ${WS_B})
      `;

      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE app_user");
        await tx`SELECT set_config('mnemosyne.workspace_id', ${WS_B}, true)`;
        await expect(
          tx.savepoint(
            (savepoint) => savepoint`
            INSERT INTO mnemosyne.mnemo_session_turn
              (workspace_id, session_id, turn_index, role, content)
            VALUES (${WS_B}::uuid, 'session-a', 0, 'user', 'cross workspace')
          `
          )
        ).rejects.toThrow(/mnemo_session_turn_session_workspace_fkey/i);
        await tx`
          INSERT INTO mnemosyne.mnemo_session_turn
            (workspace_id, session_id, turn_index, role, content)
          VALUES (${WS_B}::uuid, 'session-b', 0, 'user', 'workspace b')
        `;
      });
      await sql`
        INSERT INTO mnemosyne.mnemo_session_turn
          (workspace_id, session_id, turn_index, role, content)
        VALUES (${WS}::uuid, 'session-a', 0, 'user', 'workspace a')
      `;

      await sql`DELETE FROM mnemosyne.mnemo_session WHERE id = 'session-a'`;
      const turns = await sql<Array<{ session_id: string }>>`
        SELECT session_id FROM mnemosyne.mnemo_session_turn ORDER BY session_id
      `;
      expect(turns).toEqual([{ session_id: "session-b" }]);
    } finally {
      await sql.end();
    }
  });

  it("increments fence_epoch only through ingestion state transitions", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      await seedWorkspaces(sql, [WS]);
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });

      await sql`
        UPDATE mnemosyne.mnemo_harness_workspace_control
        SET metadata = '{"reason":"metadata-only"}'::jsonb
        WHERE workspace_id = ${WS}
      `;
      let rows = await sql<Array<{ ingestion_enabled: boolean; fence_epoch: string }>>`
        SELECT ingestion_enabled, fence_epoch::text FROM mnemosyne.mnemo_harness_workspace_control
        WHERE workspace_id = ${WS}
      `;
      expect(rows[0]).toEqual({ ingestion_enabled: true, fence_epoch: "0" });

      await sql`
        UPDATE mnemosyne.mnemo_harness_workspace_control
        SET ingestion_enabled = false
        WHERE workspace_id = ${WS}
      `;
      await sql`
        UPDATE mnemosyne.mnemo_harness_workspace_control
        SET ingestion_enabled = true, fence_epoch = 0
        WHERE workspace_id = ${WS}
      `;
      rows = await sql<Array<{ ingestion_enabled: boolean; fence_epoch: string }>>`
        SELECT ingestion_enabled, fence_epoch::text FROM mnemosyne.mnemo_harness_workspace_control
        WHERE workspace_id = ${WS}
      `;
      expect(rows[0]).toEqual({ ingestion_enabled: true, fence_epoch: "2" });

      await expect(sql`
        UPDATE mnemosyne.mnemo_harness_workspace_control
        SET fence_epoch = 3
        WHERE workspace_id = ${WS}
      `).rejects.toThrow(/fence_epoch.*state transition/i);
    } finally {
      await sql.end();
    }
  });

  it("keeps last_activity_at current for legacy append SQL after expansion", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      await sql`INSERT INTO mnemosyne.mnemo_session (id, workspace_id, started_at) VALUES ('cutover-session', ${WS}, '2026-01-01T00:00:00Z')`;
      await sql`
        INSERT INTO mnemosyne.mnemo_session_turn
          (workspace_id, session_id, turn_index, role, content, created_at)
        VALUES (${WS}::uuid, 'cutover-session', 0, 'user', 'legacy append', '2026-02-01T00:00:00Z')
      `;
      const rows = await sql<Array<{ last_activity_at: Date }>>`
        SELECT last_activity_at FROM mnemosyne.mnemo_session WHERE id = 'cutover-session'
      `;
      expect(rows[0]?.last_activity_at.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    } finally {
      await sql.end();
    }
  });

  it("preserves legacy lifecycle through the real DrizzleStorageAdapter", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    let client: ReturnType<typeof createDrizzleClient> | undefined;
    try {
      await seedWorkspaces(sql, [WS]);
      // Legacy lifecycle rows written before 0038 existed.
      await sql`
        INSERT INTO mnemosyne.mnemo_session (id, workspace_id, status)
        VALUES ('legacy-active', ${WS}, 'active'), ('legacy-collapsed', ${WS}, 'collapsed')
      `;
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      // The adapter writes columns added after 0038, so bring the schema current
      // before driving it — the legacy rows must survive that too.
      const later = (await readdir(SOURCE_MIGRATIONS)).filter(
        (file) => file.endsWith(".sql") && !file.endsWith(".down.sql") && file > MIGRATION_NAME
      );
      await Promise.all(
        later.map((file) => copyFile(join(SOURCE_MIGRATIONS, file), join(dir, file)))
      );
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      client = createDrizzleClient(databaseUrl);
      const adapter = new DrizzleStorageAdapter(client.db, client.pgClient);

      expect(await adapter.getSession("legacy-active", WS)).toMatchObject({ status: "active" });
      expect(await adapter.getSession("legacy-collapsed", WS)).toMatchObject({
        status: "collapsed",
      });
      await adapter.appendTurn("legacy-active", {
        workspaceId: WS,
        sessionId: "legacy-active",
        turnIndex: 0,
        role: "user",
        content: "turn on a pre-0038 session",
      });
      await adapter.closeSession("legacy-active", WS);
      expect(await adapter.getSession("legacy-active", WS)).toMatchObject({ status: "collapsed" });

      const closed = await adapter.createSession({ workspaceId: WS });
      await adapter.appendTurn(closed.id, {
        workspaceId: WS,
        sessionId: closed.id,
        turnIndex: 0,
        role: "user",
        content: "legacy adapter turn",
      });
      expect(await adapter.listTurns(closed.id, WS)).toHaveLength(1);
      await adapter.closeSession(closed.id, WS);
      expect(await adapter.getSession(closed.id, WS)).toMatchObject({ status: "collapsed" });

      const archived = await adapter.createSession({ workspaceId: WS });
      await adapter.archiveSession(archived.id, WS);
      expect(await adapter.getSession(archived.id, WS)).toMatchObject({ status: "archived" });
      expect(closed.sourceHost).toBeUndefined();
      expect(archived.sourceHost).toBeUndefined();
    } finally {
      await client?.pgClient.end().catch(() => undefined);
      await sql.end();
    }
  });

  it("repairs valid fixed-name indexes with wrong definitions and predicates", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      const firstIndex = statements.findIndex((statement) =>
        /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(statement)
      );
      expect(firstIndex).toBeGreaterThan(0);
      for (const statement of statements.slice(0, firstIndex)) await sql.unsafe(statement);
      for (const [name, table] of Object.entries(INDEX_TABLES)) {
        await sql.unsafe(`CREATE INDEX ${name} ON mnemosyne.${table} ((1))`);
      }
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });

      const definitions = await sql<Array<{ relname: string; definition: string }>>`
        SELECT c.relname, pg_get_indexdef(c.oid) AS definition
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mnemosyne' AND c.relname IN ${sql(Object.keys(INDEX_TABLES))}
        ORDER BY c.relname
      `;
      expect(definitions).toHaveLength(Object.keys(INDEX_TABLES).length);
      expect(definitions.every((row) => !/\(1\)/.test(row.definition))).toBe(true);
      expect(
        definitions.find((row) => row.relname === "idx_session_terminal_retention")?.definition
      ).toMatch(
        /\(workspace_id, COALESCE\(collapsed_at, archived_at\), id\).*WHERE.*source_host IS NOT NULL.*status = ANY.*collapsed.*archived/i
      );
    } finally {
      await sql.end();
    }
  });

  it("repairs non-positive harness sequence constraints after an interrupted migration", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    const constraints = [
      [
        "mnemo_session",
        "mnemo_session_terminal_sequence_safe_check",
        "terminal_max_enqueue_sequence",
      ],
      [
        "mnemo_harness_ingestion_event",
        "mnemo_harness_ingestion_event_enqueue_sequence_check",
        "enqueue_sequence",
      ],
      [
        "mnemo_harness_ingestion_event",
        "mnemo_harness_ingestion_event_enqueue_sequence_safe_check",
        "enqueue_sequence",
      ],
      ["mnemo_harness_loss", "mnemo_harness_loss_enqueue_sequence_check", "enqueue_sequence"],
      ["mnemo_harness_loss", "mnemo_harness_loss_enqueue_sequence_safe_check", "enqueue_sequence"],
    ] as const;
    try {
      const firstIndex = statements.findIndex((statement) =>
        /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(statement)
      );
      for (const statement of statements.slice(0, firstIndex)) await sql.unsafe(statement);
      for (const [table, name, column] of constraints) {
        await sql.unsafe(`ALTER TABLE mnemosyne.${table} DROP CONSTRAINT IF EXISTS ${name}`);
        await sql.unsafe(
          `ALTER TABLE mnemosyne.${table} ADD CONSTRAINT ${name} CHECK (${column} IS NULL OR ${column} BETWEEN 0 AND 9007199254740991) NOT VALID`
        );
      }

      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      await expect(
        migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })
      ).resolves.toMatchObject({ applied: [] });

      const definitions = await sql<Array<{ conname: string; definition: string }>>`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname IN ${sql(constraints.map(([, name]) => name))}
        ORDER BY conname
      `;
      expect(definitions).toHaveLength(constraints.length);
      expect(definitions.every((row) => />= 1/.test(row.definition))).toBe(true);
      expect(definitions.every((row) => !/>= 0/.test(row.definition))).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("repairs every fixed-name index with a hidden INCLUDE near-match", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    const includeByTable: Record<string, string> = {
      mnemo_session: "started_at",
      mnemo_session_turn: "created_at",
      mnemo_harness_ingestion_event: "occurred_at",
      mnemo_harness_message_tombstone: "deleted_at",
      mnemo_managed_collapse_operation: "created_at",
      mnemo_managed_collapse_effect: "created_at",
      mnemo_harness_loss: "created_at",
      mnemo_harness_retraction: "created_at",
      mnemo_extraction_provenance: "created_at",
    };
    try {
      const firstIndex = statements.findIndex((statement) =>
        /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(statement)
      );
      for (const statement of statements.slice(0, firstIndex)) await sql.unsafe(statement);
      for (const [name, table] of Object.entries(INDEX_TABLES)) {
        const create = statements.find((statement) =>
          new RegExp(
            `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+CONCURRENTLY(?:\\s+IF NOT EXISTS)?\\s+${name}\\b`,
            "i"
          ).test(statement)
        );
        expect(create, name).toBeDefined();
        const include = ` INCLUDE (${includeByTable[table]!})`;
        const wrong = create!
          .replace(/\s+CONCURRENTLY/i, "")
          .replace(/\s+IF NOT EXISTS/i, "")
          .replace(/(\s+WHERE\s+)/i, `${include}$1`)
          .replace(/;?$/, (end) => (create!.match(/\s+WHERE\s+/i) ? end : `${include}${end}`));
        await sql.unsafe(wrong);
      }
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      const rows = await sql<Array<{ definition: string }>>`
        SELECT pg_get_indexdef(c.oid) AS definition
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mnemosyne' AND c.relname IN ${sql(Object.keys(INDEX_TABLES))}
      `;
      expect(rows).toHaveLength(Object.keys(INDEX_TABLES).length);
      expect(rows.every((row) => !/\bINCLUDE\b/i.test(row.definition))).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("repairs a fixed-name index built with the wrong access method", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      const firstIndex = statements.findIndex((statement) =>
        /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(statement)
      );
      for (const statement of statements.slice(0, firstIndex)) await sql.unsafe(statement);
      await sql.unsafe(
        "CREATE INDEX idx_harness_loss_session ON mnemosyne.mnemo_harness_loss USING hash (workspace_id)"
      );
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
      const rows = await sql<Array<{ access_method: string }>>`
        SELECT am.amname AS access_method
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE i.indexrelid = 'mnemosyne.idx_harness_loss_session'::regclass
      `;
      expect(rows[0]?.access_method).toBe("btree");
    } finally {
      await sql.end();
    }
  });

  it("backfills legacy activity and preserves null-source create, append, read, close, and archive", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      await sql`
        INSERT INTO mnemosyne.mnemo_session (id, workspace_id, started_at)
        VALUES
          ('legacy-with-turns', ${WS}, '2026-01-01T00:00:00Z'),
          ('legacy-no-turns', ${WS}, '2026-01-02T00:00:00Z')
      `;
      await sql`
        INSERT INTO mnemosyne.mnemo_session_turn
          (workspace_id, session_id, turn_index, role, content, created_at)
        VALUES
          (${WS}::uuid, 'legacy-with-turns', 0, 'user', 'first', '2026-01-03T00:00:00Z'),
          (${WS}::uuid, 'legacy-with-turns', 1, 'assistant', 'last', '2026-01-04T00:00:00Z')
      `;
      await add0038(dir);
      await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });

      const activity = await sql<Array<{ id: string; last_activity_at: Date }>>`
        SELECT id, last_activity_at FROM mnemosyne.mnemo_session
        WHERE id IN ('legacy-with-turns', 'legacy-no-turns') ORDER BY id
      `;
      expect(activity.map((row) => [row.id, row.last_activity_at.toISOString()])).toEqual([
        ["legacy-no-turns", "2026-01-02T00:00:00.000Z"],
        ["legacy-with-turns", "2026-01-04T00:00:00.000Z"],
      ]);

      await sql`
        INSERT INTO mnemosyne.mnemo_session (id, workspace_id)
        VALUES ('legacy-after-expand', ${WS})
      `;
      await sql`
        INSERT INTO mnemosyne.mnemo_session_turn
          (workspace_id, session_id, turn_index, role, content)
        VALUES (${WS}::uuid, 'legacy-after-expand', 0, 'user', 'still works')
      `;
      await sql`
        UPDATE mnemosyne.mnemo_session SET status = 'collapsed', collapsed_at = now()
        WHERE id = 'legacy-after-expand'
      `;
      await sql`
        UPDATE mnemosyne.mnemo_session
        SET status = 'archived', archived_at = now()
        WHERE id = 'legacy-no-turns'
      `;
      const legacy = await sql<Array<{ id: string; source_host: string | null; status: string }>>`
        SELECT id, source_host, status FROM mnemosyne.mnemo_session
        WHERE id IN ('legacy-after-expand', 'legacy-no-turns') ORDER BY id
      `;
      expect(legacy).toEqual([
        { id: "legacy-after-expand", source_host: null, status: "collapsed" },
        { id: "legacy-no-turns", source_host: null, status: "archived" },
      ]);
    } finally {
      await sql.end();
    }
  });

  it("aborts duplicate non-null source identities before creating the unique index", async () => {
    const databaseUrl = await createDatabase(undefined, "harness_template");
    const sql = postgres(databaseUrl, { max: 1 });
    const dir = await migrationDir(false);
    try {
      const duplicateGuardIndex = statements.findIndex((statement) =>
        /duplicate.*source.*identit/is.test(statement)
      );
      expect(duplicateGuardIndex).toBeGreaterThan(0);
      for (const statement of statements.slice(0, duplicateGuardIndex)) {
        await sql.unsafe(statement);
      }
      await sql`
        INSERT INTO mnemosyne.mnemo_session
          (id, workspace_id, source_host, source_client_instance_id, source_session_id, source_generation)
        VALUES
          ('duplicate-a', ${WS}, 'codex', 'client-a', 'source-a', 0),
          ('duplicate-b', ${WS}, 'codex', 'client-a', 'source-a', 0)
      `;
      await add0038(dir);

      await expect(
        migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })
      ).rejects.toThrow(/duplicate.*source.*identit/i);
      const index = await sql`
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'mnemosyne' AND c.relname = 'idx_session_source_generation_unique'
      `;
      expect(index).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  it("recovers every invalid fixed-name concurrent index", async () => {
    const uniqueIndexes = new Set([
      "idx_session_source_generation_unique",
      "idx_session_turn_source_message_unique",
      "idx_harness_event_id_unique",
      "idx_harness_source_sequence_unique",
      "idx_harness_tombstone_source_message_unique",
      "idx_managed_collapse_session_generation_unique",
      "idx_managed_collapse_effect_unique",
    ]);
    for (const indexName of [
      ...uniqueIndexes,
      "idx_session_managed_activity",
      "idx_session_collapse_due",
      "idx_session_terminal_retention",
      "idx_harness_event_retryable",
      "idx_harness_loss_session",
      "idx_harness_retraction_session",
      "idx_harness_tombstone_session",
      "idx_managed_collapse_effect_pending",
      "idx_extraction_provenance_primitive",
    ]) {
      const databaseUrl = await createDatabase(undefined, "harness_template");
      const sql = postgres(databaseUrl, { max: 1 });
      const dir = await migrationDir(false);
      try {
        const createIndex = statements.findIndex((statement) =>
          new RegExp(
            `CREATE ${uniqueIndexes.has(indexName) ? "UNIQUE " : ""}INDEX CONCURRENTLY(?: IF NOT EXISTS)? ${indexName}`,
            "i"
          ).test(statement)
        );
        expect(createIndex).toBeGreaterThan(0);
        for (const statement of statements.slice(0, createIndex)) {
          await sql.unsafe(statement);
        }
        const create = statements[createIndex]!;
        const tableMatch = create.match(/ON\s+mnemosyne\.([a-z0-9_]+)/i);
        expect(tableMatch?.[1]).toBeDefined();
        await sql.unsafe(`CREATE INDEX ${indexName} ON mnemosyne.${tableMatch![1]} ((1))`);
        await sql.unsafe(
          `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'mnemosyne.${indexName}'::regclass`
        );
        await add0038(dir);
        await migrate({ databaseUrl, migrationsDir: dir, log: () => undefined });
        const rows = await sql<Array<{ indisvalid: boolean; indisunique: boolean }>>`
          SELECT indisvalid, indisunique FROM pg_index
          WHERE indexrelid = ${`mnemosyne.${indexName}`}::regclass
        `;
        expect(rows[0]).toEqual({
          indisvalid: true,
          indisunique: uniqueIndexes.has(indexName),
        });
      } finally {
        await sql.end();
      }
    }
  }, 120_000);

  it("reruns successfully after failure following every top-level statement", async () => {
    for (let index = 0; index < statements.length; index += 1) {
      const databaseUrl = await createDatabase(undefined, "harness_template");
      const dir = await migrationDir(false);
      const partial = [
        "-- migrate:no-transaction",
        ...statements.slice(0, index + 1).map((statement) => `${statement};`),
        "SELECT definitely_missing_host_harness_restart_probe();",
      ].join("\n");
      await add0038(dir, partial);
      await expect(
        migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })
      ).rejects.toThrow(/definitely_missing_host_harness_restart_probe/i);
      await add0038(dir);
      await expect(
        migrate({ databaseUrl, migrationsDir: dir, log: () => undefined })
      ).resolves.toMatchObject({ applied: [MIGRATION_NAME] });
    }
  }, 600_000);
});
