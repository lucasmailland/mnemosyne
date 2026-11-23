// Unit tests for Prometheus metrics wiring (Wave V §22 + B1.3 renames).
import { describe, it, expect } from "vitest";
import {
  renderMetrics,
  requestsTotal,
  recallLatency,
  observeDuration,
  consolidationDecisionsTotal,
  hotTierSize,
  circuitBreakerState,
  recordLlmUsage,
  tokensSavedTotal,
  reasoningWorthHistogram,
  sessionsCollapsedTotal,
} from "../../metrics/index.js";

describe("Prometheus metrics — renderMetrics()", () => {
  it("returns valid Prometheus text format with HELP and TYPE lines", () => {
    const text = renderMetrics();
    expect(text).toContain("# HELP mnemo_recall_duration_seconds");
    expect(text).toContain("# TYPE mnemo_recall_duration_seconds histogram");
    expect(text).toContain("# HELP mnemo_requests_total");
    expect(text).toContain("# TYPE mnemo_requests_total counter");
    expect(text).toContain("# HELP mnemo_hot_tier_size");
    expect(text).toContain("# TYPE mnemo_hot_tier_size gauge");
    expect(text).toContain("# HELP mnemo_circuit_breaker_state");
    expect(text).toContain("# TYPE mnemo_circuit_breaker_state gauge");
  });

  it("Counter.inc accumulates correctly", () => {
    requestsTotal.inc({ method: "GET", route: "/test", status: "200" });
    requestsTotal.inc({ method: "GET", route: "/test", status: "200" });
    const text = renderMetrics();
    expect(text).toMatch(/mnemo_requests_total\{.*route="\/test".*\} [2-9]\d*/);
  });

  it("Histogram.observe produces bucket lines", () => {
    const startedAt = Date.now() - 50; // determinism-ok: duration value not asserted, only checks metric was recorded
    observeDuration(recallLatency, { tier: "test", kind: "fact", cache_hit: "false" }, startedAt);
    const text = renderMetrics();
    expect(text).toContain("mnemo_recall_duration_seconds_bucket{");
    expect(text).toContain('le="+Inf"');
    expect(text).toContain("mnemo_recall_duration_seconds_sum{");
    expect(text).toContain("mnemo_recall_duration_seconds_count{");
  });

  it("Gauge.set records the latest value", () => {
    hotTierSize.set({ workspace: "ws1" }, 42);
    hotTierSize.set({ workspace: "ws1" }, 100);
    const text = renderMetrics();
    expect(text).toMatch(/mnemo_hot_tier_size\{.*workspace="ws1".*\} 100/);
  });

  it("circuit breaker gauge encodes state", () => {
    circuitBreakerState.set({ service: "llm.generate" }, 0);
    circuitBreakerState.set({ service: "llm.embed" }, 1);
    const text = renderMetrics();
    expect(text).toMatch(/mnemo_circuit_breaker_state\{.*service="llm\.generate".*\} 0/);
    expect(text).toMatch(/mnemo_circuit_breaker_state\{.*service="llm\.embed".*\} 1/);
  });

  it("output ends with newline", () => {
    const text = renderMetrics();
    expect(text.endsWith("\n")).toBe(true);
  });

  // ── LLM token/cost emission (OBSERVABILITY.md §3, AUDIT OPS-02) ──────────────
  // B1.3: renamed mnemo_llm_tokens_total → mnemo_llm_tokens_used_total{model,operation}
  it("recordLlmUsage emits mnemo_llm_tokens_used_total{model,operation} with real tokens", () => {
    recordLlmUsage({
      provider: "openai",
      model: "text-embedding-3-small",
      kind: "embedding",
      tokens: 120,
      costUSD: 0.0000024,
      operation: "embed",
    });
    const text = renderMetrics();
    expect(text).toContain("# TYPE mnemo_llm_tokens_used_total counter");
    expect(text).toMatch(
      /mnemo_llm_tokens_used_total\{model="text-embedding-3-small",operation="embed"\} 120/
    );
  });

  // B1.3: renamed mnemo_llm_cost_microdollars_total → mnemo_llm_cost_usd_total (unit: USD not µ$)
  it("recordLlmUsage emits mnemo_llm_cost_usd_total in USD", () => {
    recordLlmUsage({
      provider: "openai",
      model: "gpt-4o-mini",
      kind: "completion",
      tokens: 1000,
      costUSD: 0.0005,
      operation: "reasoning",
    });
    const text = renderMetrics();
    expect(text).toContain("# TYPE mnemo_llm_cost_usd_total counter");
    // The value is 0.0005 (USD, not µ$)
    expect(text).toMatch(
      /mnemo_llm_cost_usd_total\{model="gpt-4o-mini",operation="reasoning"\} 0\.0005/
    );
  });

  it("recordLlmUsage labels unpriced models 'unknown' and emits zero cost (no fabricated basis)", () => {
    recordLlmUsage({
      provider: "openai",
      model: "some-future-model-x",
      kind: "embedding",
      tokens: 50,
      costUSD: undefined,
    });
    const text = renderMetrics();
    // tokens still recorded, but under the bounded "unknown" model label
    expect(text).toMatch(
      /mnemo_llm_tokens_used_total\{model="unknown",operation="unknown"\} [5-9]\d*/
    );
    // no cost line for the unpriced model (zero cost is not incremented)
    expect(text).not.toMatch(/mnemo_llm_cost_usd_total\{model="some-future-model-x"/);
  });

  it("recordLlmUsage ignores non-positive / non-finite token counts", () => {
    recordLlmUsage({
      provider: "voyage",
      model: "voyage-3",
      kind: "embedding",
      tokens: 0,
      costUSD: 0,
    });
    recordLlmUsage({
      provider: "voyage",
      model: "voyage-3",
      kind: "embedding",
      tokens: Number.NaN,
      costUSD: 0,
    });
    const text = renderMetrics();
    expect(text).not.toMatch(/mnemo_llm_tokens_used_total\{model="voyage-3",operation="unknown"\}/);
  });

  // B1.3: renamed mnemo_consolidation_total{outcome} → mnemo_consolidation_decisions_total{decision}
  it("consolidationDecisionsTotal Counter accumulates by label", () => {
    consolidationDecisionsTotal.inc({ decision: "merged" });
    consolidationDecisionsTotal.inc({ decision: "merged" });
    consolidationDecisionsTotal.inc({ decision: "skipped" });
    const text = renderMetrics();
    expect(text).toContain("# TYPE mnemo_consolidation_decisions_total counter");
    expect(text).toMatch(/mnemo_consolidation_decisions_total\{.*decision="merged".*\} [2-9]\d*/);
    expect(text).toMatch(/mnemo_consolidation_decisions_total\{.*decision="skipped".*\} [1-9]\d*/);
  });

  // B1.1: tokensSavedTotal{mechanism} replaces reasoningTokensSaved
  it("tokensSavedTotal Counter accumulates by mechanism", () => {
    tokensSavedTotal.inc({ mechanism: "distillation" }, 100);
    tokensSavedTotal.inc({ mechanism: "composition" }, 200);
    tokensSavedTotal.inc({ mechanism: "hot_tier" }, 350);
    const text = renderMetrics();
    expect(text).toContain("# TYPE mnemo_tokens_saved_estimated_total counter");
    expect(text).toMatch(/mnemo_tokens_saved_estimated_total\{mechanism="distillation"\} [1-9]\d*/);
    expect(text).toMatch(/mnemo_tokens_saved_estimated_total\{mechanism="composition"\} [2-9]\d*/);
    expect(text).toMatch(/mnemo_tokens_saved_estimated_total\{mechanism="hot_tier"\} [3-9]\d*/);
  });

  // B1.2: reasoningWorthHistogram
  it("reasoningWorthHistogram is a histogram with [0.1..1.0] buckets", () => {
    reasoningWorthHistogram.observe({}, 0.75);
    reasoningWorthHistogram.observe({}, 0.3);
    const text = renderMetrics();
    expect(text).toContain("# TYPE mnemo_reasoning_worth_histogram histogram");
    expect(text).toContain("mnemo_reasoning_worth_histogram_bucket{");
    // with empty labels, count line has no {}: "mnemo_reasoning_worth_histogram_count 2"
    expect(text).toMatch(/mnemo_reasoning_worth_histogram_count \d+/);
  });

  // B1.3: sessionsCollapsedTotal
  it("sessionsCollapsedTotal Counter accumulates with reason+outcome labels", () => {
    sessionsCollapsedTotal.inc({ reason: "collapse", outcome: "success" });
    const text = renderMetrics();
    expect(text).toContain("# TYPE mnemo_sessions_collapsed_total counter");
    expect(text).toMatch(
      /mnemo_sessions_collapsed_total\{.*reason="collapse".*outcome="success".*\}/
    );
  });
});
