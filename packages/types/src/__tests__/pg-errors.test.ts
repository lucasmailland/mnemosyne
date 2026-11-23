// CHAOS-10: with Postgres down, writes answered 500 `internal_error`. The
// error handler (WP-9) needs to tell "the database is unavailable or timed
// out, retry later" (503 + Retry-After) from a real bug. This is the
// classification it can rely on.
import { describe, expect, it } from "vitest";
import { isTransientDbError } from "../pg-errors.js";

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code, severity: "ERROR" });
}

describe("isTransientDbError", () => {
  // V-1: opossum's own timeout carries code ETIMEDOUT too. It says a wrapped
  // call (an LLM rerank, an embed) ran long, not that the database failed.
  it("an opossum breaker timeout is not a database failure", () => {
    const timeout = Object.assign(new Error("Timed out after 5000ms"), { code: "ETIMEDOUT" });
    expect(isTransientDbError(timeout)).toBe(false);
    expect(isTransientDbError(new Error("wrapped", { cause: timeout }))).toBe(false);
  });

  it("a socket ETIMEDOUT behind a driver error is still transient", () => {
    const socket = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:5432"), {
      code: "ETIMEDOUT",
    });
    expect(isTransientDbError(socket)).toBe(true);
  });

  it.each([
    ["ECONNREFUSED"],
    ["ECONNRESET"],
    ["ETIMEDOUT"],
    ["EHOSTUNREACH"],
    ["ENOTFOUND"],
    ["CONNECT_TIMEOUT"],
    ["CONNECTION_CLOSED"],
    ["CONNECTION_ENDED"],
    ["CONNECTION_DESTROYED"],
  ])("driver/network failure %s is transient", (code) => {
    expect(isTransientDbError(Object.assign(new Error(code), { code }))).toBe(true);
  });

  it.each([
    ["08006", "connection failure"],
    ["08001", "cannot establish connection"],
    ["57P01", "admin shutdown"],
    ["57P03", "cannot connect now (starting up)"],
    ["53300", "too many connections"],
    ["57014", "statement_timeout"],
    ["55P03", "lock_timeout"],
    ["25P03", "idle_in_transaction_session_timeout"],
  ])("SQLSTATE %s (%s) is transient", (code) => {
    expect(isTransientDbError(pgError(code))).toBe(true);
  });

  it("looks through Drizzle's wrapper (`cause`)", () => {
    const wrapped = Object.assign(new Error("Failed query: insert ..."), {
      cause: pgError("57014"),
    });
    expect(isTransientDbError(wrapped)).toBe(true);
  });

  it.each([
    ["23505", "unique violation"],
    ["42501", "insufficient privilege / RLS"],
    ["22P02", "invalid input syntax"],
    ["42P01", "undefined table"],
  ])("SQLSTATE %s (%s) is NOT transient: retrying cannot fix it", (code) => {
    expect(isTransientDbError(pgError(code))).toBe(false);
  });

  it("plain errors and non-errors are not transient", () => {
    expect(isTransientDbError(new Error("boom"))).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError("ECONNREFUSED")).toBe(false);
  });
});
