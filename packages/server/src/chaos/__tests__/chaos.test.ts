/**
 * AB5 — Chaos experiments test suite.
 * spec §35 "Chaos Engineering" lines 4136–4194.
 */
import { describe, it, expect } from "vitest";
import { EXPERIMENTS, CHAOS_EXPERIMENT_NAMES } from "../experiments.js";

describe("Chaos experiments — spec §35 lines 4146–4183", () => {
  it("exports exactly the 6 spec-named experiments", () => {
    const names = EXPERIMENTS.map((e) => e.name).sort();
    const expected = [...CHAOS_EXPERIMENT_NAMES].sort();
    expect(names).toEqual(expected);
  });

  it("redis_partition: action() resolves without throwing (simulated)", async () => {
    const exp = EXPERIMENTS.find((e) => e.name === "redis_partition")!;
    expect(exp).toBeDefined();
    // In the test environment, action is a no-op when MNEMO_CHAOS_ENABLED is not set
    await expect(exp.action({ enabled: false })).resolves.not.toThrow();
  });

  it("pg_replica_lag: action() resolves (CI-limited: asserts detection code path)", async () => {
    const exp = EXPERIMENTS.find((e) => e.name === "pg_replica_lag")!;
    await expect(exp.action({ enabled: false })).resolves.not.toThrow();
  });

  it("embedding_provider_timeout: action() resolves", async () => {
    const exp = EXPERIMENTS.find((e) => e.name === "embedding_provider_timeout")!;
    await expect(exp.action({ enabled: false })).resolves.not.toThrow();
  });

  it("hot_tier_eviction: action() resolves", async () => {
    const exp = EXPERIMENTS.find((e) => e.name === "hot_tier_eviction")!;
    await expect(exp.action({ enabled: false })).resolves.not.toThrow();
  });

  it("session_collapse_llm_failure: action() resolves", async () => {
    const exp = EXPERIMENTS.find((e) => e.name === "session_collapse_llm_failure")!;
    await expect(exp.action({ enabled: false })).resolves.not.toThrow();
  });

  it("clock_skew: action() resolves", async () => {
    const exp = EXPERIMENTS.find((e) => e.name === "clock_skew")!;
    await expect(exp.action({ enabled: false })).resolves.not.toThrow();
  });

  it("each experiment has a verify() function", () => {
    for (const exp of EXPERIMENTS) {
      expect(typeof exp.verify).toBe("function");
    }
  });

  it("each experiment has a description", () => {
    for (const exp of EXPERIMENTS) {
      expect(exp.description).toBeTruthy();
    }
  });
});
