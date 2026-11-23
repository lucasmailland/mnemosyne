/**
 * Migration safety linter — spec §35 "Zero-Downtime Schema Migrations"
 * (MEMORY_IMPROVEMENT.md lines 4027–4033).
 *
 * Seven named checks enforced statically against SQL text:
 *   1. no_table_locks_over_5s         — rejects ADD COLUMN NOT NULL without DEFAULT,
 *                                        ADD CONSTRAINT without NOT VALID
 *   2. no_column_drops_without_flag   — rejects DROP COLUMN without allow-drop marker
 *   3. no_type_changes_in_place       — rejects ALTER COLUMN ... TYPE
 *   4. index_creation_concurrent      — rejects CREATE INDEX without CONCURRENTLY
 *   5. max_10_tables_per_deploy       — rejects sets touching >10 distinct tables
 *   6. grant_completeness             — SAFE-1: rejects CREATE TABLE with no matching
 *                                        GRANT ... TO mnemo_app_role in the same file
 *   7. rls_policy_completeness        — SAFE-1: rejects ENABLE ROW LEVEL SECURITY with
 *                                        no write-covering policy (FOR ALL, or FOR
 *                                        INSERT+UPDATE+DELETE) in the same file
 *
 * Plus one derived safety rule:
 *   8. concurrently_requires_no_transaction
 *
 * Markers (first non-empty comment line):
 *   -- migrate:no-transaction          — run outside a transaction
 *   -- migrate:allow-drop reason=<text> — explicit ack for DROP COLUMN
 *   -- migrate:allow-non-concurrent-index reason=<text> — explicit ack for a plain
 *       (non-CONCURRENT) CREATE INDEX. Use ONLY when the index is on a table/column
 *       created in this same migration (brand-new + empty/all-NULL → instant build,
 *       negligible lock) and the migration must stay transactional (the migrate CLI
 *       wraps each migration in a transaction, where CONCURRENTLY cannot run).
 *   -- migrate:allow-table-locks reason=<text> — explicit ack for ADD CONSTRAINT /
 *       ADD COLUMN NOT NULL without the safe online pattern. Use ONLY for baseline
 *       files where all tables are freshly created in the same file (fresh-install
 *       scenario: tables are empty so all locks are instantaneous).
 *   -- migrate:allow-no-grant reason=<text> — explicit ack that a created table is
 *       deliberately inaccessible to mnemo_app_role (e.g. superuser-only bookkeeping).
 *   -- migrate:allow-rls-no-policy reason=<text> — explicit ack that RLS is enabled
 *       with no write policy in this file, e.g. a genuinely SELECT-only or INSERT-only
 *       (via REVOKE, not RLS) table, or a policy that legitimately lives in an earlier
 *       migration this linter (per-file, no cross-file state) cannot see.
 *
 * This module is pure (no DB / drizzle imports).
 */

export interface SafetyViolation {
  check: string;
  message: string;
  line?: number;
  file?: string;
}

function hasNoTransactionMarker(sql: string): boolean {
  return /--\s*migrate:no-transaction/i.test(sql);
}

function hasAllowDropMarker(sql: string): boolean {
  return /--\s*migrate:allow-drop\s+reason=\S/i.test(sql);
}

function hasAllowNonConcurrentIndexMarker(sql: string): boolean {
  return /--\s*migrate:allow-non-concurrent-index\s+reason=\S/i.test(sql);
}

function hasAllowTableLocksMarker(sql: string): boolean {
  return /--\s*migrate:allow-table-locks\s+reason=\S/i.test(sql);
}

function hasAllowNoGrantMarker(sql: string): boolean {
  return /--\s*migrate:allow-no-grant\s+reason=\S/i.test(sql);
}

function hasAllowRlsNoPolicyMarker(sql: string): boolean {
  return /--\s*migrate:allow-rls-no-policy\s+reason=\S/i.test(sql);
}

function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function getLines(sql: string): string[] {
  return sql.split("\n");
}

