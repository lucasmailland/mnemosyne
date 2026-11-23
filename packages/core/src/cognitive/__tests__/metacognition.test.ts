import { describe, it, expect } from "vitest";
import { buildSelfModel } from "../metacognition.js";
import type { StorageAdapter, ConfidenceMapRow, KnowledgeGapRow } from "@mnemo-ai/types";

type MetacognitionStorage = Pick<
  StorageAdapter,
  "getConfidenceMap" | "getKnowledgeGaps" | "getMetacognitionTrends"
>;

const zeroTrends = () => {
  const z = { current: 0, previous: 0, delta: 0 };
  return { recallHitRate: z, avgRecallLatency: z, sessionCollapseQuality: z, strategySuccessRate: z };
};

const makeStorage = (
  confidenceRows: ConfidenceMapRow[] = [],
  gapRows: KnowledgeGapRow[] = [],
): MetacognitionStorage => ({
  getConfidenceMap: async () => confidenceRows,
  getKnowledgeGaps: async () => gapRows,
  getMetacognitionTrends: async () => zeroTrends(),
});

// Entity-keyed (spec §31): topicKey aliases canonicalName, memoryCount aliases factCount.
const makeConfidence = (overrides: Partial<ConfidenceMapRow> & { topicKey: string }): ConfidenceMapRow => ({
  workspaceId: "ws-1",
  entityId: overrides.entityId ?? overrides.topicKey,
  canonicalName: overrides.canonicalName ?? overrides.topicKey,
  kind: overrides.kind ?? "concept",
  factCount: overrides.factCount ?? overrides.memoryCount ?? 5,
  avgConfidence: overrides.avgConfidence ?? 0.8,
  coverageLevel: overrides.coverageLevel ?? "familiar",
  freshness: overrides.freshness ?? "current",
  topicKey: overrides.topicKey,
  memoryCount: overrides.memoryCount ?? 5,
  avgWorth: overrides.avgWorth ?? 0.8,
  evidenceVolume: overrides.evidenceVolume ?? 10,
  distinctAttributions: overrides.distinctAttributions ?? 2,
  pinnedCount: overrides.pinnedCount ?? 0,
  lowStrengthCount: overrides.lowStrengthCount ?? 0,
  lastUpdatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
});

describe("buildSelfModel", () => {
  it("returns empty model with no data", async () => {
    const model = await buildSelfModel(makeStorage(), "ws-1");
    expect(model.strongTopics).toEqual([]);
    expect(model.gaps).toEqual([]);
    expect(model.summary.totalTopics).toBe(0);
    expect(model.summary.avgWorthAcrossWorkspace).toBe(0);
  });

  it("strong topics filter by worth+evidence+memory threshold", async () => {
    const storage = makeStorage([
      // qualifies: high worth, sufficient evidence and memory count
      makeConfidence({ topicKey: "auth", memoryCount: 10, avgWorth: 0.9, evidenceVolume: 20 }),
      // disqualified: memory_count < 3
      makeConfidence({ topicKey: "billing", memoryCount: 2, avgWorth: 0.95, evidenceVolume: 10 }),
      // disqualified: avgWorth < 0.7
      makeConfidence({ topicKey: "infra", memoryCount: 10, avgWorth: 0.5, evidenceVolume: 20 }),
      // disqualified: evidenceVolume < 5
      makeConfidence({ topicKey: "logging", memoryCount: 5, avgWorth: 0.9, evidenceVolume: 3 }),
    ]);
    const model = await buildSelfModel(storage, "ws-1");
    expect(model.strongTopics.map((s) => s.topicKey)).toEqual(["auth"]);
  });

  it("entity filter scopes topics", async () => {
    const storage = makeStorage([
      makeConfidence({ topicKey: "auth", memoryCount: 10, avgWorth: 0.9, evidenceVolume: 20 }),
      makeConfidence({ topicKey: "billing", memoryCount: 10, avgWorth: 0.9, evidenceVolume: 20 }),
    ]);
    const model = await buildSelfModel(storage, "ws-1", { entity: "auth" });
    expect(model.summary.totalTopics).toBe(1);
    expect(model.strongTopics[0]?.topicKey).toBe("auth");
  });

  it("aspect=gaps skips strongTopics computation", async () => {
    const storage = makeStorage([
      makeConfidence({ topicKey: "auth", memoryCount: 10, avgWorth: 0.9, evidenceVolume: 20 }),
    ]);
    const model = await buildSelfModel(storage, "ws-1", { aspect: "gaps" });
    expect(model.strongTopics).toEqual([]);
    expect(model.summary.strongTopicsCount).toBe(0);
  });

  it("computes weighted avgWorthAcrossWorkspace", async () => {
    const storage = makeStorage([
      makeConfidence({ topicKey: "a", memoryCount: 10, avgWorth: 1.0, evidenceVolume: 10 }),
      makeConfidence({ topicKey: "b", memoryCount: 10, avgWorth: 0.0, evidenceVolume: 10 }),
    ]);
    const model = await buildSelfModel(storage, "ws-1");
    expect(model.summary.avgWorthAcrossWorkspace).toBeCloseTo(0.5, 4);
  });

  it("includes gaps in the output", async () => {
    const storage = makeStorage(
      [],
      [
        {
          workspaceId: "ws-1", topicKey: "tricky", avgWorth: 0.3,
          evidenceVolume: 5, memoryCount: 8, recallHits30d: 10, gapScore: 0.7,
        },
      ],
    );
    const model = await buildSelfModel(storage, "ws-1");
    expect(model.gaps).toHaveLength(1);
    expect(model.gaps[0]?.topicKey).toBe("tricky");
    expect(model.summary.gapsCount).toBe(1);
  });

  it("sets generatedAt as ISO datetime string", async () => {
    const model = await buildSelfModel(makeStorage(), "ws-1");
    expect(model.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
