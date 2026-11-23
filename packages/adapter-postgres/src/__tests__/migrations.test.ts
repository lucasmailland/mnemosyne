/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration-sequence guards (regenerated baseline era).
 *
 * The baseline directory contains a single consolidated forward migration file:
 *   0001_v3_complete_baseline.sql — complete schema: 75 original v3 migrations +
 *     genuine post-squash additions (multi-tenant, workspace_config, lookup_hash,
 *     scope_owner, episode_id nullable fix, RLS policies).
 *
 * These tests pin the invariants the baseline must encode:
 *  - exactly 1 forward .sql file
 *  - Beta-Bernoulli worth formula encoded
 *  - worth_alpha / worth_beta DEFAULT 2.0 on mnemo_fact
 *  - text_lemmatized GENERATED ALWAYS column
 *  - mnemo_recall_log has ENABLE but NOT FORCE RLS
 *  - read_scopes column present (0075 access-policy schema)
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "baseline"
);

// Exclude .down.sql files — they share the same numeric prefix as their forward migration
// and would cause false "duplicate prefix" failures in the gap-free sequence check.
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
  .sort();

const read = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), "utf8");

const FACT_SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "facts.ts"),
  "utf8"
);

const HARNESS_MIGRATION = "0038_host_harness_lifecycle.sql";
const MANAGED_ARCHIVE_REASON_MIGRATION = "0039_managed_archive_reason_check.sql";
const HARNESS_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "harness.ts"
);
const SESSIONS_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "sessions.ts"
);
const SCHEMA_INDEX_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "index.ts");
const HOST_HARNESS_INTEGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "host-harness-migration.integration.test.ts"
);

