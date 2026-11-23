import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";

const RULES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../docker/scripts/prometheus-rules.yml"
);

describe("prometheus-rules.yml — burn-rate rules", () => {
  let doc: any;
  beforeAll(() => {
    const raw = readFileSync(RULES_PATH, "utf-8");
    doc = yaml.load(raw);
  });
  it("parses without error", () => {
    expect(doc).toBeTruthy();
  });
  it("contains MnemoErrorBudgetBurnFast alert", () => {
    const groups = doc?.groups ?? [];
    const alerts = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.alert);
    expect(alerts.map((a: any) => a.alert)).toContain("MnemoErrorBudgetBurnFast");
  });
  it("contains MnemoErrorBudgetBurnSlow alert", () => {
    const groups = doc?.groups ?? [];
    const alerts = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.alert);
    expect(alerts.map((a: any) => a.alert)).toContain("MnemoErrorBudgetBurnSlow");
  });
  it("contains error-rate recording rules", () => {
    const groups = doc?.groups ?? [];
    const recordings = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.record);
    const names = recordings.map((r: any) => r.record);
    expect(names).toContain("mnemo:request:error_rate5m");
    expect(names).toContain("mnemo:request:error_rate1h");
    expect(names).toContain("mnemo:request:error_rate6h");
  });
  it("fast burn alert has severity: critical", () => {
    const groups = doc?.groups ?? [];
    const fastBurn = groups
      .flatMap((g: any) => g.rules ?? [])
      .find((r: any) => r.alert === "MnemoErrorBudgetBurnFast");
    expect(fastBurn?.labels?.severity).toBe("critical");
  });
  it("slow burn alert has severity: warning", () => {
    const groups = doc?.groups ?? [];
    const slowBurn = groups
      .flatMap((g: any) => g.rules ?? [])
      .find((r: any) => r.alert === "MnemoErrorBudgetBurnSlow");
    expect(slowBurn?.labels?.severity).toBe("warning");
  });
});

describe("prometheus-rules.yml — tiered-recall SLOs", () => {
  let doc: any;
  beforeAll(() => {
    const raw = readFileSync(RULES_PATH, "utf-8");
    doc = yaml.load(raw);
  });
  it("contains hot-tier latency recording rule", () => {
    const groups = doc?.groups ?? [];
    const recordings = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.record);
    expect(recordings.map((r: any) => r.record)).toContain("mnemo:recall_hot:p99_latency");
  });
  it("contains warm-tier latency recording rule", () => {
    const groups = doc?.groups ?? [];
    const recordings = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.record);
    expect(recordings.map((r: any) => r.record)).toContain("mnemo:recall_warm:p99_latency");
  });
  it("contains cold-tier latency recording rule", () => {
    const groups = doc?.groups ?? [];
    const recordings = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.record);
    expect(recordings.map((r: any) => r.record)).toContain("mnemo:recall_cold:p99_latency");
  });
  it("contains reasoning cache hit ratio recording rule", () => {
    const groups = doc?.groups ?? [];
    const recordings = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.record);
    expect(recordings.map((r: any) => r.record)).toContain("mnemo:reasoning:cache_hit_ratio");
  });
  it("contains hot-tier hit ratio recording rule", () => {
    const groups = doc?.groups ?? [];
    const recordings = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.record);
    expect(recordings.map((r: any) => r.record)).toContain("mnemo:recall:hot_tier_hit_ratio");
  });
  it("contains MnemoHotTierLatencySLOBreach alert", () => {
    const groups = doc?.groups ?? [];
    const alerts = groups.flatMap((g: any) => g.rules ?? []).filter((r: any) => r.alert);
    expect(alerts.map((a: any) => a.alert)).toContain("MnemoHotTierLatencySLOBreach");
  });
  it("MnemoHotTierLatencySLOBreach has 10ms threshold", () => {
    const groups = doc?.groups ?? [];
    const alert = groups
      .flatMap((g: any) => g.rules ?? [])
      .find((r: any) => r.alert === "MnemoHotTierLatencySLOBreach");
    expect(alert?.expr).toContain("0.01");
  });
  it("contains MnemoColdTierLatencySLOBreach alert with critical severity", () => {
    const groups = doc?.groups ?? [];
    const alert = groups
      .flatMap((g: any) => g.rules ?? [])
      .find((r: any) => r.alert === "MnemoColdTierLatencySLOBreach");
    expect(alert?.labels?.severity).toBe("critical");
  });
});
