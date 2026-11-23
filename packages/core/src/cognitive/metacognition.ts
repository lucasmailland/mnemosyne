/**
 * §31 Meta-Cognition — buildSelfModel
 * HEXAGONAL PURITY: no infrastructure imports allowed.
 */
import type { KnowledgeGapRow, MetacognitionTrends, StorageAdapter } from "@mnemo-ai/types";

type MetacognitionStorage = Pick<
  StorageAdapter,
  "getConfidenceMap" | "getKnowledgeGaps" | "getMetacognitionTrends"
>;

export type SuggestedAction = "ask_user" | "search_codebase" | "wait_for_data";

export interface SelfModel {
  workspaceId: string;
  generatedAt: string;
  confidenceMap: Array<{
    entity: string;
    coverage: "expert" | "familiar" | "aware" | "minimal" | "blind";
    freshness: "current" | "recent" | "aging" | "stale";
    factCount: number;
    avgWorth: number;
  }>;
  strongTopics: Array<{ topicKey: string; memoryCount: number; avgWorth: number; evidenceVolume: number }>;
  strengths: Array<{ topic: string; avgWorth: number; factCount: number }>;
  gaps: Array<{
    topicKey: string;
    gapScore: number;
    recallHits30d: number;
    avgWorth: number;
    memoryCount: number;
    suggestedAction: SuggestedAction;
  }>;
  trends?: MetacognitionTrends;
  summary: {
    totalTopics: number;
    strongTopicsCount: number;
    gapsCount: number;
    blindCount: number;
    avgWorthAcrossWorkspace: number;
  };
}

const STRONG_WORTH_THRESHOLD = 0.7;
const STRONG_EVIDENCE_MIN = 5;
const STRONG_MEMORY_MIN = 3;

function recommendAction(recallAttempts: number, avgWorth: number): SuggestedAction {
  if (recallAttempts >= 5 && avgWorth < 0.2) return "search_codebase";
  if (recallAttempts < 5) return "wait_for_data";
  return "ask_user";
}

export async function buildSelfModel(
  storage: MetacognitionStorage,
  workspaceId: string,
  opts?: {
    topicLimit?: number;
    gapLimit?: number;
    gapMinScore?: number;
    aspect?: "coverage" | "trends" | "gaps" | "strengths" | "all";
    entity?: string;
  },
): Promise<SelfModel> {
  const aspect = opts?.aspect ?? "all";
  const wantCoverage = aspect === "all" || aspect === "coverage";
  const wantStrong = aspect === "all" || aspect === "coverage" || aspect === "strengths";
  const wantGaps = aspect === "all" || aspect === "gaps";
  const wantTrends = aspect === "all" || aspect === "trends";

  const entityFilter = (name: string): boolean =>
    !opts?.entity || name.toLowerCase().includes(opts.entity.toLowerCase());

  const [confidenceRaw, gapsRaw, trends] = await Promise.all([
    storage.getConfidenceMap(workspaceId, { limit: opts?.topicLimit ?? 500 }),
    wantGaps
      ? storage.getKnowledgeGaps(workspaceId, { limit: opts?.gapLimit ?? 50, minScore: opts?.gapMinScore ?? 0 })
      : Promise.resolve<KnowledgeGapRow[]>([]),
    wantTrends ? storage.getMetacognitionTrends(workspaceId) : Promise.resolve(undefined),
  ]);

  const confidence = confidenceRaw.filter((c) => entityFilter(c.canonicalName));
  const gaps = gapsRaw.filter((g) => entityFilter(g.topicKey));

  const confidenceMap = !wantCoverage
    ? []
    : confidence.map((c) => ({
        entity: c.canonicalName,
        coverage: c.coverageLevel,
        freshness: c.freshness,
        factCount: c.factCount,
        avgWorth: c.avgWorth,
      }));

  const strongRows = confidence.filter(
    (c) =>
      c.avgWorth >= STRONG_WORTH_THRESHOLD &&
      c.evidenceVolume >= STRONG_EVIDENCE_MIN &&
      c.factCount >= STRONG_MEMORY_MIN,
  );
  strongRows.sort((a, b) => b.avgWorth * b.evidenceVolume - a.avgWorth * a.evidenceVolume);

  const strongTopics = !wantStrong
    ? []
    : strongRows.slice(0, 25).map((c) => ({
        topicKey: c.canonicalName,
        memoryCount: c.factCount,
        avgWorth: c.avgWorth,
        evidenceVolume: c.evidenceVolume,
      }));

  const strengths = !wantStrong
    ? []
    : strongRows.slice(0, 25).map((c) => ({ topic: c.canonicalName, avgWorth: c.avgWorth, factCount: c.factCount }));

  const totalFacts = confidence.reduce((acc, c) => acc + c.factCount, 0);
  const avgWorth =
    totalFacts === 0 ? 0 : confidence.reduce((acc, c) => acc + c.avgWorth * c.factCount, 0) / totalFacts;
  const blindCount = confidence.filter((c) => c.coverageLevel === "blind").length;

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    confidenceMap,
    strongTopics,
    strengths,
    gaps: gaps.map((g) => ({
      topicKey: g.topicKey,
      gapScore: g.gapScore,
      recallHits30d: g.recallHits30d,
      avgWorth: g.avgWorth,
      memoryCount: g.memoryCount,
      suggestedAction: recommendAction(g.recallHits30d, g.avgWorth),
    })),
    ...(trends ? { trends } : {}),
    summary: {
      totalTopics: confidence.length,
      strongTopicsCount: strongTopics.length,
      gapsCount: gaps.length,
      blindCount,
      avgWorthAcrossWorkspace: Number(avgWorth.toFixed(4)),
    },
  };
}
