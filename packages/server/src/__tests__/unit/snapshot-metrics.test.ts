import { describe, it, expect, beforeEach } from "vitest";
import {
  factsTotal,
  worthDistribution,
  tasksTotal,
  tasksStaleTotal,
  taskDelegationTotal,
  renderMetrics,
} from "../../metrics/index.js";
import { refreshSnapshotGauges } from "../../metrics/snapshot.js";
import type { ServerDeps } from "../../deps.js";

// Metrics are module singletons — gauge tests use overwriting set() so
// order doesn't matter; counter tests accumulate (still passes assertions).
beforeEach(() => {
  // Reset gauges to 0 so earlier test runs don't bleed into later ones.
  factsTotal.set({}, 0);
  worthDistribution.set({}, 0);
  tasksTotal.set({}, 0);
  tasksStaleTotal.set({}, 0);
});

function makeDeps(
  overrides: Partial<NonNullable<ServerDeps["storage"]>> = {},
): ServerDeps {
  return {
    storage: {
      countFactsByTypeStatus: async () => [
        { type: "fact", status: "active", count: 7 },
        { type: "episode", status: "archived", count: 2 },
      ],
      worthHistogram: async () => [
        { bucket: "0.0-0.2", count: 1 },
        { bucket: "0.2-0.4", count: 3 },
        { bucket: "0.4-0.6", count: 5 },
        { bucket: "0.6-0.8", count: 4 },
        { bucket: "0.8-1.0", count: 8 },
      ],
      countActiveSessions: async () => 3,
      countTasksByStatus: async () => [
        { status: "pending", count: 5 },
        { status: "in_progress", count: 2 },
      ],
      countStaleTasks: async () => 3,
      ...overrides,
    } as unknown as ServerDeps["storage"],
  } as unknown as ServerDeps;
}

describe("refreshSnapshotGauges", () => {
  it("sets mnemo_facts_total{type=fact,status=active} to 7", async () => {
    await refreshSnapshotGauges(makeDeps());
    const output = renderMetrics();
    expect(output).toMatch(/mnemo_facts_total\{[^}]*type="fact"[^}]*status="active"[^}]*\} 7/);
  });

  it("sets mnemo_tasks_stale_total to 3", async () => {
    await refreshSnapshotGauges(makeDeps());
    const output = renderMetrics();
    expect(output).toMatch(/mnemo_tasks_stale_total\s+3/);
  });

  it("sets mnemo_worth_distribution{bucket=0.8-1.0} to 8", async () => {
    await refreshSnapshotGauges(makeDeps());
    const output = renderMetrics();
    expect(output).toContain('mnemo_worth_distribution{bucket="0.8-1.0"} 8');
  });

  it("renders # TYPE mnemo_session_turns_histogram histogram", () => {
    const output = renderMetrics();
    expect(output).toContain("# TYPE mnemo_session_turns_histogram histogram");
  });

  it("does not throw when storage methods are absent", async () => {
    const deps = { storage: {} } as unknown as ServerDeps;
    await expect(refreshSnapshotGauges(deps)).resolves.toBeUndefined();
  });
});

describe("taskDelegationTotal counter", () => {
  it("inc renders the counter line", () => {
    taskDelegationTotal.inc({ from_agent: "agent-a", to_agent: "agent-b" });
    const output = renderMetrics();
    expect(output).toMatch(/mnemo_task_delegation_total\{[^}]*from_agent="agent-a"[^}]*to_agent="agent-b"[^}]*\}/);
  });
});


// Re-audit 2026-11-22: the ROI gauge read as a measured return; its numerator
// is the estimated-savings counter, which only distillation feeds.
describe("mnemo_roi_multiplier help text", () => {
  it("says it is an estimate built from estimated distillation savings", async () => {
    const { roiMultiplier } = await import("../../metrics/index.js");
    expect(roiMultiplier.help).toMatch(/estimate/i);
    expect(roiMultiplier.help).toMatch(/distillation/);
    expect(roiMultiplier.help).toMatch(/mnemo_tokens_saved_estimated_total/);
  });
});
