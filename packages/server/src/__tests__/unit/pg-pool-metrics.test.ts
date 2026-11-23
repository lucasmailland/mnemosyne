import { describe, it, expect } from "vitest";
import type postgres from "postgres";
import { readPgPoolStats } from "../../metrics/pgPool.js";

type SqlClient = ReturnType<typeof postgres>;

describe("readPgPoolStats", () => {
  it("returns zeros when sql has no reserved/options", () => {
    const fakeSql = {} as unknown as SqlClient;
    const stats = readPgPoolStats(fakeSql);
    expect(stats).toEqual({ active: 0, idle: 0, total: 0 });
  });

  it("reads active from reserved array length", () => {
    const fakeSql = {
      reserved: ["conn1", "conn2"],
      options: { max: 10 },
    } as unknown as SqlClient;
    const stats = readPgPoolStats(fakeSql);
    expect(stats.active).toBe(2);
    expect(stats.total).toBe(10);
    expect(stats.idle).toBe(8);
  });

  it("clamps idle to zero when active exceeds total", () => {
    const fakeSql = {
      reserved: ["a", "b", "c"],
      options: { max: 2 },
    } as unknown as SqlClient;
    const stats = readPgPoolStats(fakeSql);
    expect(stats.idle).toBe(0);
  });

  it("returns zeros gracefully when sql throws on access", () => {
    const fakeSql = new Proxy({} as unknown as SqlClient, {
      get() { throw new Error("unexpected internal access"); },
    });
    const stats = readPgPoolStats(fakeSql);
    expect(stats).toEqual({ active: 0, idle: 0, total: 0 });
  });
});
