/**
 * AB7.4 — SLOW_QUERY_THRESHOLDS constant + timing wrapper (spec §35 lines 4419–4420).
 */
import { describe, it, expect, vi } from "vitest";
import { SLOW_QUERY_THRESHOLDS, withSlowQueryLog } from "../perf/slow-query.js";

describe("SLOW_QUERY_THRESHOLDS — spec §35 lines 4419–4420", () => {
  it("recall threshold is 100ms", () => {
    expect(SLOW_QUERY_THRESHOLDS.recall).toBe(100);
  });

  it("write threshold is 50ms", () => {
    expect(SLOW_QUERY_THRESHOLDS.write).toBe(50);
  });

  it("admin threshold is 500ms", () => {
    expect(SLOW_QUERY_THRESHOLDS.admin).toBe(500);
  });
});

describe("withSlowQueryLog — timing wrapper", () => {
  it("does not log when operation is fast", async () => {
    const logger = { warn: vi.fn() };
    const result = await withSlowQueryLog("recall", async () => "ok", logger as any, 10_000);
    expect(result).toBe("ok");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs warn when operation exceeds threshold", async () => {
    const logger = { warn: vi.fn() };
    // artificially exceed threshold by passing a very low override
    const result = await withSlowQueryLog(
      "recall",
      async () => { await new Promise<void>(r => setTimeout(r, 10)); return "slow"; },
      logger as any,
      1, // 1ms threshold
    );
    expect(result).toBe("slow");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("slow_query"),
      expect.objectContaining({ kind: "recall" }),
    );
  });

  it("re-throws on error", async () => {
    const logger = { warn: vi.fn() };
    await expect(
      withSlowQueryLog("write", async () => { throw new Error("fail"); }, logger as any)
    ).rejects.toThrow("fail");
  });
});
