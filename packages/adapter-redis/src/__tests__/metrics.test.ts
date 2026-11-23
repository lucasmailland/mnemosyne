import { describe, it, expect, beforeEach } from "vitest";
import { redisOperations, redisLatency, renderRedisMetrics, resetRedisMetricsForTesting } from "../metrics.js";

beforeEach(() => {
  resetRedisMetricsForTesting();
});

describe("adapter-redis metrics", () => {
  it("registers mnemo_redis_operations_total after inc", () => {
    redisOperations.inc({ operation: "get" });
    const text = renderRedisMetrics();
    expect(text).toContain("mnemo_redis_operations_total{operation=\"get\"} 1");
  });

  it("registers mnemo_redis_latency_seconds as histogram", () => {
    redisLatency.observe({ operation: "get" }, 0.001);
    const text = renderRedisMetrics();
    expect(text).toContain("# TYPE mnemo_redis_latency_seconds histogram");
    expect(text).toContain("mnemo_redis_latency_seconds_count{operation=\"get\"} 1");
  });

  it("registers mnemo_redis_memory_used_bytes as gauge", () => {
    const text = renderRedisMetrics();
    expect(text).toContain("# TYPE mnemo_redis_memory_used_bytes gauge");
  });
});
