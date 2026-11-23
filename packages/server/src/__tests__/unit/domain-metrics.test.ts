import { describe, it, expect } from "vitest";
import { reasoningResolve, federationSyncDuration, queueFailed, queueCompleted, renderMetrics, reasoningResolveLatency } from "../../metrics/index.js";

describe("domain metrics", () => {
  // Note: these are module-level singletons — they accumulate across tests.
  // Assertions use toContain/toMatch rather than exact counts.

  it("reasoningResolve increments cache_hit", () => {
    reasoningResolve.inc({ result: "cache_hit" });
    expect(renderMetrics()).toContain("mnemo_reasoning_resolve_total{result=\"cache_hit\"}");
  });

  it("queueFailed increments with job_key label", () => {
    queueFailed.inc({ job_key: "consolidation" });
    expect(renderMetrics()).toContain("mnemo_queue_failed_total{job_key=\"consolidation\"}");
  });

  it("federationSyncDuration is a histogram", () => {
    expect(renderMetrics()).toContain("# TYPE mnemo_federation_sync_duration_seconds histogram");
  });

  it("queueCompleted increments with job_key label", () => {
    queueCompleted.inc({ job_key: "federation_sync" });
    expect(renderMetrics()).toContain("mnemo_queue_completed_total{job_key=\"federation_sync\"}");
  });

  it("declares reasoning resolve latency histogram with path label", () => {
    reasoningResolveLatency.observe({ path: "topic_key" }, 0.004);
    expect(renderMetrics()).toMatch(/mnemo_reasoning_resolve_latency_seconds_bucket\{[^}]*path="topic_key"/);
  });
});
