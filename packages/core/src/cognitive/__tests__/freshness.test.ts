import { describe, it, expect } from "vitest";
import { hitFreshness, HIT_FRESHNESS_DAYS } from "../freshness.js";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const nowMs = NOW.getTime();
const dayMs = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(nowMs - days * dayMs);
}

describe("hitFreshness() — boundary thresholds", () => {
  it("just under 7 days → current", () => {
    expect(hitFreshness(daysAgo(HIT_FRESHNESS_DAYS.current - 0.001), NOW)).toBe("current");
  });

  it("exactly 7 days → recent (strict < boundary)", () => {
    expect(hitFreshness(daysAgo(HIT_FRESHNESS_DAYS.current), NOW)).toBe("recent");
  });

  it("just under 30 days → recent", () => {
    expect(hitFreshness(daysAgo(HIT_FRESHNESS_DAYS.recent - 0.001), NOW)).toBe("recent");
  });

  it("exactly 30 days → aging (strict < boundary)", () => {
    expect(hitFreshness(daysAgo(HIT_FRESHNESS_DAYS.recent), NOW)).toBe("aging");
  });

  it("just under 90 days → aging", () => {
    expect(hitFreshness(daysAgo(HIT_FRESHNESS_DAYS.aging - 0.001), NOW)).toBe("aging");
  });

  it("exactly 90 days → stale (strict < boundary)", () => {
    expect(hitFreshness(daysAgo(HIT_FRESHNESS_DAYS.aging), NOW)).toBe("stale");
  });

  it("well past 90 days → stale", () => {
    expect(hitFreshness(daysAgo(365), NOW)).toBe("stale");
  });

  it("zero age (validFrom === now) → current", () => {
    expect(hitFreshness(NOW, NOW)).toBe("current");
  });
});

describe("hitFreshness() — edge cases", () => {
  it("future validFrom → current (fail-conservative: freshest possible state)", () => {
    const future = new Date(nowMs + dayMs); // 1 day in the future
    expect(hitFreshness(future, NOW)).toBe("current");
  });

  it("far future validFrom → current", () => {
    const farFuture = new Date(nowMs + 365 * dayMs);
    expect(hitFreshness(farFuture, NOW)).toBe("current");
  });

  it("unparseable validFrom string (NaN age) → stale (fail-conservative)", () => {
    expect(hitFreshness("not-a-date", NOW)).toBe("stale");
  });

  it("accepts an ISO string validFrom equivalently to a Date", () => {
    const iso = daysAgo(1).toISOString();
    expect(hitFreshness(iso, NOW)).toBe("current");
  });

  it("accepts a numeric `now` in addition to a Date `now`", () => {
    expect(hitFreshness(daysAgo(1), nowMs)).toBe("current");
  });

  it("defaults `now` to the current time when omitted", () => {
    // Sanity check only — must not throw and must return a valid bucket.
    const result = hitFreshness(new Date()); // determinism-ok: testing the omitted-`now` default path, only asserts enum membership
    expect(["current", "recent", "aging", "stale"]).toContain(result);
  });
});
