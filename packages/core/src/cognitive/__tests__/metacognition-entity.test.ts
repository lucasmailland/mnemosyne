import { describe, it, expect } from "vitest";
import { buildSelfModel } from "../metacognition.js";
import type { StorageAdapter, ConfidenceMapRow, KnowledgeGapRow, MetacognitionTrends } from "@mnemo-ai/types";

type S = Pick<StorageAdapter, "getConfidenceMap" | "getKnowledgeGaps" | "getMetacognitionTrends">;

function row(over: Partial<ConfidenceMapRow> & { entityId: string; canonicalName: string }): ConfidenceMapRow {
  return {
    workspaceId: "ws-1",
    entityId: over.entityId,
    canonicalName: over.canonicalName,
    topicKey: over.canonicalName,
    kind: over.kind ?? "service",
    factCount: over.factCount ?? 0,
    memoryCount: over.factCount ?? 0,
    avgWorth: over.avgWorth ?? 0,
    avgConfidence: over.avgConfidence ?? 0,
    coverageLevel: over.coverageLevel ?? "blind",
    freshness: over.freshness ?? "stale",
    evidenceVolume: over.evidenceVolume ?? 0,
    distinctAttributions: 0,
    pinnedCount: 0,
    lowStrengthCount: 0,
    lastUpdatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  };
}

const TRENDS: MetacognitionTrends = {
  recallHitRate: { current: 0.8, previous: 0.5, delta: 0.3 },
  avgRecallLatency: { current: 0.4, previous: 0.6, delta: -0.2 },
  sessionCollapseQuality: { current: 0.9, previous: 0.7, delta: 0.2 },
  strategySuccessRate: { current: 0.75, previous: 0.7, delta: 0.05 },
};

function makeStorage(rows: ConfidenceMapRow[], gaps: KnowledgeGapRow[] = [], trends = TRENDS): S {
  return {
    getConfidenceMap: async () => rows,
    getKnowledgeGaps: async () => gaps,
    getMetacognitionTrends: async () => trends,
  };
}

describe("buildSelfModel — entity-keyed confidence map (spec §31)", () => {
  it("surfaces a zero-fact entity as coverage 'blind'", async () => {
    const model = await buildSelfModel(
      makeStorage([row({ entityId: "e1", canonicalName: "infrastructure", coverageLevel: "blind", freshness: "stale" })]),
      "ws-1",
      { aspect: "coverage" },
    );
    const infra = model.confidenceMap.find((c) => c.entity === "infrastructure");
    expect(infra).toBeDefined();
    expect(infra!.coverage).toBe("blind");
    expect(infra!.factCount).toBe(0);
  });

  it("aspect:'trends' returns non-empty current-vs-prior deltas", async () => {
    const model = await buildSelfModel(makeStorage([]), "ws-1", { aspect: "trends" });
    expect(model.trends).toBeDefined();
    expect(model.trends!.recallHitRate.delta).toBeCloseTo(0.3);
  });

  it("aspect:'strengths' returns the strengths array", async () => {
    const model = await buildSelfModel(
      makeStorage([row({ entityId: "e2", canonicalName: "auth", factCount: 10, avgWorth: 0.9, evidenceVolume: 20, coverageLevel: "expert", freshness: "current" })]),
      "ws-1",
      { aspect: "strengths" },
    );
    expect(model.strengths.map((s) => s.topic)).toContain("auth");
  });
});
