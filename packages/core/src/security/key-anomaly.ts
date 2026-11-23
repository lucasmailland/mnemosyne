// Pure API-key anomaly detection over markUsed history (SECURITY.md §2.2
// "Anomaly detection: unusual IP ...").  No infra deps — the caller injects
// the usage history and a geo lookup, so this is fully unit-testable.

import type { KeyUsageEvent } from "@mnemo-ai/types";

export interface AnomalyInput {
  currentIp: string;
  now: Date;
  /** Newest-first usage history (excluding the current request). */
  history: KeyUsageEvent[];
  /** Coarse IP→coordinates; return null if unknown (skips velocity check). */
  geoLookup: (ip: string) => { lat: number; lon: number } | null;
  /** Max plausible travel speed; jumps above this are flagged. */
  maxKmPerHour: number;
}

export type AnomalyReason = "new_ip" | "geo_velocity";

export interface AnomalyResult {
  anomalous: boolean;
  reason?: AnomalyReason;
}

const EARTH_KM = 6371;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function detectKeyAnomaly(input: AnomalyInput): AnomalyResult {
  const { currentIp, now, history, geoLookup, maxKmPerHour } = input;
  if (history.length === 0) return { anomalous: false };

  // 1. New-IP: current IP unseen in history.
  const seen = new Set(history.map((h) => h.ipAddress));
  if (!seen.has(currentIp)) return { anomalous: true, reason: "new_ip" };

  // 2. Geo-velocity: check the most recent event from a *different* IP.
  //    This detects impossible jumps: if the key was just used from IP A
  //    and now appears from IP B, the travel speed must be plausible.
  const here = geoLookup(currentIp);
  if (here) {
    for (const event of history) {
      if (event.ipAddress !== currentIp) {
        const there = geoLookup(event.ipAddress);
        if (there) {
          const km = haversineKm(here, there);
          const hours = Math.max((now.getTime() - event.at.getTime()) / 3_600_000, 1 / 3600);
          if (km / hours > maxKmPerHour) return { anomalous: true, reason: "geo_velocity" };
          break; // Only check the most recent different-IP event.
        }
      }
    }
  }

  return { anomalous: false };
}
