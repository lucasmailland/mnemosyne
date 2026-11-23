/**
 * APP-029 (audit 2026-11-22, S3): the unauthenticated bootstrap routes opened
 * a new Postgres connection on every request and closed it again. They now
 * share one small pool for the life of the server.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let opened = 0;
let ended = 0;

vi.mock("postgres", () => ({
  default: () => {
    opened++;
    const sql = (() => Promise.resolve([{ count: 0 }])) as unknown as Record<string, unknown>;
    sql.end = async () => {
      ended++;
    };
    return sql;
  },
}));

beforeEach(() => {
  opened = 0;
  ended = 0;
  process.env["DATABASE_URL"] = "postgres://fake:fake@localhost:5432/fake";
  vi.resetModules();
});
afterEach(() => vi.resetModules());

describe("bootstrap routes share one connection pool", () => {
  it("opens it once across requests and does not close it per request", async () => {
    const { mountBootstrap } = await import("../../routes/bootstrap.js");
    const app = new Hono();
    mountBootstrap(app);
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/bootstrap/status");
      expect(res.status).toBe(200);
    }
    expect(opened).toBe(1);
    expect(ended).toBe(0);
  });
});