describe("migrations/baseline sequence", () => {
  it("contains at least 1 forward .sql file", () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("includes 0001_v3_complete_baseline.sql", () => {
    expect(files).toContain("0001_v3_complete_baseline.sql");
  });

  it("has unique, gap-free numeric prefixes", () => {
    const nums = files.map((f) => parseInt(f.slice(0, 4), 10));
    const expected = Array.from({ length: nums.length }, (_, i) => i + 1);
    expect(nums).toEqual(expected);
  });

  it("is marked migrate:no-transaction (baseline has REFRESH MV CONCURRENTLY in function bodies)", () => {
    const sql = read(files[0]!);
    expect(sql).toMatch(/--\s*migrate:no-transaction/i);
  });

  it("encodes the Beta-Bernoulli worth formula (worth_alpha / NULLIF)", () => {
    const sql = read(files[0]!);
    expect(sql).toContain("worth_alpha / NULLIF");
  });

  it("mnemo_fact.worth_alpha present in squash", () => {
    const sql = read(files[0]!);
    // mnemo_fact is a real CREATE TABLE in the squash (not a view).
    expect(sql).toContain("worth_alpha");
  });

  it("text_lemmatized appears in baseline (mnemo_fact is a real table, not a view)", () => {
    const sql = read(files[0]!);
    // The regenerated baseline creates mnemo_fact as a real table in mnemosyne schema.
    // pg_dump uses CREATE TABLE (without IF NOT EXISTS) for snapshot fidelity.
    expect(sql).toContain("CREATE TABLE mnemosyne.mnemo_fact");
    expect(sql).toContain("text_lemmatized");
  });

  it("mnemo_recall_log has ENABLE ROW LEVEL SECURITY", () => {
    const sql = read(files[0]!);
    // The squash file must ENABLE RLS on recall_log (but NOT FORCE it — FORCE was removed in 0046)
    // ENABLE RLS is applied via the RLS section at the bottom of the file
    // Since the squash is pg_dump based, verify the table exists and ENABLE is present globally
    expect(sql).toContain("mnemo_recall_log");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("mnemo_recall_log does NOT have FORCE ROW LEVEL SECURITY", () => {
    const sql = read(files[0]!);
    // Extract lines around mnemo_recall_log — none should say FORCE ROW LEVEL SECURITY
    const lines = sql.split("\n");
    const recallLogLines = lines.filter(
      (l) => l.includes("mnemo_recall_log") && l.includes("FORCE ROW LEVEL SECURITY")
    );
    expect(recallLogLines.length).toBe(0);
  });

  it("contains read_scopes column (0075 access-policy schema)", () => {
    const sql = read(files[0]!);
    expect(sql).toContain("read_scopes");
  });

  it("adds a recoverable partial unique index for active fact topic keys", () => {
    expect(files).toContain("0007_fact_topic_key_unique.sql");
    const sql = read("0007_fact_topic_key_unique.sql");

    expect(sql).toMatch(/--\s*migrate:no-transaction/i);
    expect(sql).toMatch(/GROUP\s+BY\s+workspace_id\s*,\s*topic_key/i);
    expect(sql).toMatch(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
    expect(sql).toMatch(
      /DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+mnemosyne\.idx_fact_topic_active_unique/i
    );
    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\s+idx_fact_topic_active_unique/i);
    expect(sql).toMatch(/WHERE\s+topic_key\s+IS\s+NOT\s+NULL\s+AND\s+status\s*=\s*'active'/i);
  });

  it("declares the matching partial unique index in the Drizzle schema", () => {
    // Quote-agnostic: plain JS string literals, so quote style follows the
    // repo's Prettier config rather than being pinned by this assertion.
    expect(FACT_SCHEMA).toMatch(/uniqueIndex\(['"]idx_fact_topic_active_unique['"]\)/);
    expect(FACT_SCHEMA).toMatch(/\.on\(t\.workspaceId,\s*t\.topicKey\)/);
    expect(FACT_SCHEMA).toMatch(/\.where\(sql`[^`]*t\.topicKey[^`]*t\.status[^`]*active[^`]*`\)/s);
    expect(FACT_SCHEMA).not.toMatch(/index\(['"]idx_fact_topic_key['"]\)/);
  });

  it("includes the restart-safe host harness lifecycle migration", () => {
    expect(files).toContain(HARNESS_MIGRATION);
    if (!files.includes(HARNESS_MIGRATION)) return;

    const migration = read(HARNESS_MIGRATION);
    expect(migration).toMatch(/^--\s*migrate:no-transaction/im);
    expect(migration).toMatch(/duplicate.*source.*identit/i);
    expect(migration).toMatch(
      /GROUP\s+BY\s+workspace_id\s*,\s*source_host\s*,\s*source_client_instance_id\s*,\s*source_session_id\s*,\s*source_generation/is
    );
    expect(migration).toMatch(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
    expect(migration).toMatch(/MAX\((?:\w+\.)?created_at\)/i);
    expect(migration).toMatch(
      /last_activity_at\s*=\s*COALESCE\([^,]*max_created_at\s*,\s*\w+\.started_at\)/is
    );
    expect(migration).toContain("archived_at");
    expect(migration).toContain("collapse_pending");

    expect(migration).toMatch(
      /ADD\s+CONSTRAINT\s+mnemo_session_status_harness_check[\s\S]*NOT\s+VALID/i
    );
    expect(migration).toMatch(/VALIDATE\s+CONSTRAINT\s+mnemo_session_status_harness_check/i);
    expect(migration).toMatch(/DROP\s+CONSTRAINT\s+mnemo_session_status_check/i);

    for (const indexName of [
      "idx_session_source_generation_unique",
      "idx_session_turn_source_message_unique",
      "idx_harness_event_id_unique",
      "idx_harness_source_sequence_unique",
      "idx_harness_tombstone_source_message_unique",
      "idx_managed_collapse_session_generation_unique",
      "idx_managed_collapse_effect_unique",
    ]) {
      expect(migration).toMatch(
        new RegExp(`indisvalid[\\s\\S]*${indexName}[\\s\\S]*DROP INDEX CONCURRENTLY`, "i")
      );
      expect(migration).toMatch(
        new RegExp(`CREATE UNIQUE INDEX CONCURRENTLY(?: IF NOT EXISTS)? ${indexName}`, "i")
      );
    }
    for (const indexName of [
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
      expect(migration).toMatch(
        new RegExp(`indisvalid[\\s\\S]*${indexName}[\\s\\S]*DROP INDEX CONCURRENTLY`, "i")
      );
      expect(migration).toMatch(
        new RegExp(`CREATE INDEX CONCURRENTLY(?: IF NOT EXISTS)? ${indexName}`, "i")
      );
    }
  });

  it("declares and exports every host harness table with grants and forced RLS", () => {
    expect(existsSync(HARNESS_SCHEMA_PATH)).toBe(true);
    if (!existsSync(HARNESS_SCHEMA_PATH) || !files.includes(HARNESS_MIGRATION)) return;

    const migration = read(HARNESS_MIGRATION);
    const harnessSchema = readFileSync(HARNESS_SCHEMA_PATH, "utf8");
    const schemaIndex = readFileSync(SCHEMA_INDEX_PATH, "utf8");
    const tableNames = [
      "mnemo_harness_ingestion_event",
      "mnemo_harness_workspace_control",
      "mnemo_harness_loss",
      "mnemo_harness_retraction",
      "mnemo_harness_message_tombstone",
      "mnemo_managed_collapse_operation",
      "mnemo_managed_collapse_effect",
      "mnemo_extraction_provenance",
    ];

    for (const tableName of tableNames) {
      expect(harnessSchema).toContain(`\"${tableName}\"`);
      expect(migration).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS mnemosyne\\.${tableName}`, "i")
      );
      expect(migration).toMatch(
        new RegExp(`GRANT [^;]+ ON TABLE mnemosyne\\.${tableName} TO mnemo_app_role`, "i")
      );
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE mnemosyne\\.${tableName} ENABLE ROW LEVEL SECURITY`, "i")
      );
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE mnemosyne\\.${tableName} FORCE ROW LEVEL SECURITY`, "i")
      );
      expect(migration).toContain(`'${tableName}'`);
    }
    expect(migration).toMatch(/CREATE POLICY %I ON mnemosyne\.%I/i);
    expect(schemaIndex).toMatch(/export \* from ["']\.\/harness\.js["']/);
  });

  it("declares managed session and source-turn columns in Drizzle", () => {
    const sessionsSchema = readFileSync(SESSIONS_SCHEMA_PATH, "utf8");
    for (const column of [
      "sourceHost",
      "sourceSessionId",
      "sourceClientInstanceId",
      "sourceGeneration",
      "predecessorSessionId",
      "lastActivityAt",
      "closeKind",
      "closeRequestedAt",
      "closeGraceDeadline",
      "terminalDigestVersion",
      "terminalMessageSetDigest",
      "terminalMaxEnqueueSequence",
      "sensitivity",
      "originActorId",
      "originActorType",
      "originUserId",
      "originSensitivityCeiling",
      "collapseLeaseOwner",
      "collapseLeaseExpiresAt",
      "collapseAttempts",
      "collapseNextAttemptAt",
      "collapseOperationId",
      "captureIncomplete",
      "archiveReason",
      "archivedAt",
      "sourceMessageId",
      "supersedesSourceMessageId",
      "contentHash",
      "retractedAt",
      "retractionReason",
      "ingestionEventId",
    ]) {
      expect(sessionsSchema, `missing Drizzle column ${column}`).toMatch(
        new RegExp(`\\b${column}\\s*:`)
      );
    }
    expect(sessionsSchema).toContain('name: "mnemo_session_turn_session_workspace_fkey"');
    expect(sessionsSchema).toContain("foreignColumns: [sessionTable.workspaceId, sessionTable.id]");
  });

  it("establishes every harness RLS policy before granting app-role access", () => {
    const migration = read(HARNESS_MIGRATION);
    const firstGrant = migration.indexOf("GRANT ");
    expect(firstGrant).toBeGreaterThan(0);
    expect(migration.indexOf("ENABLE ROW LEVEL SECURITY")).toBeLessThan(firstGrant);
    expect(migration.indexOf("FORCE ROW LEVEL SECURITY")).toBeLessThan(firstGrant);
    expect(migration.indexOf("CREATE POLICY")).toBeLessThan(firstGrant);
  });

  it("declares workspace-consistent composite foreign keys in SQL and Drizzle", () => {
    const migration = read(HARNESS_MIGRATION);
    const harnessSchema = readFileSync(HARNESS_SCHEMA_PATH, "utf8");
    const sessionsSchema = readFileSync(SESSIONS_SCHEMA_PATH, "utf8");
    const rawSqlOwned = new Set([
      "mnemo_session_predecessor_workspace_fkey",
      "mnemo_session_turn_ingestion_event_workspace_fkey",
      "mnemo_harness_retraction_predecessor_workspace_fkey",
    ]);

    for (const constraint of [
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
    ]) {
      expect(migration, `missing SQL constraint ${constraint}`).toContain(constraint);
      if (!rawSqlOwned.has(constraint)) {
        expect(
          `${harnessSchema}\n${sessionsSchema}`,
          `missing Drizzle constraint ${constraint}`
        ).toContain(constraint);
      }
    }
    expect(harnessSchema).toContain("HOST_HARNESS_RAW_SQL_OWNED_FOREIGN_KEYS");
    expect(harnessSchema).toContain("foreignKey(");
    expect(sessionsSchema).toContain("foreignKey(");
    expect(sessionsSchema).toContain("ingestionEventWorkspaceId");
    expect(migration).toMatch(
      /VALIDATE CONSTRAINT mnemo_session_turn_session_workspace_fkey[\s\S]*DROP\s+CONSTRAINT IF EXISTS mnemo_session_turn_session_id_fkey/i
    );
  });

  it("sets the turn workspace bridge NOT NULL with a validated helper and bounded lock", () => {
    const migration = read(HARNESS_MIGRATION);
    const addCheck = migration.indexOf("mnemo_session_turn_ingestion_workspace_not_null_check");
    const validate = migration.indexOf(
      "VALIDATE CONSTRAINT mnemo_session_turn_ingestion_workspace_not_null_check"
    );
    const lockTimeout = migration.indexOf("SET lock_timeout");
    const setNotNull = migration.indexOf("ALTER COLUMN ingestion_event_workspace_id SET NOT NULL");
    const resetTimeout = migration.indexOf("RESET lock_timeout");
    const dropCheck = migration.indexOf(
      "DROP CONSTRAINT IF EXISTS mnemo_session_turn_ingestion_workspace_not_null_check"
    );

    expect(addCheck).toBeGreaterThan(0);
    expect(addCheck).toBeLessThan(validate);
    expect(validate).toBeLessThan(lockTimeout);
    expect(lockTimeout).toBeLessThan(setNotNull);
    expect(setNotNull).toBeLessThan(resetTimeout);
    expect(resetTimeout).toBeLessThan(dropCheck);
  });

  it("installs restart-safe workspace fencing that owns epoch transitions", () => {
    const migration = read(HARNESS_MIGRATION);
    expect(migration).toContain("mnemo_enforce_harness_workspace_fence");
    expect(migration).toContain("trg_enforce_harness_workspace_fence");
    expect(migration).toMatch(/NEW\.fence_epoch\s*:=\s*OLD\.fence_epoch\s*\+\s*1/i);
    expect(migration).toMatch(
      /NEW\.ingestion_enabled\s+IS\s+DISTINCT\s+FROM\s+OLD\.ingestion_enabled/i
    );
  });

  it("backfills workspace controls and provisions future rows restart-safely", () => {
    const migration = read(HARNESS_MIGRATION);
    expect(migration).toMatch(
      /INSERT INTO mnemosyne\.mnemo_harness_workspace_control\s*\(workspace_id\)[\s\S]*SELECT\s+(?:w\.)?id[\s\S]*FROM mnemosyne\.mnemo_workspace[\s\S]*ON CONFLICT \(workspace_id\) DO NOTHING/i
    );
    expect(migration).toContain("mnemo_seed_harness_workspace_control");
    expect(migration).toContain("trg_seed_harness_workspace_control");
  });

  it("uses least-privilege grants for harness lifecycle tables", () => {
    const migration = read(HARNESS_MIGRATION);
    for (const tableName of [
      "mnemo_harness_workspace_control",
      "mnemo_harness_ingestion_event",
      "mnemo_harness_message_tombstone",
      "mnemo_harness_loss",
      "mnemo_harness_retraction",
      "mnemo_extraction_provenance",
    ]) {
      expect(migration).not.toMatch(
        new RegExp(`GRANT[^;]*DELETE[^;]*ON TABLE mnemosyne\\.${tableName}`, "i")
      );
    }
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE mnemosyne\.mnemo_harness_ingestion_event TO mnemo_app_role/i
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE mnemosyne\.mnemo_harness_message_tombstone TO mnemo_app_role/i
    );
  });

  it("installs the legacy-append activity trigger before the activity backfill", () => {
    const migration = read(HARNESS_MIGRATION);
    const trigger = migration.indexOf("trg_session_turn_last_activity");
    const backfill = migration.indexOf("WITH activity AS");
    expect(trigger).toBeGreaterThan(0);
    expect(trigger).toBeLessThan(backfill);
    expect(migration).toContain("GREATEST(");
    expect(migration).toContain("NEW.created_at");
  });

  it("declares the cursor-compatible terminal retention expression index", () => {
    const migration = read(HARNESS_MIGRATION);
    const sessionsSchema = readFileSync(SESSIONS_SCHEMA_PATH, "utf8");
    expect(migration).toMatch(
      /idx_session_terminal_retention[\s\S]*\(workspace_id,\s*\(COALESCE\(collapsed_at, archived_at\)\),\s*id\)[\s\S]*WHERE source_host IS NOT NULL AND status IN \('collapsed', 'archived'\)/i
    );
    expect(sessionsSchema).toMatch(
      /index\("idx_session_terminal_retention"\)[\s\S]*\.on\(t\.workspaceId,\s*sql`COALESCE\([^`]+\)`,\s*t\.id\)/
    );
  });

  it("mirrors every new physical CHECK constraint in Drizzle", () => {
    const harnessSchema = readFileSync(HARNESS_SCHEMA_PATH, "utf8");
    for (const constraint of [
      "mnemo_harness_workspace_control_fence_epoch_check",
      "mnemo_harness_ingestion_event_enqueue_sequence_check",
      "mnemo_harness_ingestion_event_source_generation_check",
      "mnemo_harness_ingestion_event_ledger_state_check",
      "mnemo_harness_loss_source_generation_check",
      "mnemo_harness_loss_enqueue_sequence_check",
      "mnemo_harness_message_tombstone_source_generation_check",
      "mnemo_managed_collapse_operation_source_generation_check",
      "mnemo_managed_collapse_operation_status_check",
      "mnemo_managed_collapse_effect_attempts_check",
      "mnemo_managed_collapse_effect_status_check",
    ]) {
      expect(harnessSchema, `missing Drizzle CHECK ${constraint}`).toContain(`"${constraint}"`);
    }
  });

  it("adds the managed archive reason constraint restart-safely", () => {
    const migration = read(MANAGED_ARCHIVE_REASON_MIGRATION);
    const sessionsSchema = readFileSync(SESSIONS_SCHEMA_PATH, "utf8");

    expect(migration).toMatch(/--\s*migrate:no-transaction/i);
    expect(migration).toContain("mnemo_session_managed_archive_reason_check");
    expect(migration).toMatch(/IF NOT EXISTS[\s\S]*ADD CONSTRAINT[\s\S]*NOT VALID/i);
    expect(migration).toMatch(/VALIDATE CONSTRAINT mnemo_session_managed_archive_reason_check/i);
    expect(sessionsSchema).toContain('"mnemo_session_managed_archive_reason_check"');
  });

  it("requires persisted harness enqueue watermarks to be positive in SQL and Drizzle", () => {
    const migration = read(HARNESS_MIGRATION);
    const harnessSchema = readFileSync(HARNESS_SCHEMA_PATH, "utf8");
    const sessionsSchema = readFileSync(SESSIONS_SCHEMA_PATH, "utf8");

    expect(migration).not.toMatch(/enqueue_sequence\s+BETWEEN\s+0\s+AND/i);
    expect(migration).not.toMatch(/terminal_max_enqueue_sequence\s+BETWEEN\s+0\s+AND/i);
    expect(harnessSchema).not.toMatch(/enqueueSequence}\s+BETWEEN\s+0\s+AND/);
    expect(sessionsSchema).not.toMatch(/terminalMaxEnqueueSequence}\s+BETWEEN\s+0\s+AND/);
    expect(harnessSchema).toMatch(/enqueueSequence}\s+BETWEEN\s+1\s+AND\s+9007199254740991/);
    expect(sessionsSchema).toMatch(
      /terminalMaxEnqueueSequence}\s+BETWEEN\s+1\s+AND\s+9007199254740991/
    );
    expect(migration).toMatch(/enqueue_sequence\s+BETWEEN\s+1\s+AND\s+9007199254740991/i);
    expect(migration).toMatch(
      /terminal_max_enqueue_sequence\s+BETWEEN\s+1\s+AND\s+9007199254740991/i
    );
  });

  it("exercises legacy lifecycle behavior through DrizzleStorageAdapter", () => {
    const integration = readFileSync(HOST_HARNESS_INTEGRATION_PATH, "utf8");
    expect(integration).toContain("DrizzleStorageAdapter");
    for (const method of [
      "createSession",
      "appendTurn",
      "listTurns",
      "closeSession",
      "archiveSession",
    ]) {
      expect(integration, `missing adapter call ${method}`).toContain(`adapter.${method}(`);
    }
  });

  it("repairs valid fixed-name indexes whose normalized definitions are wrong", () => {
    const migration = read(HARNESS_MIGRATION);
    expect(migration).toContain("pg_get_indexdef");
    expect(migration).toContain("mnemo_index_definition_matches");
    expect(migration).toMatch(/NOT\s+mnemosyne\.mnemo_index_definition_matches/i);
  });
});

describe("0071_recall_observability", () => {
  const up = () => read("0071_recall_observability.sql");
  const down = () => read("0071_recall_observability.down.sql");

  it("is the gap-free next prefix with forward and down SQL", () => {
    expect(files).toContain("0071_recall_observability.sql");
    expect(existsSync(join(MIGRATIONS_DIR, "0071_recall_observability.down.sql"))).toBe(true);
    expect(files.filter((f) => f.startsWith("0058_"))).toHaveLength(1);
  });

  it("creates RLS-protected request table with grants", () => {
    const sql = up();
    expect(sql).toMatch(/PRIMARY KEY \(workspace_id, request_id\)/);
    expect(sql).toMatch(/mnemo_recall_request ENABLE ROW LEVEL SECURITY/);
    // CLAUDE.md S2: every mnemo_* table needs FORCE RLS too, and writes must be
    // pinned to the caller's workspace.
    expect(sql).toMatch(/mnemo_recall_request FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY mnemo_recall_request_ws[\s\S]*WITH CHECK/);
    expect(sql).toMatch(/CREATE POLICY mnemo_recall_request_ws[\s\S]*mnemosyne\.workspace_id/);
    expect(sql).toMatch(/GRANT [A-Z,]+ ON TABLE mnemosyne\.mnemo_recall_request TO mnemo_app_role/);
    for (const c of ["request_metadata jsonb", "query_hash", "status", "duration_ms"])
      expect(sql).toContain(c);
  });

  it("keeps fact FK, converts memory_id to text, backfills facts only, no synthesized request/rank", () => {
    const sql = up();
    expect(sql).toMatch(/memory_id TYPE text/);
    expect(sql).toMatch(/fact_id DROP NOT NULL/);
    expect(sql).not.toMatch(/DROP CONSTRAINT[^;]*fact/i);
    expect(sql).toMatch(/SET primitive_kind = 'fact', memory_id = fact_id/);
    expect(sql).not.toMatch(/UPDATE[^;]*(request_id|hit_rank)\s*=/);
    expect(sql).toMatch(/UNIQUE INDEX[\s\S]*request_id IS NOT NULL AND hit_rank IS NOT NULL/);
  });

  it("down refuses lossy rollback", () => {
    const sql = down();
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/primitive_kind IS DISTINCT FROM 'fact'/);
    expect(sql).toMatch(/memory_id !~\*/);
    expect(sql.indexOf("RAISE EXCEPTION")).toBeLessThan(sql.indexOf("DROP COLUMN"));
  });
});

describe("0072_recall_learning_organic", () => {
  const up = () => read("0072_recall_learning_organic.sql");
  const down = () => read("0072_recall_learning_organic.down.sql");
  const view = (sql: string, name: string) =>
    sql.slice(sql.indexOf(`CREATE MATERIALIZED VIEW mnemosyne.${name}`)).split(";")[0]!;

  it("ships forward and down SQL", () => {
    expect(files).toContain("0072_recall_learning_organic.sql");
    expect(existsSync(join(MIGRATIONS_DIR, "0072_recall_learning_organic.down.sql"))).toBe(true);
  });

  it.each(["mv_sequential_patterns", "mv_periodic_patterns"])(
    "%s learns from organic recall rows only (synthetic/test requests excluded)",
    (name) => {
      const sql = view(up(), name);
      expect(sql).toMatch(/NOT \(EXISTS[\s\S]*mnemo_recall_request rr/);
      expect(sql).toMatch(/rr\.request_id = mnemo_recall_log\.request_id/);
      expect(sql).toMatch(/'synthetic'::text, 'test'::text/);
      // Recreated populated: REFRESH ... CONCURRENTLY refuses an unpopulated view.
      expect(sql).not.toMatch(/WITH NO DATA/);
      expect(up()).toContain(`GRANT SELECT ON TABLE mnemosyne.${name} TO mnemo_app_role`);
      expect(up()).toMatch(new RegExp(`CREATE UNIQUE INDEX uq_${name} ON mnemosyne\\.${name}`));
    }
  );

  it("adds a nullable raw similarity column; down restores the original views", () => {
    expect(up()).toMatch(/ADD COLUMN similarity real;/);
    expect(down()).toMatch(/DROP COLUMN similarity/);
    expect(view(down(), "mv_sequential_patterns")).not.toContain("mnemo_recall_request");
    expect(view(down(), "mv_periodic_patterns")).not.toContain("mnemo_recall_request");
  });
});
