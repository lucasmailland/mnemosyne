/**
 * APP-073 (audit 2026-11-22): writing a confidential or restricted memory on a
 * server without MNEMO_MASTER_KEY answered a bare 500. The server still
 * refuses (it never stores plaintext), but now says why, and as a 422: a
 * retry cannot help; a lower tier or the operator's key can.
 */
import { describe, it, expect } from "vitest";
import { toErrorBody } from "../../errors.js";

describe("toErrorBody — encryption not configured", () => {
  it("is a 422 that names the missing key, without retry advice", () => {
    const err = Object.assign(new Error("C1 fail-closed: cannot encrypt restricted fact"), {
      code: "encryption_not_configured",
    });
    const { status, body } = toErrorBody(err);
    expect(status).toBe(422);
    expect(body.error.code).toBe("encryption_not_configured");
    expect(body.error.message).toMatch(/MNEMO_MASTER_KEY/);
    expect(body.error.retryAfterSeconds).toBeUndefined();
  });
});
