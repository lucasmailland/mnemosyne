import { describe, it, expect, vi } from "vitest";
import { buildCronJobs } from "../jobs.js";
import { computeMerkleRoot } from "@mnemo-ai/adapter-postgres";
import { createHash } from "node:crypto";

// Helper: generate a mock audit entry with a real merkleHash
function mockAuditEntry(id: string, seed: string) {
  return {
    id,
    workspaceId: "ws1",
    action: "create",
    resourceKind: "fact",
    resourceId: `res-${id}`,
    createdAt: new Date(), // determinism-ok: throwaway fixture, not asserted
    merkleHash: createHash("sha256").update(seed).digest(),
  };
}

describe("SEC-4: Hourly Merkle root publication cron", () => {
  it("publishes structured log with merkleRoot, hourUtc, and audit_merkle_root:true", async () => {
    const entries = [
      mockAuditEntry("1", "entry1"),
      mockAuditEntry("2", "entry2"),
      mockAuditEntry("3", "entry3"),
    ];
    const loggerInfoSpy = vi.fn();
    const telemetryCounterSpy = vi.fn();

    const deps = {
      storage: {
        listAuditLog: vi.fn().mockResolvedValue(entries),
      } as any,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws1"]),
      collapseStaleSessions: vi.fn().mockResolvedValue(undefined),
      logger: {
        info: loggerInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      telemetry: {
        counter: telemetryCounterSpy,
        histogram: vi.fn(),
        gauge: vi.fn(),
        startSpan: () => ({ end() {} }),
      } as any,
    };

    const jobs = buildCronJobs(deps);
    const merklePublish = jobs.find((j) => j.key === "mnemo.audit.merkle.publish");
    expect(merklePublish).toBeDefined();

    // Execute the handler
    await merklePublish!.handler();

    // Verify storage was called
    expect(deps.storage.listAuditLog).toHaveBeenCalledWith("ws1", 1_000);

    // Verify structured log emission
    expect(loggerInfoSpy).toHaveBeenCalledTimes(1);
    const logCall = loggerInfoSpy.mock.calls[0];
    expect(logCall).toHaveLength(2);
    expect(logCall[1]).toBe("audit.merkle.root");

    const logPayload = logCall[0];
    expect(logPayload).toMatchObject({
      ws: "ws1",
      entryCount: 3,
      firstId: "1",
      lastId: "3",
      audit_merkle_root: true,
    });
    expect(logPayload.merkleRoot).toBeTruthy();
    expect(typeof logPayload.merkleRoot).toBe("string");
    expect(logPayload.merkleRoot).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    expect(logPayload.hourUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.\d{3}Z$/);

    // Verify telemetry counter
    expect(telemetryCounterSpy).toHaveBeenCalledWith("audit.merkle.root_published", 1, {
      workspaceId: "ws1",
    });
  });

  it("no-ops gracefully when workspace has no audit entries", async () => {
    const loggerInfoSpy = vi.fn();
    const telemetryCounterSpy = vi.fn();

    const deps = {
      storage: {
        listAuditLog: vi.fn().mockResolvedValue([]),
      } as any,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws1"]),
      collapseStaleSessions: vi.fn().mockResolvedValue(undefined),
      logger: {
        info: loggerInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      telemetry: {
        counter: telemetryCounterSpy,
        histogram: vi.fn(),
        gauge: vi.fn(),
        startSpan: () => ({ end() {} }),
      } as any,
    };

    const jobs = buildCronJobs(deps);
    const merklePublish = jobs.find((j) => j.key === "mnemo.audit.merkle.publish");
    await merklePublish!.handler();

    expect(deps.storage.listAuditLog).toHaveBeenCalledWith("ws1", 1_000);
    expect(loggerInfoSpy).not.toHaveBeenCalled();
    expect(telemetryCounterSpy).not.toHaveBeenCalled();
  });

  it("no-ops when all entries have null merkleHash (terminal GDPR records)", async () => {
    const entries = [
      { id: "1", workspaceId: "ws1", action: "hard_delete", merkleHash: null },
      { id: "2", workspaceId: "ws1", action: "hard_delete", merkleHash: null },
    ];
    const loggerInfoSpy = vi.fn();

    const deps = {
      storage: {
        listAuditLog: vi.fn().mockResolvedValue(entries),
      } as any,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws1"]),
      collapseStaleSessions: vi.fn().mockResolvedValue(undefined),
      logger: {
        info: loggerInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      telemetry: {
        counter: vi.fn(),
        histogram: vi.fn(),
        gauge: vi.fn(),
        startSpan: () => ({ end() {} }),
      } as any,
    };

    const jobs = buildCronJobs(deps);
    const merklePublish = jobs.find((j) => j.key === "mnemo.audit.merkle.publish");
    await merklePublish!.handler();

    expect(loggerInfoSpy).not.toHaveBeenCalled();
  });

  it("schedules hourly (3_600_000ms interval)", () => {
    const deps = {
      storage: {} as any,
      listWorkspaceIds: vi.fn().mockResolvedValue([]),
      collapseStaleSessions: vi.fn().mockResolvedValue(undefined),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      telemetry: {
        counter: vi.fn(),
        histogram: vi.fn(),
        gauge: vi.fn(),
        startSpan: () => ({ end() {} }),
      } as any,
    };

    const jobs = buildCronJobs(deps);
    const merklePublish = jobs.find((j) => j.key === "mnemo.audit.merkle.publish");
    expect(merklePublish!.schedule).toEqual({ kind: "interval", ms: 3_600_000 });
  });

  it("per-workspace isolation — each workspace gets its own root", async () => {
    const entriesWs1 = [mockAuditEntry("1", "ws1-entry1")];
    const entriesWs2 = [mockAuditEntry("2", "ws2-entry1")];
    const loggerInfoSpy = vi.fn();

    const deps = {
      storage: {
        listAuditLog: vi.fn().mockImplementation((ws: string) => {
          if (ws === "ws1") return Promise.resolve(entriesWs1);
          if (ws === "ws2") return Promise.resolve(entriesWs2);
          return Promise.resolve([]);
        }),
      } as any,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws1", "ws2"]),
      collapseStaleSessions: vi.fn().mockResolvedValue(undefined),
      logger: {
        info: loggerInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      telemetry: {
        counter: vi.fn(),
        histogram: vi.fn(),
        gauge: vi.fn(),
        startSpan: () => ({ end() {} }),
      } as any,
    };

    const jobs = buildCronJobs(deps);
    const merklePublish = jobs.find((j) => j.key === "mnemo.audit.merkle.publish");
    await merklePublish!.handler();

    expect(deps.storage.listAuditLog).toHaveBeenCalledWith("ws1", 1_000);
    expect(deps.storage.listAuditLog).toHaveBeenCalledWith("ws2", 1_000);
    expect(loggerInfoSpy).toHaveBeenCalledTimes(2);

    const ws1Log = loggerInfoSpy.mock.calls.find((c: any) => c[0].ws === "ws1");
    const ws2Log = loggerInfoSpy.mock.calls.find((c: any) => c[0].ws === "ws2");
    expect(ws1Log).toBeDefined();
    expect(ws2Log).toBeDefined();

    // Each workspace publishes its own distinct root
    expect(ws1Log![0].merkleRoot).not.toBe(ws2Log![0].merkleRoot);
  });

  it("computes deterministic root from the same entry set", () => {
    const entries = [mockAuditEntry("1", "deterministic1"), mockAuditEntry("2", "deterministic2")];

    const result1 = computeMerkleRoot(entries);
    const result2 = computeMerkleRoot(entries);

    expect(result1.root).toBe(result2.root);
    expect(result1.entryCount).toBe(2);
  });

  it("hourUtc is rounded down to the hour boundary", async () => {
    const entries = [mockAuditEntry("1", "time-test")];
    const loggerInfoSpy = vi.fn();

    const deps = {
      storage: {
        listAuditLog: vi.fn().mockResolvedValue(entries),
      } as any,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws1"]),
      collapseStaleSessions: vi.fn().mockResolvedValue(undefined),
      logger: {
        info: loggerInfoSpy,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      telemetry: {
        counter: vi.fn(),
        histogram: vi.fn(),
        gauge: vi.fn(),
        startSpan: () => ({ end() {} }),
      } as any,
    };

    const jobs = buildCronJobs(deps);
    const merklePublish = jobs.find((j) => j.key === "mnemo.audit.merkle.publish");
    await merklePublish!.handler();

    const logCall = loggerInfoSpy.mock.calls[0];
    const hourUtc = logCall[0].hourUtc;

    // Verify it's a valid ISO timestamp
    const timestamp = new Date(hourUtc);
    expect(timestamp.getUTCMinutes()).toBe(0);
    expect(timestamp.getUTCSeconds()).toBe(0);
  });
});
