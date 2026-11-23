// §30 pre-injection: at session start, stage the top-N anticipated memory ids
// into the L0 working-memory buffer so the next recall can short-circuit.
// Pure: storage + working-memory arrive as ports. No infra imports.
import { buildAnticipationFeed, type AnticipatedMemory } from "../cognitive/anticipation.js";
import type { StorageAdapter } from "@mnemo-ai/types";

type AnticipationStorage = Pick<
  StorageAdapter,
  "getSequentialPatterns" | "getPeriodicPatterns" | "getConditionalPatterns" | "getCoOccurrencePatterns"
>;

type WorkingMemoryLike = {
  workSet<T>(ws: string, agent: string, key: string, value: T, ttlSeconds: number): Promise<void>;
};

export const ANTICIPATION_SLOT = "anticipation";

export interface PreinjectArgs {
  storage: AnticipationStorage;
  workingMemory: WorkingMemoryLike;
  workspaceId: string;
  agentId: string;
  recentlyRecalledId?: string;
  queryContext?: string;
  topN?: number;
  minScore?: number;
  lookAheadMinutes?: number;
  nowMs?: number;
}

export async function preinjectAnticipation(args: PreinjectArgs): Promise<AnticipatedMemory[]> {
  const topN = args.topN ?? 3;
  const minScore = args.minScore ?? 0.05;
  const lookAhead = args.lookAheadMinutes ?? 30;

  const feed = await buildAnticipationFeed(args.storage, args.workspaceId, {
    ...(args.recentlyRecalledId ? { recentlyRecalledId: args.recentlyRecalledId } : {}),
    ...(args.queryContext ? { queryContext: args.queryContext } : {}),
    ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
    limit: topN,
  });

  const staged = feed.items.filter((i) => i.score >= minScore).slice(0, topN);
  if (staged.length === 0) return [];

  // F1 Bug A: the CacheAdapter owns serialization (packages/types/src/ports.ts:1548 —
  // "values are JSON-serialized by the adapter"). Pass the OBJECT, not a pre-stringified
  // string, so the slot round-trips as an object (Redis path JSON.stringify/parse once;
  // the in-process WorkingMemory fallback stores the object directly). Double-encoding
  // here made collapse read back a string whose `.items` was undefined → accuracy always 0.
  await args.workingMemory.workSet(
    args.workspaceId,
    args.agentId,
    ANTICIPATION_SLOT,
    { generatedAt: feed.generatedAt, items: staged },
    lookAhead * 60,
  );
  return staged;
}
