import { describe, expect, it } from "vitest";
import {
  DEFAULT_PG_SESSION_TIMEOUTS,
  pgSessionTimeoutParams,
  resolvePgMaintenanceTimeoutMs,
  resolvePgSessionTimeouts,
} from "../pg-session.js";

describe("resolvePgSessionTimeouts (PG-TIMEOUTS)", () => {
  it("defaults to bounded limits with lock_timeout < statement_timeout", () => {
    const t = resolvePgSessionTimeouts({});
    expect(t).toEqual(DEFAULT_PG_SESSION_TIMEOUTS);
    expect(t.statementTimeoutMs).toBeGreaterThan(0);
    expect(t.idleInTransactionTimeoutMs).toBeGreaterThan(0);
    expect(t.lockTimeoutMs).toBeGreaterThan(0);
    expect(t.lockTimeoutMs).toBeLessThan(t.statementTimeoutMs);
  });

  it("reads each limit from its env var, in ms", () => {
    expect(
      resolvePgSessionTimeouts({
        MNEMO_PG_STATEMENT_TIMEOUT_MS: "20000",
        MNEMO_PG_LOCK_TIMEOUT_MS: "5000",
        MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: "30000",
      })
    ).toEqual({ statementTimeoutMs: 20_000, lockTimeoutMs: 5_000, idleInTransactionTimeoutMs: 30_000 });
  });

  it("treats an empty value as unset", () => {
    expect(resolvePgSessionTimeouts({ MNEMO_PG_STATEMENT_TIMEOUT_MS: "" })).toEqual(
      DEFAULT_PG_SESSION_TIMEOUTS
    );
  });

  it("allows 0 (leave the limit to the role/server)", () => {
    const t = resolvePgSessionTimeouts({
      MNEMO_PG_STATEMENT_TIMEOUT_MS: "0",
      MNEMO_PG_LOCK_TIMEOUT_MS: "0",
      MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0",
    });
    expect(t).toEqual({ statementTimeoutMs: 0, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 0 });
  });

  it.each(["abc", "-1", "1.5", "1e309"])("rejects a non-integer or negative value (%s)", (v) => {
    expect(() => resolvePgSessionTimeouts({ MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: v })).toThrow(
      /MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS/
    );
  });

  it("rejects a lock_timeout that is not shorter than statement_timeout", () => {
    expect(() =>
      resolvePgSessionTimeouts({
        MNEMO_PG_STATEMENT_TIMEOUT_MS: "10000",
        MNEMO_PG_LOCK_TIMEOUT_MS: "10000",
      })
    ).toThrow(/shorter than/);
    // Not set here (0): nothing to compare against.
    expect(() =>
      resolvePgSessionTimeouts({ MNEMO_PG_STATEMENT_TIMEOUT_MS: "10000", MNEMO_PG_LOCK_TIMEOUT_MS: "0" })
    ).not.toThrow();
  });
});

describe("pgSessionTimeoutParams", () => {
  it("maps to the Postgres GUC names as strings", () => {
    expect(
      pgSessionTimeoutParams({ statementTimeoutMs: 1, lockTimeoutMs: 2, idleInTransactionTimeoutMs: 3 })
    ).toEqual({
      statement_timeout: "1",
      lock_timeout: "2",
      idle_in_transaction_session_timeout: "3",
    });
  });

  it("leaves a 0 limit out so a role-level setting or a strict pooler is respected", () => {
    expect(
      pgSessionTimeoutParams({ statementTimeoutMs: 0, lockTimeoutMs: 2, idleInTransactionTimeoutMs: 0 })
    ).toEqual({ lock_timeout: "2" });
  });
});

describe("resolvePgMaintenanceTimeoutMs", () => {
  it("is unlimited (0) unless set", () => {
    expect(resolvePgMaintenanceTimeoutMs({})).toBe(0);
    expect(resolvePgMaintenanceTimeoutMs({ MNEMO_PG_MAINTENANCE_STATEMENT_TIMEOUT_MS: "900000" })).toBe(
      900_000
    );
  });
});
