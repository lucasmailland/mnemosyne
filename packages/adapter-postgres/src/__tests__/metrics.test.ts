import { describe, it, expect, beforeEach } from "vitest";
import { pgQueryDuration, renderAdapterMetrics, resetAdapterMetricsForTesting } from "../metrics.js";

beforeEach(() => {
  resetAdapterMetricsForTesting();
});

describe("adapter-postgres metrics", () => {
  it("registers pg_query_duration_seconds with a query_type label after observe", () => {
    pgQueryDuration.observe({ query_type: "recall" }, 0.012);
    const text = renderAdapterMetrics();
    expect(text).toContain("# TYPE mnemo_pg_query_duration_seconds histogram");
    expect(text).toMatch(/mnemo_pg_query_duration_seconds_bucket\{query_type="recall",le="0\.05"\}/);
    expect(text).toContain("mnemo_pg_query_duration_seconds_count{query_type=\"recall\"}");
  });
  it("registers pg_pool_wait_duration_seconds", () => {
    const text = renderAdapterMetrics();
    expect(text).toContain("# TYPE mnemo_pg_pool_wait_duration_seconds histogram");
  });
});
