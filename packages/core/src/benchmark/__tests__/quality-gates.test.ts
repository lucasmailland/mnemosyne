import { describe, it, expect } from "vitest";
import {
  evaluateQualityGate,
  compareVersions,
  V3_QUALITY_TARGETS,
} from "../quality-gates.js";
import type { BenchmarkResult } from "../metrics.js";

function result(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    totalQuestions: 100,
    k: 10,
    recallAtK: 0.99,
    precisionAtK: 0.97,
    f1AtK: 0.98,
    answerCoverage: 0.99,
    mrr: 0.9,
    byCategory: {},
    perQuestion: [],
    ...over,
  };
}

describe("§29 absolute quality gates", () => {
  it("passes when all v3.0 targets are met", () => {
    const report = evaluateQualityGate(
      { result: result(), staleRate: 0.01, avgCostUsd: 0.02 },
      V3_QUALITY_TARGETS,
    );
    expect(report.passed).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("fails when recall is below the 98% target", () => {
    const report = evaluateQualityGate({ result: result({ recallAtK: 0.9 }) });
    expect(report.passed).toBe(false);
    expect(report.failures.join(" ")).toMatch(/recall@K/);
  });

  it("fails when noise exceeds 5% (precision < 95%)", () => {
    const report = evaluateQualityGate({ result: result({ precisionAtK: 0.8 }) });
    expect(report.passed).toBe(false);
    expect(report.failures.join(" ")).toMatch(/noise/);
  });

  it("fails on stale-rate > 2% and cost > $0.03 when supplied", () => {
    const report = evaluateQualityGate({ result: result(), staleRate: 0.05, avgCostUsd: 0.1 });
    expect(report.passed).toBe(false);
    expect(report.failures.join(" ")).toMatch(/staleRate/);
    expect(report.failures.join(" ")).toMatch(/avgCost/);
  });

  it("skips stale/cost checks when not supplied", () => {
    const report = evaluateQualityGate({ result: result() });
    expect(report.passed).toBe(true);
    expect(report.metrics.staleRate).toBeNull();
    expect(report.metrics.avgCostUsd).toBeNull();
  });

  it("compareVersions reports per-metric v1.6→v3.0 deltas", () => {
    const v16 = result({ recallAtK: 0.95, f1AtK: 0.93, answerCoverage: 0.9, mrr: 0.8, precisionAtK: 0.9 });
    const v30 = result({ recallAtK: 0.99, f1AtK: 0.98, answerCoverage: 0.99, mrr: 0.9, precisionAtK: 0.97 });
    const cmp = compareVersions(v16, v30);
    const recall = cmp.find((c) => c.metric === "recallAtK")!;
    expect(recall.delta).toBeCloseTo(0.04, 5);
    expect(recall.improved).toBe(true);
    expect(cmp.every((c) => c.improved)).toBe(true);
  });
});
