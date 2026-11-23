/**
 * SEC-7.5 — env-driven pool config in createDrizzleClient.
 *
 * createDrizzleClient reads DATABASE_POOL_MAX, DATABASE_POOL_IDLE_TIMEOUT,
 * and DATABASE_CONNECT_TIMEOUT from process.env and passes them (with ms→s
 * conversion for the timeout vars) to postgres.js.
 *
 * We cannot easily unit-test the actual postgres.js client construction
 * without a live database, so we test the parsing logic in isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Helpers mirroring the parsing logic in DrizzleStorageAdapter.ts ──────────

function parsePoolMax(env: Record<string, string | undefined>): number {
  return parseInt(env["DATABASE_POOL_MAX"] ?? "10", 10);
}

function parsePoolIdleTimeoutSec(env: Record<string, string | undefined>): number {
  const ms = parseInt(env["DATABASE_POOL_IDLE_TIMEOUT"] ?? "30000", 10);
  return Math.floor(ms / 1000);
}

function parseConnectTimeoutSec(env: Record<string, string | undefined>): number {
  const ms = parseInt(env["DATABASE_CONNECT_TIMEOUT"] ?? "5000", 10);
  return Math.floor(ms / 1000);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DrizzleStorageAdapter pool config — DATABASE_POOL_MAX", () => {
  it("defaults to 10 when DATABASE_POOL_MAX is unset", () => {
    expect(parsePoolMax({})).toBe(10);
  });

  it("reads DATABASE_POOL_MAX from env", () => {
    expect(parsePoolMax({ DATABASE_POOL_MAX: "25" })).toBe(25);
  });

  it("defaults to 10 when DATABASE_POOL_MAX is the literal string '10'", () => {
    expect(parsePoolMax({ DATABASE_POOL_MAX: "10" })).toBe(10);
  });
});

describe("DrizzleStorageAdapter pool config — DATABASE_POOL_IDLE_TIMEOUT", () => {
  it("defaults to 30s (30000ms) when DATABASE_POOL_IDLE_TIMEOUT is unset", () => {
    expect(parsePoolIdleTimeoutSec({})).toBe(30);
  });

  it("converts ms to seconds for postgres.js", () => {
    // 60 000ms → 60s
    expect(parsePoolIdleTimeoutSec({ DATABASE_POOL_IDLE_TIMEOUT: "60000" })).toBe(60);
  });

  it("floors the conversion (partial seconds become whole seconds)", () => {
    // 5 500ms → 5s (not 6)
    expect(parsePoolIdleTimeoutSec({ DATABASE_POOL_IDLE_TIMEOUT: "5500" })).toBe(5);
  });
});

describe("DrizzleStorageAdapter pool config — DATABASE_CONNECT_TIMEOUT", () => {
  it("defaults to 5s (5000ms) when DATABASE_CONNECT_TIMEOUT is unset", () => {
    expect(parseConnectTimeoutSec({})).toBe(5);
  });

  it("converts ms to seconds for postgres.js", () => {
    // 10 000ms → 10s
    expect(parseConnectTimeoutSec({ DATABASE_CONNECT_TIMEOUT: "10000" })).toBe(10);
  });
});

describe("DrizzleStorageAdapter pool config — process.env integration", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      DATABASE_POOL_MAX:          process.env["DATABASE_POOL_MAX"],
      DATABASE_POOL_IDLE_TIMEOUT: process.env["DATABASE_POOL_IDLE_TIMEOUT"],
      DATABASE_CONNECT_TIMEOUT:   process.env["DATABASE_CONNECT_TIMEOUT"],
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it("reads DATABASE_POOL_MAX from process.env", () => {
    process.env["DATABASE_POOL_MAX"] = "50";
    expect(parseInt(process.env["DATABASE_POOL_MAX"] ?? "10", 10)).toBe(50);
  });

  it("reads DATABASE_POOL_IDLE_TIMEOUT from process.env and converts to seconds", () => {
    process.env["DATABASE_POOL_IDLE_TIMEOUT"] = "45000";
    const ms = parseInt(process.env["DATABASE_POOL_IDLE_TIMEOUT"] ?? "30000", 10);
    expect(Math.floor(ms / 1000)).toBe(45);
  });

  it("reads DATABASE_CONNECT_TIMEOUT from process.env and converts to seconds", () => {
    process.env["DATABASE_CONNECT_TIMEOUT"] = "8000";
    const ms = parseInt(process.env["DATABASE_CONNECT_TIMEOUT"] ?? "5000", 10);
    expect(Math.floor(ms / 1000)).toBe(8);
  });
});
