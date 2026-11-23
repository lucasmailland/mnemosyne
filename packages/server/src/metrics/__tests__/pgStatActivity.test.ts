import { describe, it, expect, vi } from "vitest";
import { computePoolUtilFromStat, readPgStatActivityUtil } from "../pgPool.js";

describe("computePoolUtilFromStat", () => {
  it("returns active/max when in range", () => {
    expect(computePoolUtilFromStat({ active: 5, max: 10 })).toBeCloseTo(0.5);
  });
  it("clamps to 1 when active > max", () => {
    expect(computePoolUtilFromStat({ active: 15, max: 10 })).toBe(1);
  });
  it("clamps to 0 when active is 0", () => {
    expect(computePoolUtilFromStat({ active: 0, max: 10 })).toBe(0);
  });
  it("returns 0 when max is 0", () => {
    expect(computePoolUtilFromStat({ active: 5, max: 0 })).toBe(0);
  });
});

describe("readPgStatActivityUtil", () => {
  it("returns computed ratio from query result", async () => {
    const sql = vi.fn().mockResolvedValue([{ active: 8, max: 100 }]) as any;
    sql[Symbol.iterator] = undefined;
    // postgres-js tagged-template returns a Promise — mock it as a callable that returns the result
    const mockSql = Object.assign(
      (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([{ active: 8, max: 100 }]),
      {},
    ) as any;
    const result = await readPgStatActivityUtil(mockSql);
    expect(result).toBeCloseTo(0.08);
  });

  it("returns 0 when query throws", async () => {
    const mockSql = Object.assign(
      (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.reject(new Error("connection refused")),
      {},
    ) as any;
    const result = await readPgStatActivityUtil(mockSql);
    expect(result).toBe(0);
  });

  it("returns 0 when query returns empty rows", async () => {
    const mockSql = Object.assign(
      (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
      {},
    ) as any;
    const result = await readPgStatActivityUtil(mockSql);
    expect(result).toBe(0);
  });
});