/** Table/view names created within this migration's SQL, lowercased + schema/quote-stripped. */
function extractCreatedTables(strippedSql: string): Set<string> {
  const tables = new Set<string>();
  const re =
    /\bCREATE\s+(?:TABLE|MATERIALIZED\s+VIEW)\b(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:mnemosyne\.)?("?[\w]+"?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(strippedSql)) !== null) {
    if (m[1]) tables.add(m[1].toLowerCase().replace(/"/g, ""));
  }
  return tables;
}

function checkIndexCreation(sql: string, file?: string): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  // Explicit, reviewable opt-out (mirrors allow-drop): a plain CREATE INDEX is
  // permitted when the migration declares the index targets a brand-new/empty
  // object created in the same file, so the ShareLock is instantaneous.
  if (hasAllowNonConcurrentIndexMarker(sql)) return violations;
  const stripped = stripLineComments(sql);
  // Indexes on a table CREATEd in this same migration are safe without
  // CONCURRENTLY: the table is brand-new + empty within the transaction, so the
  // ShareLock is instantaneous and blocks no concurrent writers. This is the
  // standard "new table + its indexes in one migration" pattern; only a plain
  // CREATE INDEX on a PRE-EXISTING (possibly large/written) table is dangerous.
  const createdHere = extractCreatedTables(stripped);
  // Match full CREATE INDEX statements (may span multiple lines) to capture the
  // `ON <table>` target and whether CONCURRENTLY is present.
  const idxRe =
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b([\s\S]*?)\bON\b(?:\s+ONLY)?\s+(?:mnemosyne\.)?("?[\w]+"?)/gi;
  let m: RegExpExecArray | null;
  while ((m = idxRe.exec(stripped)) !== null) {
    const between = m[1] ?? "";
    // CONCURRENTLY indexes are validated by checkConcurrentlyMarker, not here.
    if (/\bCONCURRENTLY\b/i.test(between)) continue;
    const target = (m[2] ?? "").toLowerCase().replace(/"/g, "");
    if (createdHere.has(target)) continue; // new table in this migration → safe
    const line = stripped.slice(0, m.index).split("\n").length;
    violations.push({
      check: "index_creation_concurrent",
      message:
        "CREATE INDEX without CONCURRENTLY takes a ShareLock on a pre-existing table. Use CONCURRENTLY + migrate:no-transaction (or create the index in the same migration as its new table). (spec §35 line 4031)",
      line,
      file,
    });
  }
  return violations;
}

function checkConcurrentlyMarker(sql: string, file?: string): SafetyViolation[] {
  const stripped = stripLineComments(sql);
  if (/\bCONCURRENTLY\b/i.test(stripped) && !hasNoTransactionMarker(sql)) {
    return [
      {
        check: "concurrently_requires_no_transaction",
        message:
          "CONCURRENTLY cannot run inside a transaction. Add '-- migrate:no-transaction'. (spec §35 line 4031)",
        file,
      },
    ];
  }
  return [];
}

function checkColumnDrops(sql: string, file?: string): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  const stripped = stripLineComments(sql);
  const lines = getLines(stripped);
  const hasMarker = hasAllowDropMarker(sql);
  lines.forEach((line, i) => {
    if (/\bDROP\s+COLUMN\b/i.test(line) && !hasMarker) {
      violations.push({
        check: "no_column_drops_without_flag",
        message:
          "DROP COLUMN without '-- migrate:allow-drop reason=<text>' marker. (spec §35 line 4029)",
        line: i + 1,
        file,
      });
    }
  });
  return violations;
}

function hasAllowTypeChangeMarker(sql: string): boolean {
  return /--\s*migrate:allow-type-change\s+reason=\S/i.test(sql);
}

function checkTypeChanges(sql: string, file?: string): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  if (hasAllowTypeChangeMarker(sql)) return violations;
  const stripped = stripLineComments(sql);
  const lines = getLines(stripped);
  lines.forEach((line, i) => {
    if (/\bALTER\s+COLUMN\b.*\bTYPE\b/i.test(line)) {
      violations.push({
        check: "no_type_changes_in_place",
        message:
          "ALTER COLUMN ... TYPE rewrites the table. Use the 5-phase additive pattern. (spec §35 line 4030)",
        line: i + 1,
        file,
      });
    }
  });
  return violations;
}

