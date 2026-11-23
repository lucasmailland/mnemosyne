// Builds ONE request + all final ordered hits for the observation port; never throws.
import { createHash } from "node:crypto";
import type {
  AuthContext,
  Logger,
  RecallHit,
  RecallObservationContext,
  RecallPort,
} from "@mnemo-ai/types";
import type { RecallQuery, RecallRequestObservation } from "@mnemo-ai/types";

const TD_LAMBDA = 0.7;

export interface FinalizeRecallObservationInput {
  context: RecallObservationContext;
  query: RecallQuery;
  auth: AuthContext;
  /** Final delivered response (post filter/merge/rerank/pagination); omit on error. */
  response?: {
    hits: RecallHit[];
    latencyMs?: number;
    fromHotTier?: boolean;
    /** The response's own verdict (relevance floor), preserved verbatim. */
    nothingRelevant?: boolean;
  };
  error?: unknown;
  tiers?: string[];
  cacheHit?: boolean;
  totalDurationMs?: number;
  phaseDurationsMs?: RecallRequestObservation["phaseDurationsMs"];
}

/** TD(λ) credits: facts only, at their GLOBAL rank in the final array. */
export function factTdCredits(
  hits: ReadonlyArray<Pick<RecallHit, "id" | "primitive">>
): Array<{ factId: string; hitRank: number; tdCredit: number }> {
  return hits.flatMap((h, rank) =>
    h.primitive === "fact" ? [{ factId: h.id, hitRank: rank, tdCredit: TD_LAMBDA ** rank }] : []
  );
}

export async function finalizeRecallObservation(
  deps: {
    storage: Pick<RecallPort, "recordRecallObservation"> &
      Partial<Pick<RecallPort, "recordRecall">>;
    logger: Logger;
  },
  input: FinalizeRecallObservationInput
): Promise<void> {
  const { context, query, auth, response, error } = input;
  const hits = response?.hits ?? [];
  const failed = error !== undefined;
  const filters = { kinds: query.filter?.kinds, filter: query.filter };
  // Synthetic/test traffic is recorded but never earns TD(λ) worth credit.
  // A point-in-time read (asOf) looks at the past; it is not use, so it earns
  // no TD credit and feeds no replay, like synthetic and test traffic.
  const organic =
    context.trafficOrigin !== "synthetic" &&
    context.trafficOrigin !== "test" &&
    query.asOf === undefined;
  const request: RecallRequestObservation = {
    ...context,
    verifiedActor: context.verifiedActor ?? { type: auth.actorType, id: auth.actorId },
    workspaceId: query.workspaceId,
    sessionId: auth.sessionId ?? null,
    ...(auth.sessionId ? {} : { sessionNullReason: "absent" }),
    requestedFilters: filters,
    effectiveFilters: filters,
    tiers: input.tiers ?? [],
    cacheHit: input.cacheHit ?? false,
    resultCount: hits.length,
    nothingRelevant: response?.nothingRelevant ?? hits.length === 0,
    status: failed ? "error" : hits.length === 0 ? "empty" : "ok",
    ...(failed ? { error: error instanceof Error ? error.name : "unknown_error" } : {}),
    queryHash: createHash("sha256").update(query.text).digest("hex"),
    // Raw text only travels to organic fact hit rows (replay / conditional
    // anticipation); a request with none never carries it.
    ...(organic && hits.some((h) => h.primitive === "fact") ? { queryText: query.text } : {}),
    totalDurationMs: input.totalDurationMs ?? response?.latencyMs ?? 0,
    phaseDurationsMs: input.phaseDurationsMs ?? {},
  };
  const observed = hits.map((h, rank) => ({
    workspaceId: query.workspaceId,
    requestId: context.requestId,
    primitiveKind: h.primitive,
    memoryId: h.id,
    rank,
    score: h.score,
    ...(h.similarity !== undefined ? { similarity: h.similarity } : {}),
    ...(organic && h.primitive === "fact" ? { tdCredit: TD_LAMBDA ** rank } : {}),
  }));
  try {
    if (deps.storage.recordRecallObservation) {
      await deps.storage.recordRecallObservation(request, observed);
    } else if (organic && deps.storage.recordRecall) {
      // Adapters without the observation port keep the legacy per-fact log
      // (TD(λ) credit at the global rank), so worth learning never goes dark.
      const record = deps.storage.recordRecall.bind(deps.storage);
      await Promise.allSettled(
        factTdCredits(hits).map((c) =>
          record({
            workspaceId: query.workspaceId,
            factId: c.factId,
            sessionId: auth.sessionId,
            queryText: query.text,
            hitRank: c.hitRank,
            tdCredit: c.tdCredit,
            activationScore: hits[c.hitRank]!.score,
            latencyMs: request.totalDurationMs,
          })
        )
      );
    }
  } catch (err) {
    deps.logger.warn("recall.observation_failed", {
      operation: "recall.observation",
      requestId: context.requestId,
      workspaceId: query.workspaceId,
      error: { type: "observation_failed", message: err instanceof Error ? err.name : "unknown" },
    });
  }
}
