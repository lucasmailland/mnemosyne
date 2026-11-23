import { describe, it, expect } from "vitest";
import { detectKeyAnomaly } from "../key-anomaly.js";
import type { KeyUsageEvent } from "@mnemo-ai/types";

const T0 = new Date("2026-06-16T12:00:00Z");
function ev(ip: string, minsAgo: number): KeyUsageEvent {
  return { ipAddress: ip, at: new Date(T0.getTime() - minsAgo * 60_000) };
}

// Coarse stub geo: maps an IP to a lat/lon for the velocity test.
const geo = (ip: string): { lat: number; lon: number } | null =>
  ({
    "10.0.0.1": { lat: -34.6, lon: -58.4 }, // Buenos Aires
    "10.0.0.2": { lat: 35.7, lon: 139.7 },  // Tokyo
  } as Record<string, { lat: number; lon: number }>)[ip] ?? null;

describe("detectKeyAnomaly", () => {
  it("flags a never-before-seen IP", () => {
    const r = detectKeyAnomaly({
      currentIp: "10.0.0.9",
      now: T0,
      history: [ev("10.0.0.1", 5), ev("10.0.0.1", 60)],
      geoLookup: geo,
      maxKmPerHour: 1000,
    });
    expect(r.anomalous).toBe(true);
    expect(r.reason).toBe("new_ip");
  });

  it("does NOT flag a known IP at plausible velocity", () => {
    const r = detectKeyAnomaly({
      currentIp: "10.0.0.1",
      now: T0,
      history: [ev("10.0.0.1", 5)],
      geoLookup: geo,
      maxKmPerHour: 1000,
    });
    expect(r.anomalous).toBe(false);
  });

  it("flags impossible geo-velocity (BA→Tokyo in 5 min)", () => {
    const r = detectKeyAnomaly({
      currentIp: "10.0.0.2",
      now: T0,
      // 10.0.0.2 IS in history (so not new_ip), but the jump is impossible.
      history: [ev("10.0.0.2", 9999), ev("10.0.0.1", 5)],
      geoLookup: geo,
      maxKmPerHour: 1000,
    });
    expect(r.anomalous).toBe(true);
    expect(r.reason).toBe("geo_velocity");
  });

  it("returns not-anomalous on empty history (first use)", () => {
    const r = detectKeyAnomaly({
      currentIp: "10.0.0.1",
      now: T0,
      history: [],
      geoLookup: geo,
      maxKmPerHour: 1000,
    });
    expect(r.anomalous).toBe(false);
  });
});
