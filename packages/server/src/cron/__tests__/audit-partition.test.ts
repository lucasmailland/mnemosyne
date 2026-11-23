/**
 * APP-001 (audit 2026-11-22): the audit log ran out of partitions because the
 * job that extends it only ran on Sundays, reported its failure as a warning,
 * and was never run when the server came up.
 */
import { describe, expect, it, vi } from "vitest";

import { auditPartitionHandler, runAuditPartitionAtBoot } from "../auditPartition.js";

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("auditPartitionHandler", () => {
  it("asks the database for the partition runway", async () => {
    const runSql = vi.fn().mockResolvedValue([]);
    const log = logger();
    await auditPartitionHandler({ storage: { runSql }, logger: log });
    expect(runSql).toHaveBeenCalledWith("SELECT mnemosyne.mnemo_audit_create_next_partition()");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("reports a failed runway as an error: audit writes stop when the partitions run out", async () => {
    const runSql = vi.fn().mockRejectedValue(new Error("permission denied for schema mnemosyne"));
    const log = logger();
    await auditPartitionHandler({ storage: { runSql }, logger: log });
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = log.error.mock.calls[0]!;
    expect(String((fields as { error: string }).error)).toContain("permission denied");
    expect(message).toMatch(/audit/i);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to warn for a logger without error()", async () => {
    const runSql = vi.fn().mockRejectedValue(new Error("boom"));
    const log = { info: vi.fn(), warn: vi.fn() };
    await auditPartitionHandler({ storage: { runSql }, logger: log });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("runAuditPartitionAtBoot", () => {
  const job = (handler: () => Promise<void>) => ({
    key: "mnemo.audit.partition",
    schedule: { kind: "weeklyUtc" as const, weekday: 0, hour: 1, minute: 0 },
    handler,
  });

  it("runs the job once without waiting for its weekly slot", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await runAuditPartitionAtBoot([job(handler)], new Set(), logger());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("respects MNEMO_CRON_DISABLE", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await runAuditPartitionAtBoot([job(handler)], new Set(["mnemo.audit.partition"]), logger());
    expect(handler).not.toHaveBeenCalled();
  });

  it("never throws into the boot sequence", async () => {
    const log = logger();
    const handler = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(runAuditPartitionAtBoot([job(handler)], new Set(), log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
