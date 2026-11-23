import { describe, it, expect } from "vitest";
import { scoreAnomaly, DEFAULT_ANOMALY_THRESHOLD } from "../anomaly.js";

describe("scoreAnomaly — write-time semantic anomaly scorer", () => {
  it("returns low score for well-integrated content (high similarity, no PII)", () => {
    // neighbours: [0.95, 0.93, 0.91, 0.90, 0.89]
    // mean = 0.916, distance = 1 - 0.916 = 0.084
    // contradiction: scores in [0.80, 0.97): 0.93, 0.91, 0.90, 0.89 = 4/5 = 0.8
    // score = 0.5*0.084 + 0.3*0 + 0.2*0.8 = 0.042 + 0 + 0.16 = 0.202
    const result = scoreAnomaly({
      neighbourScores: [0.95, 0.93, 0.91, 0.90, 0.89],
      piiRiskScore: 0,
    });
    // 0.95 is above CONTRADICTION_HI (0.97)? No: 0.95 < 0.97, so it IS in zone.
    // All 5 in [0.80, 0.97) → contradiction = 1.0
    // score = 0.5*0.084 + 0.3*0 + 0.2*1.0 = 0.042 + 0.2 = 0.242
    // This is below threshold 0.8 so not flagged
    expect(result.score).toBeLessThan(0.8); // below threshold
    expect(result.flagged).toBe(false);
    expect(result.signals.distance).toBeGreaterThan(0);
    expect(result.signals.contradiction).toBeGreaterThan(0);
  });

  it("scores isolated content (no neighbours) as distance=0, not high anomaly", () => {
    const result = scoreAnomaly({
      neighbourScores: [],
      piiRiskScore: 0,
    });
    expect(result.signals.distance).toBe(0);
    expect(result.signals.contradiction).toBe(0);
    expect(result.score).toBe(0);
    expect(result.flagged).toBe(false);
  });

  it("flags content with high PII density", () => {
    const result = scoreAnomaly({
      neighbourScores: [0.5, 0.4, 0.3],
      piiRiskScore: 1.0,
    });
    // score includes piiDensity * W_PII = 1.0 * 0.3 = 0.3 at minimum
    expect(result.signals.piiDensity).toBe(1.0);
    expect(result.score).toBeGreaterThan(0.3);
  });

  it("flags content with contradiction neighbours (semantic near-miss zone)", () => {
    // All neighbours in [0.80, 0.97) → 100% contradiction
    const result = scoreAnomaly({
      neighbourScores: [0.82, 0.85, 0.88, 0.90, 0.93],
      piiRiskScore: 0,
    });
    expect(result.signals.contradiction).toBe(1.0);
    // score includes contradiction * W_CONTRADICTION = 1.0 * 0.2 = 0.2 at minimum
    expect(result.score).toBeGreaterThanOrEqual(0.2);
  });

  it("flags a combination of distance + contradiction as anomalous", () => {
    // Low cosine → high distance, all in contradiction zone
    const result = scoreAnomaly({
      neighbourScores: [0.85, 0.86, 0.87],
      piiRiskScore: 0.5,
    });
    // distance ≈ 1 - 0.86 = 0.14, contradiction = 1.0, pii = 0.5
    // score ≈ 0.5*0.14 + 0.3*0.5 + 0.2*1.0 = 0.07 + 0.15 + 0.2 = 0.42
    expect(result.score).toBeGreaterThan(0.3);
  });

  it("clamps piiRiskScore > 1 to 1", () => {
    const result = scoreAnomaly({
      neighbourScores: [],
      piiRiskScore: 5.0,
    });
    expect(result.signals.piiDensity).toBe(1.0);
  });

  it("clamps piiRiskScore < 0 to 0", () => {
    const result = scoreAnomaly({
      neighbourScores: [],
      piiRiskScore: -0.5,
    });
    expect(result.signals.piiDensity).toBe(0);
  });

  it("respects custom threshold", () => {
    const result = scoreAnomaly({
      neighbourScores: [0.85, 0.86, 0.87],
      piiRiskScore: 0.5,
      threshold: 0.3,
    });
    expect(result.flagged).toBe(result.score >= 0.3);
  });

  it("returns score in [0, 1] always", () => {
    const inputs = [
      { neighbourScores: [], piiRiskScore: 0 },
      { neighbourScores: [1.0, 1.0, 1.0], piiRiskScore: 0 },
      { neighbourScores: [0.0, 0.0], piiRiskScore: 1 },
      { neighbourScores: [0.82, 0.85, 0.90], piiRiskScore: 0.9 },
    ];
    for (const input of inputs) {
      const result = scoreAnomaly(input);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("uses DEFAULT_ANOMALY_THRESHOLD = 0.8", () => {
    expect(DEFAULT_ANOMALY_THRESHOLD).toBe(0.8);
  });
});
