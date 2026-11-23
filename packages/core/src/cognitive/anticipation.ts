// packages/core/src/v3/anticipation.ts
// §8 Anticipation Engine — pure adapter reads, no LLM, no vector index.
// HEXAGONAL PURITY: No infrastructure packages allowed here (db, cache, queue).
//
// Periodic detection uses UTC for dow/hourBucket — document this so callers
// with non-UTC clocks don't get surprised by mismatched slot keys.
//
// Wave O2: 4-way blend — sequential (.35) + periodic (.25) + conditional (.25)
// + co-occurrence (.15). Weights chosen per spec §30 to sum to 1.0 when all
// four signals are at max confidence.
import type { StorageAdapter } from "@mnemo-ai/types";

// Narrow storage slice — only the four pattern readers.
type AnticipationStorage = Pick<
  StorageAdapter,
  "getSequentialPatterns" | "getPeriodicPatterns" | "getConditionalPatterns" | "getCoOccurrencePatterns"
>;

export interface AnticipatedMemory {
  id: string;
  score: number;
  source: "sequential" | "periodic" | "conditional" | "co-occurrence" | "blended";
  rationale: string;
}

export interface AnticipationFeed {
  workspaceId: string;
  generatedAt: string;
  cue: { recentlyRecalledId: string } | null;
  items: AnticipatedMemory[];
}

// Blend weights — spec §30
const BLEND_SEQUENTIAL_WEIGHT   = 0.35;
const BLEND_PERIODIC_WEIGHT     = 0.25;
const BLEND_CONDITIONAL_WEIGHT  = 0.25;
const BLEND_COOCCURRENCE_WEIGHT = 0.15;
const TOP_SEQUENTIAL   = 10;
const TOP_PERIODIC     = 10;
const TOP_CONDITIONAL  = 10;
const TOP_COOCCURRENCE = 10;
/** co_recall_count is unbounded; squash to [0,1] by /10 (10+ co-recalls = full signal). */
const COOCCURRENCE_SATURATION = 10;

export async function buildAnticipationFeed(
  storage: AnticipationStorage,
  workspaceId: string,
  opts?: {
    recentlyRecalledId?: string;
    queryContext?: string;
    nowMs?: number;
    limit?: number;
    /** §30: minutes to anticipate ahead — shifts the periodic slot into the
     *  future window the caller is heading into (default 0 = current slot). */
    lookAheadMinutes?: number;
  },
): Promise<AnticipationFeed> {
  const nowMs = opts?.nowMs ?? Date.now();
  const limit = Math.min(opts?.limit ?? 20, 100);
  const byId = new Map<string, AnticipatedMemory>();

  const merge = (id: string, weighted: number, source: AnticipatedMemory["source"], rationale: string) => {
    const existing = byId.get(id);
    if (existing) {
      existing.score += weighted;
      existing.source = "blended";
      existing.rationale = `${existing.rationale} Also: ${rationale}`;
    } else {
      byId.set(id, { id, score: weighted, source, rationale });
    }
  };

  // 1. Sequential (needs a cue)
  if (opts?.recentlyRecalledId) {
    const seq = await storage.getSequentialPatterns({
      workspaceId,
      predecessorId: opts.recentlyRecalledId,
      minConfidence: 0.3,
      limit: TOP_SEQUENTIAL,
    });
    for (const s of seq) {
      merge(
        s.successorId,
        s.confidence * BLEND_SEQUENTIAL_WEIGHT,
        "sequential",
        `Follows ${opts.recentlyRecalledId} ${Math.round(s.confidence * 100)}% of the time (avg lag ${s.avgLagSeconds}s).`,
      );
    }
  }

  // 2. Periodic (UTC dow + hour_bucket of the anticipated slot)
  // §30 lookAhead: predict the slot the caller is heading INTO (now + lookAhead
  // minutes), not the current one — e.g. lookAhead=30 anticipates the next slot.
  // ALL periodic slots use UTC — callers with non-UTC clocks see mismatched
  // slots intentionally; the SQL MV also uses AT TIME ZONE 'UTC'.
  const slotMs = nowMs + (opts?.lookAheadMinutes ?? 0) * 60_000;
  const now = new Date(slotMs);
  const periodic = await storage.getPeriodicPatterns({
    workspaceId, dayOfWeek: now.getUTCDay(), hourBucket: Math.floor(now.getUTCHours() / 3), limit: TOP_PERIODIC,
  });
  for (const p of periodic) {
    merge(
      p.memoryId,
      p.slotShare * BLEND_PERIODIC_WEIGHT,
      "periodic",
      `Recalled ${Math.round(p.slotShare * 100)}% of the time in this dow/hour slot over ${p.distinctWeeks} weeks (UTC).`,
    );
  }

  // 3. Conditional (needs a query context)
  if (opts?.queryContext) {
    const cond = await storage.getConditionalPatterns({
      workspaceId, queryKey: opts.queryContext, minConfidence: 0.5, limit: TOP_CONDITIONAL,
    });
    for (const c of cond) {
      merge(
        c.factId,
        c.confidence * BLEND_CONDITIONAL_WEIGHT,
        "conditional",
        `When the query mentions "${c.queryKey}", this is recalled ${Math.round(c.confidence * 100)}% of the time.`,
      );
    }
  }

  // 4. Co-occurrence / Hebbian (needs a cue)
  if (opts?.recentlyRecalledId) {
    const co = await storage.getCoOccurrencePatterns({
      workspaceId, sourceId: opts.recentlyRecalledId, minCoRecall: 2, limit: TOP_COOCCURRENCE,
    });
    for (const c of co) {
      const norm = Math.min(1, c.coRecallCount / COOCCURRENCE_SATURATION);
      merge(
        c.partnerId,
        norm * BLEND_COOCCURRENCE_WEIGHT,
        "co-occurrence",
        `Co-recalled with ${opts.recentlyRecalledId} ${c.coRecallCount} times (Hebbian weight ${c.hebbianWeight.toFixed(2)}).`,
      );
    }
  }

  const items = Array.from(byId.values()).sort((a, b) => b.score - a.score).slice(0, limit);
  return {
    workspaceId,
    generatedAt: new Date(nowMs).toISOString(),
    cue: opts?.recentlyRecalledId ? { recentlyRecalledId: opts.recentlyRecalledId } : null,
    items,
  };
}