function checkTableLocks(sql: string, file?: string): SafetyViolation[] {
  if (hasAllowTableLocksMarker(sql)) return [];
  const violations: SafetyViolation[] = [];
  const stripped = stripLineComments(sql);
  const createdHere = extractCreatedTables(stripped);
  const lines = getLines(stripped);
  let currentAlterTable = "";
  lines.forEach((line, i) => {
    // Track the table targeted by the enclosing ALTER TABLE block.
    const alterMatch = /\bALTER\s+TABLE\b(?:\s+ONLY)?\s+(?:mnemosyne\.)?("?[\w]+"?)/i.exec(line);
    if (alterMatch) {
      currentAlterTable = (alterMatch[1] ?? "").toLowerCase().replace(/"/g, "");
    }
    if (/\bADD\s+COLUMN\b(?:\s+IF\s+NOT\s+EXISTS)?\s+\S+\s+\S+\s+NOT\s+NULL\b/i.test(line)) {
      if (!/\bDEFAULT\b/i.test(line)) {
        violations.push({
          check: "no_table_locks_over_5s",
          message:
            "ADD COLUMN NOT NULL without DEFAULT holds AccessExclusiveLock. Add DEFAULT or make nullable. (spec §35 line 4028)",
          line: i + 1,
          file,
        });
      }
    }
    // Only FOREIGN KEY and CHECK constraints support NOT VALID; PRIMARY KEY and
    // UNIQUE do not. Also exempt FK/CHECK on tables created in this same migration
    // (brand-new empty tables → validation is instantaneous, no row lock risk).
    if (
      /\bADD\s+CONSTRAINT\b/i.test(line) &&
      !/\bNOT\s+VALID\b/i.test(line) &&
      (/\bFOREIGN\s+KEY\b/i.test(line) || /\bCHECK\b/i.test(line)) &&
      !createdHere.has(currentAlterTable)
    ) {
      violations.push({
        check: "no_table_locks_over_5s",
        message:
          "ADD CONSTRAINT (FK/CHECK) without NOT VALID validates all rows immediately. Add NOT VALID then VALIDATE CONSTRAINT later. (spec §35 line 4028)",
        line: i + 1,
        file,
      });
    }
  });
  return violations;
}

/** CREATE TABLE names only (not materialized views — those have different grant semantics). */
function extractCreatedTablesOnly(strippedSql: string): Set<string> {
  const tables = new Set<string>();
  const re = /\bCREATE\s+TABLE\b(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:\w+\.)?("?[\w]+"?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(strippedSql)) !== null) {
    const name = m[1]?.toLowerCase().replace(/"/g, "");
    // Guards a real false-positive: "CREATE TABLE mnemosyne.%I PARTITION OF ..."
    // inside a format()'d dynamic-SQL string literal in a PL/pgSQL function body
    // (see mnemo_audit_log's monthly-partition-creation function). "%I" isn't a
    // \w character, so the optional schema-prefix group backtracks off and the
    // capture group grabs the bare schema name instead — this is text data, not
    // an executed DDL statement. A bare schema name is never a real table name.
    if (!name || name === "mnemosyne" || name === "public") continue;
    tables.add(name);
  }
  return tables;
}

// SAFE-1: three recurring bugs (0008's index-target grant gap, mnemo_audit_log's
// INSERT-only RLS gap, mnemo_semantic_neighbor's missing GRANT — all shipped and
// were fixed by hand after the fact) share one root cause: a table created or
// RLS-enabled without a matching GRANT / policy in the same migration. Neither
// pattern had a linter rule before this.
function checkGrantCompleteness(sql: string, file?: string): SafetyViolation[] {
  if (hasAllowNoGrantMarker(sql)) return [];
  const stripped = stripLineComments(sql);
  const createdTables = extractCreatedTablesOnly(stripped);
  if (createdTables.size === 0) return [];

  // Partition children (ATTACH PARTITION, or inline `PARTITION OF <parent>`
  // on the CREATE TABLE itself) automatically inherit the parent table's
  // GRANTs in Postgres — they don't need (and generally don't have) their
  // own GRANT statement. Skip any created table this file also declares as
  // a partition either way.
  const attachPartitionRe = /\bATTACH\s+PARTITION\s+(?:\w+\.)?("?[\w]+"?)\b/gi;
  const inlinePartitionRe =
    /\bCREATE\s+TABLE\b(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:\w+\.)?("?[\w]+"?)\s+PARTITION\s+OF\b/gi;
  const partitionChildren = new Set<string>();
  {
    let pm: RegExpExecArray | null;
    while ((pm = attachPartitionRe.exec(stripped)) !== null) {
      if (pm[1]) partitionChildren.add(pm[1].toLowerCase().replace(/"/g, ""));
    }
    while ((pm = inlinePartitionRe.exec(stripped)) !== null) {
      if (pm[1]) partitionChildren.add(pm[1].toLowerCase().replace(/"/g, ""));
    }
  }
  for (const child of partitionChildren) createdTables.delete(child);
  if (createdTables.size === 0) return [];

  // Line-based, not a `[\s\S]*?`-spanning multi-line regex: every real GRANT
  // statement in this codebase's migrations (including inside a DO $$ ... $$
  // conditional block, e.g. mnemo_semantic_neighbor's cross-schema conditional
  // grant — a static linter can't evaluate the IF EXISTS branch, so presence
  // anywhere is treated as intent-to-grant) is a single line. A spanning regex
  // risks a GRANT ... ON SEQUENCE/FUNCTION line "stealing" a later table's
  // GRANT ON TABLE line, silently dropping real grants. mnemo_app_role is the
  // only app-facing role.
  const grantLineRe =
    /\bGRANT\b.*\bON\s+(?:TABLE\s+)?(?:\w+\.)?("?[\w]+"?)\b.*\bTO\s+.*\bmnemo_app_role\b/i;
  const grantedTables = new Set<string>();
  for (const line of stripped.split("\n")) {
    const lm = grantLineRe.exec(line);
    if (lm?.[1]) grantedTables.add(lm[1].toLowerCase().replace(/"/g, ""));
  }

  const violations: SafetyViolation[] = [];
  for (const table of createdTables) {
    if (!grantedTables.has(table)) {
      violations.push({
        check: "grant_completeness",
        message: `CREATE TABLE ${table} has no matching GRANT ... TO mnemo_app_role in this migration — the app role will get 'permission denied' on first access. Add the GRANT, or '-- migrate:allow-no-grant reason=<text>' if this table is deliberately inaccessible to the app role.`,
        file,
      });
    }
  }
  return violations;
}

const WRITE_COMMANDS = ["INSERT", "UPDATE", "DELETE"] as const;

function checkRlsPolicyCompleteness(sql: string, file?: string): SafetyViolation[] {
  if (hasAllowRlsNoPolicyMarker(sql)) return [];
  const stripped = stripLineComments(sql);

  const enableRlsRe =
    /\bALTER\s+TABLE\b(?:\s+ONLY)?\s+(?:\w+\.)?("?[\w]+"?)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
  const rlsTables = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = enableRlsRe.exec(stripped)) !== null) {
    if (m[1]) rlsTables.add(m[1].toLowerCase().replace(/"/g, ""));
  }
  if (rlsTables.size === 0) return [];

  // Map table -> set of commands covered by policies targeting it in this file.
  // Postgres CREATE POLICY's FOR clause is OPTIONAL — omitting it defaults to
  // ALL commands (not "no commands"), so the FOR group here is optional too and
  // an absent match is treated as ALL.
  const policyRe =
    /\bCREATE\s+POLICY\s+\S+\s+ON\s+(?:\w+\.)?("?[\w]+"?)(?:\s+FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?\b/gi;
  const coverage = new Map<string, Set<string>>();
  while ((m = policyRe.exec(stripped)) !== null) {
    const table = (m[1] ?? "").toLowerCase().replace(/"/g, "");
    const cmd = (m[2] ?? "ALL").toUpperCase();
    if (!coverage.has(table)) coverage.set(table, new Set());
    coverage.get(table)!.add(cmd);
  }

  const violations: SafetyViolation[] = [];
  for (const table of rlsTables) {
    const cmds = coverage.get(table);
    const writesCovered = !!cmds && (cmds.has("ALL") || WRITE_COMMANDS.every((c) => cmds.has(c)));
    if (!writesCovered) {
      violations.push({
        check: "rls_policy_completeness",
        message: `${table} has ENABLE ROW LEVEL SECURITY but no policy in this migration covering writes (FOR ALL, or FOR INSERT + UPDATE + DELETE) — Postgres default-denies, so every write from the app role silently 403s. Add the policy (or a SELECT-only one is deliberate: document with '-- migrate:allow-rls-no-policy reason=<text>').`,
        file,
      });
    }
  }
  return violations;
}

/**
 * APP-048: a unique index/constraint on a table that already has rows fails
 * the migration — at deploy time, on real data — when duplicates exist.
 * Require a duplicate check in the same file (GROUP BY … HAVING count(*) > 1)
 * or a reviewed `-- migrate:unique-checked reason=…` marker.
 */
function checkUniqueDuplicateCheck(sql: string, file?: string): SafetyViolation[] {
  if (/--\s*migrate:unique-checked\s+reason=\S/i.test(sql)) return [];
  const stripped = stripLineComments(sql);
  if (/\bHAVING\s+count\s*\(\s*\*\s*\)\s*>\s*1/i.test(stripped)) return [];
  const createdHere = extractCreatedTables(stripped);
  const violations: SafetyViolation[] = [];
  const patterns = [
    /\bCREATE\s+UNIQUE\s+INDEX\b[\s\S]*?\bON\b(?:\s+ONLY)?\s+(?:mnemosyne\.)?("?[\w]+"?)/gi,
    /\bALTER\s+TABLE\b(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?\s+(?:mnemosyne\.)?("?[\w]+"?)[^;]*?\bADD\s+CONSTRAINT\s+\S+\s+UNIQUE\b/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const target = (m[1] ?? "").toLowerCase().replace(/"/g, "");
      if (createdHere.has(target)) continue;
      violations.push({
        check: "unique_index_duplicate_check",
        message:
          "A unique index/constraint on a pre-existing table fails the migration if duplicates exist. Check for them first in this file (GROUP BY … HAVING count(*) > 1) or add '-- migrate:unique-checked reason=…'.",
        line: stripped.slice(0, m.index).split("\n").length,
        file,
      });
    }
  }
  return violations;
}

export function lintMigration(sql: string, opts?: { filename?: string }): SafetyViolation[] {
  const file = opts?.filename;
  return [
    ...checkIndexCreation(sql, file),
    ...checkConcurrentlyMarker(sql, file),
    ...checkColumnDrops(sql, file),
    ...checkTypeChanges(sql, file),
    ...checkTableLocks(sql, file),
    ...checkGrantCompleteness(sql, file),
    ...checkRlsPolicyCompleteness(sql, file),
    ...checkUniqueDuplicateCheck(sql, file),
  ];
}

export function lintMigrationSet(files: { filename: string; sql: string }[]): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  const tableNames = new Set<string>();

  for (const { filename, sql } of files) {
    violations.push(...lintMigration(sql, { filename }));
    const stripped = stripLineComments(sql);
    const re =
      /(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+(?:mnemosyne\.)?(["\w][\w.]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const captured = m[1];
      if (captured) tableNames.add(captured.toLowerCase().replace(/"/g, ""));
    }
  }

  if (tableNames.size > 10) {
    violations.push({
      check: "max_10_tables_per_deploy",
      message: `Deploy touches ${tableNames.size} distinct tables (${[...tableNames].join(", ")}). Blast-radius limit is 10. Split into smaller batches. (spec §35 line 4033)`,
    });
  }

  return violations;
}
