/**
 * V-1: an opossum breaker timeout (code ETIMEDOUT, "Timed out after Nms") used
 * to be mapped as a database outage, so a slow LLM rerank inside the read
 * breaker answered "The database is temporarily unavailable. A write may or may
 * not have been applied" on a read. It is a dependency timeout, said as such.
 */
import { describe, it, expect } from "vitest";
import { toErrorBody } from "../../errors.js";

const breakerTimeout = () =>
  Object.assign(new Error("Timed out after 5000ms"), { code: "ETIMEDOUT" });

describe("toErrorBody — breaker timeouts", () => {
  it("is a 503 with a retry hint that does not blame the database", () => {
    const { status, body } = toErrorBody(breakerTimeout());
    expect(status).toBe(503);
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.message).not.toMatch(/database/i);
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("still blames the database for a real connection failure", () => {
    const { status, body } = toErrorBody(
      new Error("Failed query", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      })
    );
    expect(status).toBe(503);
    expect(body.error.message).toMatch(/database/i);
  });
});
