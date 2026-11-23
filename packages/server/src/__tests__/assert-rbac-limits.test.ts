// packages/server/src/__tests__/assert-rbac-limits.test.ts
import { describe, it, expect } from "vitest";
import { assertRbacLimitsWired } from "../middleware/assertRbacLimits.js";

describe("assertRbacLimitsWired (F11)", () => {
  it("throws in production when rateCounter is missing", () => {
    expect(() =>
      assertRbacLimitsWired(
        { rateCounter: undefined, activeSessions: { countActive: async () => 0 } },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/rate.?counter|incrWithTtl|fail.?open/i);
  });

  it("throws in production when activeSessions is missing", () => {
    expect(() =>
      assertRbacLimitsWired(
        { rateCounter: { incrWithTtl: async () => 1 }, activeSessions: undefined },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/active.?sessions|concurrent|fail.?open/i);
  });

  it("does not throw in production when both deps are wired", () => {
    expect(() =>
      assertRbacLimitsWired(
        {
          rateCounter: { incrWithTtl: async () => 1 },
          activeSessions: { countActive: async () => 0 },
        },
        { NODE_ENV: "production" },
      ),
    ).not.toThrow();
  });

  it("does not throw in dev even when deps are missing (warn-and-degrade)", () => {
    expect(() =>
      assertRbacLimitsWired(
        { rateCounter: undefined, activeSessions: undefined },
        { NODE_ENV: "development" },
      ),
    ).not.toThrow();
  });

  it("honors MNEMO_REQUIRE_RBAC_LIMITS=true outside production", () => {
    expect(() =>
      assertRbacLimitsWired(
        { rateCounter: undefined, activeSessions: undefined },
        { NODE_ENV: "development", MNEMO_REQUIRE_RBAC_LIMITS: "true" },
      ),
    ).toThrow();
  });
});
