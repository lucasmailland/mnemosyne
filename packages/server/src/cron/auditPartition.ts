/**
 * auditPartitionHandler — 7-year audit-log partition lifecycle cron.
 *
 * Gated behaviour:
 *   • Keeping the partition runway (this month and the two after it): always
 *     runs, and also once when the server starts (idempotent PG function).
 *   • Pruning old partitions: only when MNEMO_AUDIT_DROP_ENABLED=true.
 *
 * The actual SQL lives in migrations 0062 and 0076 (SECURITY DEFINER, so the
 * production login can create the partition):
 *   - mnemosyne.mnemo_audit_create_next_partition()
 *   - mnemosyne.prune_audit_partitions(p_retain_months INT DEFAULT 84)
 *
 * SQL access follows the same duck-typing pattern as kekRotate.ts:
 * the storage adapter may optionally expose runSql() for raw queries; when
 * absent (e.g. in-memory / test adapters) the handler no-ops cleanly.
 */

export interface AuditPartitionStorage {
  /**
   * Optional: execute a raw SQL string and return rows.
   * Implemented by DrizzleStorageAdapter; absent on in-memory adapters.
   */
  runSql?: (query: string) => Promise<Array<Record<string, unknown>>>;
}

export interface AuditPartitionDeps {
  storage: AuditPartitionStorage;
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    error?(o: object, m?: string): void;
  };
}

/**
 * Create next month's audit partition, then optionally prune old ones.
 * No-ops gracefully when the storage adapter lacks runSql().
 */
export async function auditPartitionHandler(deps: AuditPartitionDeps): Promise<void> {
  if (typeof deps.storage.runSql !== "function") {
    deps.logger.warn(
      { adapter: (deps.storage as { constructor?: { name?: string } }).constructor?.name ?? "unknown" },
      "mnemo.audit.partition: runSql not available on storage adapter — skipping",
    );
    return;
  }

  // Always: create the next calendar month's partition (idempotent).
  try {
    await deps.storage.runSql("SELECT mnemosyne.mnemo_audit_create_next_partition()");
    deps.logger.info({}, "mnemo.audit.partition: partition runway ensured (idempotent)");
  } catch (err) {
    // An error, not a warning: with no partition for a month every audit INSERT
    // of that month fails, and the writes that append an audit entry fail with it.
    const report = (deps.logger.error ?? deps.logger.warn).bind(deps.logger);
    report(
      { error: String(err) },
      "mnemo.audit.partition: could not ensure the audit-log partitions; audit writes will fail once the existing partitions run out",
    );
    // Continue to attempt pruning regardless.
  }

  // Conditional: prune partitions older than 84 months (7 years).
  if (process.env["MNEMO_AUDIT_DROP_ENABLED"] !== "true") {
    deps.logger.info(
      { flag: "MNEMO_AUDIT_DROP_ENABLED" },
      "mnemo.audit.partition: pruning skipped (MNEMO_AUDIT_DROP_ENABLED not set)",
    );
    return;
  }

  try {
    const rows = await deps.storage.runSql(
      "SELECT mnemosyne.prune_audit_partitions(84) AS dropped",
    );
    const dropped = (rows[0] as { dropped?: number } | undefined)?.dropped ?? 0;
    deps.logger.info({ dropped }, "mnemo.audit.partition: pruned old partitions");
  } catch (err) {
    // Pruning failures are non-fatal — data is not lost, just not trimmed.
    deps.logger.warn(
      { error: String(err) },
      "mnemo.audit.partition: pruning failed (non-fatal)",
    );
  }
}

/**
 * Run the partition job once at startup instead of waiting for its weekly slot:
 * a server that was down across a month boundary, or one installed after the
 * last month the migrations created, needs this month's partition before its
 * first write. Never throws: a failure is reported and the boot continues.
 */
export async function runAuditPartitionAtBoot(
  jobs: ReadonlyArray<{ key: string; handler: () => Promise<void> }>,
  disabled: ReadonlySet<string>,
  logger: { warn(o: object, m?: string): void; error?(o: object, m?: string): void },
): Promise<void> {
  const job = jobs.find((j) => j.key === "mnemo.audit.partition");
  if (!job || disabled.has(job.key)) return;
  try {
    await job.handler();
  } catch (err) {
    (logger.error ?? logger.warn).call(
      logger,
      { error: String(err) },
      "mnemo.audit.partition: startup run failed",
    );
  }
}
