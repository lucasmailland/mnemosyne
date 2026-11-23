/**
 * Canary SLO gate unit tests — spec §35 C9.
 *
 * Tests evaluateCanarySloGate() using injected fake counter/histogram
 * objects so we never touch the real module-level metric singletons
 * (which accumulate across the whole test suite).
 */
import { describe, it, expect } from "vitest";
import { evaluateCanarySloGate } from "../../deploy/canarySloGate.js";
import type { ReadableCounter, QuantilableHistogram } from "../../deploy/canarySloGate.js";
import { DEFAULT_CANARY_CONFIG } from "@mnemo-ai/core/cognitive";

// ── Fake helpers ───────────────────────────────────────────────────────────────

function fakeCounter(entries: Array<{ status: string; count: number }>): ReadableCounter {
  const samples = entries.map(({ status, count }) => ({
    labels: { method: "GET", route: "/recall", status },
    value: count,
  }));
  return {
    read: () => samples.values(),
  };
}

function fakeHistogram(p99Seconds: number | null): QuantilableHistogram {
  return {
    quantile: (_q: number) => p99Seconds,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("evaluateCanarySloGate — spec §35 C9", () => {
  it("returns allow=false with insufficient_data when request count is below minimum", () => {
    const sources = {
      requestsCounter: fakeCounter([{ status: "200", count: 5 }]),
      recallHistogram: fakeHistogram(0.05),
    };
    const result = evaluateCanarySloGate(sources, DEFAULT_CANARY_CONFIG, 10);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/insufficient_data/);
    expect(result.metrics.totalRequests).toBe(5);
  });

  it("returns allow=false when error rate exceeds the SLO threshold", () => {
    // 3 / 100 = 3% error rate > 1% threshold
    const sources = {
      requestsCounter: fakeCounter([
        { status: "200", count: 97 },
        { status: "500", count: 3 },
      ]),
      recallHistogram: fakeHistogram(0.05),
    };
    const result = evaluateCanarySloGate(sources, DEFAULT_CANARY_CONFIG, 10);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/error_rate_exceeded/);
    expect(result.reason).toMatch(/3\.00%/);
    expect(result.metrics.errorRate).toBeCloseTo(0.03);
  });

  it("returns allow=false when recall p99 exceeds the latency SLO threshold", () => {
    // p99 = 250ms > DEFAULT threshold of 100ms
    const sources = {
      requestsCounter: fakeCounter([{ status: "200", count: 100 }]),
      recallHistogram: fakeHistogram(0.25), // 250ms in seconds
    };
    const result = evaluateCanarySloGate(sources, DEFAULT_CANARY_CONFIG, 10);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/recall_p99_exceeded/);
    expect(result.reason).toMatch(/250ms/);
    expect(result.metrics.recallP99Ms).toBeCloseTo(250);
  });

  it("returns allow=true when error rate and latency are within bounds", () => {
    // 0.5% error rate < 1% threshold; p99 = 50ms < 100ms threshold
    const sources = {
      requestsCounter: fakeCounter([
        { status: "200", count: 999 },
        { status: "500", count: 1 }, // 0.1% error rate
      ]),
      recallHistogram: fakeHistogram(0.05), // 50ms
    };
    const result = evaluateCanarySloGate(sources, DEFAULT_CANARY_CONFIG, 10);
    expect(result.allow).toBe(true);
    expect(result.reason).toMatch(/slo_ok/);
    expect(result.metrics.errorRate).toBeCloseTo(0.001);
  });

  it("returns allow=true when there is no recall data (null p99 does not block)", () => {
    // No recall histogram data — only error rate is checked
    const sources = {
      requestsCounter: fakeCounter([{ status: "200", count: 100 }]),
      recallHistogram: fakeHistogram(null),
    };
    const result = evaluateCanarySloGate(sources, DEFAULT_CANARY_CONFIG, 10);
    expect(result.allow).toBe(true);
    expect(result.metrics.recallP99Ms).toBeNull();
  });

  it("counts all 5xx status codes as errors", () => {
    // Multiple 5xx types
    const sources = {
      requestsCounter: fakeCounter([
        { status: "200", count: 90 },
        { status: "500", count: 5 },
        { status: "503", count: 5 }, // 10% total errors
      ]),
      recallHistogram: fakeHistogram(0.01),
    };
    const result = evaluateCanarySloGate(sources, DEFAULT_CANARY_CONFIG, 10);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/error_rate_exceeded/);
    expect(result.metrics.errorRequests).toBe(10);
  });

  it("does not count 4xx responses as errors", () => {
    // 4xx are client errors, not server errors — gate should pass
    const sources = {
      requestsCounter: fakeCounter([
        { status: "200", count: 90 },
        { status: "404", count: 5 },
        { status: "400", count: 5 }, // all 4xx, no 5xx
      ]),
      recallHistogram: fakeHistogram(0.05),
    };
    const result = evaluateCanarySloGate(sources, DEFAULT_CANARY_CONFIG, 10);
    expect(result.allow).toBe(true);
    expect(result.metrics.errorRequests).toBe(0);
  });

  it("respects custom canary config thresholds", () => {
    // With a looser threshold of 5% error rate, a 3% rate should pass
    const looseConfig = { ...DEFAULT_CANARY_CONFIG, errorRateDelta: 0.05 };
    const sources = {
      requestsCounter: fakeCounter([
        { status: "200", count: 97 },
        { status: "500", count: 3 }, // 3% errors
      ]),
      recallHistogram: fakeHistogram(0.05),
    };
    const result = evaluateCanarySloGate(sources, looseConfig, 10);
    expect(result.allow).toBe(true);
  });
});
