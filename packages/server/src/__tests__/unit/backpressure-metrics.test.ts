import { describe, it, expect } from "vitest";
import {
  queueDepth, queueShedTotal, pgPoolUtilization,
  wsBufferDepth, wsDropsTotal, wsSlowConsumers,
  renderBackpressureMetrics,
} from "../../metrics/backpressure.js";
import { refreshSnapshotGauges } from "../../metrics/snapshot.js";
import type { ServerDeps } from "../../deps.js";

describe("§34.8/§34.10 backpressure metrics", () => {
  it("queueDepth gauge sets and renders a value", () => {
    queueDepth.set({ priority: "3", job_key: "consolidation" }, 7);
    const text = renderBackpressureMetrics();
    expect(text).toContain("mnemo_queue_depth");
    expect(text).toContain('job_key="consolidation"');
    expect(text).toContain(" 7");
  });

  it("refreshSnapshotGauges sets queue_depth from pending outbox count", async () => {
    // Use a unique count (42) that proves the gauge was set by this call, not by the first test
    const fakeStorage = { countPendingOutbox: async () => 42 } as unknown as ServerDeps["storage"];
    const fakeDeps = { storage: fakeStorage } as unknown as ServerDeps;
    await refreshSnapshotGauges(fakeDeps);
    const text = renderBackpressureMetrics();
    expect(text).toMatch(/mnemo_queue_depth\{[^}]*\}\s+42/);
  });

  it("queueShedTotal counter increments per stage", () => {
    queueShedTotal.inc({ stage: "stage2" });
    queueShedTotal.inc({ stage: "stage2" });
    expect(renderBackpressureMetrics()).toMatch(/mnemo_queue_shed_total\{stage="stage2"\} 2/);
  });

  it("pgPoolUtilization is a 0..1 gauge", () => {
    pgPoolUtilization.set({}, 0.83);
    expect(renderBackpressureMetrics()).toContain("mnemo_pg_pool_utilization");
  });

  it("ws gauges/counters exist and render", () => {
    wsBufferDepth.set({ connection_id: "c1", channel: "facts.*" }, 12);
    wsDropsTotal.inc({ connection_id: "c1", reason: "buffer_full" });
    wsSlowConsumers.set({}, 1);
    const t = renderBackpressureMetrics();
    expect(t).toContain("mnemo_ws_buffer_depth");
    expect(t).toContain("mnemo_ws_drops_total");
    expect(t).toContain("mnemo_ws_slow_consumers");
  });
});
