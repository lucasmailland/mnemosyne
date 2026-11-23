import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { runGraduationTick } from "../graduation.js";
import type { OutboxAdapter, Logger } from "@mnemo-ai/types";

// GRADUATION thresholds (from learningMode.ts):
//   factCount: 50, sessionCount: 10, entityCount: 5, daysElapsed: 14
// A workspace satisfies graduation when ANY single criterion is met.

const noopOutbox: OutboxAdapter = {
  append: async () => undefined,
  claimBatch: async () => [],
  markProcessed: async () => undefined,
  markFailed: async () => undefined,
  getStats: async () => ({ pending: 0, failed: 0, oldestPendingMs: 0 }),
};

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

describe("runGraduationTick", () => {
  it("returns adapter_unsupported when storage lacks mode methods", async () => {
    // Minimal stub without the workspace-mode methods
    const storage = {} as Parameters<typeof runGraduationTick>[0];
    const result = await runGraduationTick(storage, noopOutbox, silentLogger, "ws-1");
    expect(result.graduated).toBe(false);
    expect(result.reason).toBe("adapter_unsupported");
  });

  it("returns not_learning when workspace is already in production", async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.setWorkspaceMode("ws-1", { mode: "production" });
    const result = await runGraduationTick(storage, noopOutbox, silentLogger, "ws-1");
    expect(result.graduated).toBe(false);
    expect(result.reason).toBe("not_learning");
  });

  it("returns not_learning when workspace has no mode row (getWorkspaceMode returns null)", async () => {
    const storage = new InMemoryStorageAdapter();
    // No mode row seeded — getWorkspaceMode returns null → still "not_learning" because
    // null means no record at all, and the function checks row.mode !== "learning".
    const result = await runGraduationTick(storage, noopOutbox, silentLogger, "ws-null");
    expect(result.graduated).toBe(false);
    expect(result.reason).toBe("not_learning");
  });

  it("graduates a workspace that meets criteria (sessionCount >= 10)", async () => {
    const storage = new InMemoryStorageAdapter();
    // sessionCount=20 exceeds threshold of 10 → should graduate
    await storage.setWorkspaceMode("ws-2", {
      mode: "learning",
      sessionCount: 20,
      factCount: 100,
      entityCount: 0,
      promoteAt: null,
    });
    const result = await runGraduationTick(storage, noopOutbox, silentLogger, "ws-2");
    expect(result.graduated).toBe(true);
    expect(result.eventName).toBe("workspace.graduated_learning_mode");
    const updated = await storage.getWorkspaceMode("ws-2");
    expect(updated?.mode).toBe("production");
  });

  it("returns criteria_not_met for a workspace below all thresholds", async () => {
    const storage = new InMemoryStorageAdapter();
    // sessionCount=1 < 10, factCount=1 < 50, entityCount=0 < 5, no startedAt (no days)
    await storage.setWorkspaceMode("ws-3", {
      mode: "learning",
      sessionCount: 1,
      factCount: 1,
      entityCount: 0,
      promoteAt: null,
    });
    const result = await runGraduationTick(storage, noopOutbox, silentLogger, "ws-3");
    expect(result.graduated).toBe(false);
    expect(result.reason).toBe("criteria_not_met");
  });
});
