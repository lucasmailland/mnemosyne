// Background consolidation scheduler (TASK-12003, spec §12 Wave K1; B6.35 replay rollback).
//
// Runs on a simple setInterval loop (NOT a full queue system — that's v3.1).
// Each tick, per workspace, in this exact order:
//   1. recoverExpiredConsolidationMerges — restore crashed pending merges first.
//   2. admin-lock check (fail-closed on error).
//   3. resolve ONE complete replay validator for the workspace.
//      throw/undefined → availability='validator_unavailable', skip candidates.
//   4. query low-worth candidates (confidential/restricted excluded up-front).
//   5. gather clusters, run the 6-condition gate.
//   6. for each gate-passing cluster, mergeClusterWithReplay owns the entire
//      durable lifecycle: operation ID, atomic apply, lease heartbeat, awaited
//      replay, finalize/rollback, structured review logging, ownership inspection,
//      and ONE terminal result. Counters are derived once from that terminal.
//
// Replay validation is EVALUATIVE — it performs no durable write. Every durable
// merge/boost/review/rollback decision lives here.
//
// Stop via the returned stop() function before process.exit() for a clean shutdown.

import { randomUUID } from "node:crypto";
import type { MnemoFact, MnemoRelation, RelationNodeKind } from "@mnemo-ai/types";
import type {
  ApplyConsolidationMergeInput,
  ConsolidationMergeSnapshot,
  ReplayFailureReview,
  ActorProvenance,
  ActorRef,
  ActorType,
  ConsolidationPort,
  FactPort,
  RelationPort,
  PaginatedResult,
} from "@mnemo-ai/types";
import { formatActorRef, isSensitiveTier } from "@mnemo-ai/types";
import { runConsolidationGate } from "./ConsolidationGate.js";
import { cosineSimilarity } from "./utils.js";
import { validateMergedFact } from "./ReplayValidator.js";
import type { ReplayValidatorContext, ReplayResult } from "./ReplayValidator.js";
import { classifyFactPair } from "./SemanticClassifier.js";
import { loadLinkedFactIds } from "./relation-memo.js";

// ─── Minimal context interfaces ───────────────────────────────────────────────

/**
 * Minimum storage surface the scheduler needs.
 *
 * Canonical composition of `@mnemo-ai/types` sub-ports (segregate-storage-ports
 * design D6), not a hand-rolled duplicate — every real `StorageAdapter` already
 * satisfies this by construction. The six atomic consolidation operations own
 * every durable merge write; the scheduler never issues per-fact
 * `updateFact`/`updateWorth`. Four itemized deltas from the canonical ports:
 */
export type SchedulerStorage = Omit<ConsolidationPort, "recoverExpiredConsolidationMerges"> &
  /**
   * delta 2 — `recoverExpiredConsolidationMerges` is required on
   * `ConsolidationPort`; relaxed to optional here via `Omit<…> &
   * Partial<Pick<…>>`. Optionality is a documented consumer-side relaxation,
   * not a port-level change: when absent, crash recovery is skipped. Runs
   * BEFORE candidate selection when present.
   */
  Partial<Pick<ConsolidationPort, "recoverExpiredConsolidationMerges">> &
  /**
   * `getRelations` needs no delta — byte-identical signature. Required: an
   * absent optional here would silently disable deep-mode pair-level
   * classification memoization, re-paying full LLM cost on every tick.
   */
  Pick<RelationPort, "getRelations"> & {
    /**
     * delta 1 — canonical-derived: param widened to canonical `FactFilter`
     * (via `Parameters<FactPort["queryFacts"]>[0]`), return narrowed to
     * `Pick<PaginatedResult<MnemoFact>, "items">`. Structurally identical to
     * the old `{ items }` shape, so existing `as Promise<{ items: MnemoFact[]
     * }>` casts in the fixtures still compile.
     */
    queryFacts(
      filter: Parameters<FactPort["queryFacts"]>[0]
    ): Promise<Pick<PaginatedResult<MnemoFact>, "items">>;

    /**
     * delta 3 — kept local, verbatim, NOT derived from `RelationPort`. The
     * 2-verb narrowing (`"conflicts_with" | "not_conflict"`) is a deliberate
     * safety constraint (the scheduler must never write the other 7 relation
     * verbs) and deliberately avoids relying on method-bivariance surviving
     * `Partial<Pick<…>>`. Required to record `conflicts_with` relations when
     * deep-mode classification detects a contradiction, and `not_conflict`
     * relations when it detects a compatible (never-reclassify) pair.
     * Optional: when absent, verdicts are logged only.
     */
    createRelation?(input: {
      workspaceId: string;
      sourceId: string;
      sourceType: RelationNodeKind;
      targetId: string;
      targetType: RelationNodeKind;
      verb: "conflicts_with" | "not_conflict";
      evidence?: Record<string, unknown>;
      actorId: ActorRef;
      userId: string | null;
      actorType: ActorType;
    }): Promise<MnemoRelation>;

    /**
     * delta 4 — kept local. Not declared on `StorageAdapter`/any sub-port at
     * all (confirmed absent from the whole Port Map); `DrizzleStorageAdapter.ts`
     * and `RecallRepository.ts` implement it via duck typing today; adding it
     * to `ConsolidationPort` is filed as a follow-up (design.md Open
     * Questions), out of this change's scope. Admin lock-out for
     * consolidation (spec §12 condition 6). Presence of a row in
     * mnemo_consolidation_lock = locked. Optional: when absent, consolidation
     * proceeds unconditionally.
     */
    isConsolidationLocked?(workspaceId: string): Promise<boolean>;
  };

/**
 * The actor sealed onto every `conflicts_with` relation the boot-time
 * background scheduler writes (no HTTP request context available). Matches
 * the `system:collapse` convention documented in
 * `packages/types/src/provenance.ts`.
 */
export const CONSOLIDATION_SYSTEM_ACTOR: ActorProvenance = {
  actorType: "system",
  actorId: formatActorRef("system", "consolidation"),
  userId: null,
};

/**
 * Application context the scheduler requires.
 *
 * `storage`          — persistence layer (subset of StorageAdapter).
 * `listWorkspaceIds` — IDs of all active workspaces to consolidate.
 * `replayValidator`  — Optional global validator context.
 * `getReplayValidator` — Optional per-workspace resolver. Resolved ONCE per
 *                        workspace tick and reused for classification + replay.
 * `mode`             — "fast" (cosine only) or "deep" (adds LLM classification).
 */
export interface SchedulerContext {
  storage: SchedulerStorage;
  listWorkspaceIds(): Promise<string[]>;
  /**
   * WHO this tick is attributed to. Required — no default, no fallback.
   * Forwarded verbatim into every `conflicts_with` relation the scheduler
   * writes; the scheduler never synthesizes, mutates, or re-derives it.
   */
  actor: ActorProvenance;
  replayValidator?: ReplayValidatorContext;
  getReplayValidator?: (workspaceId: string) => Promise<ReplayValidatorContext | undefined>;
  mode?: "fast" | "deep";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SchedulerHandle {
  /** Stop the scheduler and prevent further ticks. Safe to call multiple times. */
  stop(): void;
}

export interface SchedulerTickResult {
  workspaceCount: number;
  /** Total candidate facts fetched (across all workspaces, after exclusion). */
  candidateCount: number;
  /** Clusters whose merge was retained this tick. */
  mergedPairs: number;
  /** Clusters that were skipped, ineligible, or restored. */
  skippedPairs: number;
  errors: number;
  /**
   * Internal discriminant — never exposed by the HTTP response. `ready` when a
   * complete validator was resolved for every processed workspace;
   * `validator_unavailable` when a workspace's validator could not be built
   * (recovery still ran, no new candidate was merged).
   */
  availability: "ready" | "validator_unavailable";
}

/** One terminal cluster outcome. Counters are derived once from this value. */
export type ClusterMergeResult =
  | "retained"
  | "restored"
  | "already_restored"
  | "ineligible"
  | "replay_failed_restored"
  | "apply_failed"
  | "finalize_failed_retained"
  | "rollback_failed_retained"
  | "ownership_lost_pending"
  | "ownership_lost_unknown";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum candidates to inspect per workspace per tick. */
const CANDIDATE_LIMIT = 20;

/** Facts with worth at or below this threshold are considered for consolidation. */
const WORTH_CANDIDATE_CEILING = 0.4;

/** Lease duration granted to a pending merge and each heartbeat refresh. */
const LEASE_MS = 15 * 60_000;

/** Lease keeper heartbeat interval. */
const HEARTBEAT_MS = 30_000;

// ─── Sensitivity exclusion ──────────────────────────────────────────────────

/**
 * Confidential/restricted facts are excluded from clustering, classification,
 * and replay (B6.35) under every MNEMO_SENSITIVE_TEXT_TO_PROVIDERS value: a
 * merge writes a derived fact, which cannot be sealed (SECURITY.md §7). A
 * missing or unknown tier counts as sensitive, and a row that could not be
 * opened (`redacted`) carries a placeholder, not its text: both stay out.
 */
export function isReplayEligibleSensitivity(fact: MnemoFact): boolean {
  return !isSensitiveTier(fact.sensitivity) && fact.redacted === undefined;
}

// ─── Clustering helpers ───────────────────────────────────────────────────────

/**
 * Greedy clustering: seed = fact with highest hitCount; cluster members are
 * facts with cosine similarity >= 0.85 to the seed. Only clusters with >= 3
 * members are returned (spec §12: no pairwise merges).
 */
function gatherClusters(facts: MnemoFact[]): MnemoFact[][] {
  const COSINE_MIN = 0.85;
  const remaining = [...facts].sort((a, b) => b.hitCount - a.hitCount);
  const clusters: MnemoFact[][] = [];

  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const seedEmb = seed.embedding ? Array.from(seed.embedding) : null;
    const cluster = [seed];

    if (seedEmb) {
      for (let i = remaining.length - 1; i >= 0; i--) {
        const emb = remaining[i]!.embedding ? Array.from(remaining[i]!.embedding!) : null;
        if (emb && cosineSimilarity(seedEmb, emb) >= COSINE_MIN) {
          cluster.push(remaining.splice(i, 1)[0]!);
        }
      }
    }

    if (cluster.length >= 3) clusters.push(cluster);
  }

  return clusters;
}

function gateMembers(cluster: MnemoFact[]) {
  return cluster.map((f) => ({
    id: f.id,
    worth: f.worth,
    worthAlpha: f.worthAlpha ?? 2,
    worthBeta: f.worthBeta ?? 2,
    pinned: f.pinned,
    canonical: f.canonical ?? false,
    contested: (f.metadata as Record<string, unknown>)?.["contested"] === true,
    sensitivity:
      ((f.metadata as Record<string, unknown>)?.["sensitivity"] as string) ??
      (f.sensitivity as string | undefined) ??
      "internal",
    hitCount: f.hitCount,
    lastRecalledAt: f.lastRecalledAt ?? null,
    embedding: f.embedding ? Array.from(f.embedding) : undefined,
  }));
}

// ─── Lease keeper ─────────────────────────────────────────────────────────────

interface LeaseKeeper {
  /** Immediate serialized refresh + ownership check; throws once ownership lost. */
  onProgress(): Promise<void>;
  /** Stop future heartbeats; resolves after any in-flight refresh settles. */
  stop(): Promise<void>;
  /** True once the first refresh conflict/error has been recorded. */
  lost(): boolean;
}

/**
 * A serialized 30-second lease keeper. Each heartbeat extends the lease to
 * now + 15 minutes. Refreshes never overlap (chained). The FIRST conflict/error
 * is recorded and retained; the keeper then stops refreshing. Cleanup happens in
 * the caller's `finally` via `stop()`.
 */
function startLeaseKeeper(
  storage: SchedulerStorage,
  snapshot: ConsolidationMergeSnapshot
): LeaseKeeper {
  let chain: Promise<void> = Promise.resolve();
  let firstConflict = false;
  let firstError = false;

  const refresh = (): Promise<void> => {
    chain = chain.then(async () => {
      if (firstConflict || firstError) return; // first loss is retained — stop trying
      try {
        const outcome = await storage.refreshConsolidationMergeLease({
          snapshot,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        });
        if (outcome === "conflict") firstConflict = true;
      } catch {
        firstError = true;
      }
    });
    return chain;
  };

  const interval = setInterval(() => {
    void refresh();
  }, HEARTBEAT_MS);
  (interval as unknown as { unref?(): void }).unref?.();

  return {
    async onProgress() {
      await refresh();
      if (firstConflict || firstError) {
        throw new Error("consolidation lease lost");
      }
    },
    async stop() {
      clearInterval(interval);
      await chain;
    },
    lost() {
      return firstConflict || firstError;
    },
  };
}

// ─── Cluster merge orchestrator ───────────────────────────────────────────────

/**
 * Own the entire durable lifecycle of one cluster merge:
 * operation ID → atomic apply → lease heartbeat → awaited evaluative replay →
 * finalize/rollback → structured review logging → ownership inspection →
 * ONE terminal result.
 *
 * No transaction is ever held across LLM/recall. Replay boost is applied only
 * inside the atomic finalize (never via a generic worth update).
 */
async function mergeClusterWithReplay(input: {
  storage: SchedulerStorage;
  workspaceId: string;
  survivor: MnemoFact;
  absorbed: MnemoFact[];
  validator: ReplayValidatorContext;
}): Promise<ClusterMergeResult> {
  const { storage, workspaceId, survivor, absorbed, validator } = input;
  const absorbedFactIds = absorbed.map((a) => a.id);
  const operationId = `mcon_${randomUUID()}`;

  // 1. Atomic apply. `null` → cluster no longer eligible. A throw → apply_failed.
  let snapshot: ConsolidationMergeSnapshot | null;
  try {
    snapshot = await storage.applyConsolidationMerge({
      operationId,
      workspaceId,
      survivorId: survivor.id,
      absorbedFactIds,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
    });
  } catch (err) {
    console.warn("[consolidation] apply failed", {
      operationId,
      survivorId: survivor.id,
      workspaceId,
      err,
    });
    return "apply_failed";
  }
  if (!snapshot) return "ineligible";

  // 2. Lease keeper + awaited evaluative replay (outside any DB transaction).
  const keeper = startLeaseKeeper(storage, snapshot);
  let replay: ReplayResult;
  try {
    replay = await validateMergedFact(survivor, validator, absorbedFactIds, {
      onProgress: () => keeper.onProgress(),
    });
  } catch (err) {
    // Evaluative replay never throws for quality reasons; a throw here is an
    // interrupted run (e.g. lease lost via onProgress). Treat as runtime skip.
    console.warn("[consolidation] replay threw (treated as skipped)", {
      operationId,
      workspaceId,
      err,
    });
    replay = { status: "skipped", passCount: 0, failCount: 0, queriesUsed: [] };
  } finally {
    await keeper.stop();
  }

  // 3. Structured review detail logging (operationId + counts + queries).
  console.warn("[consolidation] replay evaluated", {
    operationId,
    workspaceId,
    survivorId: survivor.id,
    absorbedFactIds,
    status: replay.status,
    passCount: replay.passCount,
    failCount: replay.failCount,
    queriesUsed: replay.queriesUsed,
  });

  // 4. Durable settlement.
  if (replay.status === "boosted" || replay.status === "neutral") {
    return finalizeMerge(storage, snapshot, replay.status === "boosted");
  }

  // flagged → validation failure; skipped → runtime execution failure.
  const review: ReplayFailureReview = {
    reason: replay.status === "flagged" ? "replay_validation_failed" : "replay_execution_failed",
    passCount: replay.passCount,
    failCount: replay.failCount,
    queriesUsed: replay.queriesUsed,
  };
  const restoredTerminal: ClusterMergeResult =
    replay.status === "flagged" ? "restored" : "replay_failed_restored";
  return rollbackMerge(storage, snapshot, review, restoredTerminal);
}

async function finalizeMerge(
  storage: SchedulerStorage,
  snapshot: ConsolidationMergeSnapshot,
  applyReplayBoost: boolean
): Promise<ClusterMergeResult> {
  let outcome: "finalized" | "conflict";
  try {
    outcome = await storage.finalizeConsolidationMerge({ snapshot, applyReplayBoost });
  } catch {
    outcome = "conflict";
  }
  if (outcome === "finalized") return "retained";
  return inspectConflict(storage, snapshot, "finalize");
}

async function rollbackMerge(
  storage: SchedulerStorage,
  snapshot: ConsolidationMergeSnapshot,
  review: ReplayFailureReview,
  restoredTerminal: ClusterMergeResult
): Promise<ClusterMergeResult> {
  let outcome: "rolled_back" | "conflict";
  try {
    outcome = await storage.rollbackConsolidationMerge({ snapshot, review });
  } catch {
    outcome = "conflict";
  }
  if (outcome === "rolled_back") return restoredTerminal;
  return inspectConflict(storage, snapshot, "rollback");
}

/**
 * Resolve a finalize/rollback conflict from durable state. Never guesses from an
 * in-memory promise outcome.
 */
async function inspectConflict(
  storage: SchedulerStorage,
  snapshot: ConsolidationMergeSnapshot,
  stage: "finalize" | "rollback"
): Promise<ClusterMergeResult> {
  let state: "pending" | "restored" | "retained" | "divergent";
  try {
    state = await storage.inspectConsolidationMergeState(snapshot);
  } catch {
    return "ownership_lost_unknown";
  }
  switch (state) {
    case "restored":
      return "already_restored";
    case "retained":
      return stage === "finalize" ? "finalize_failed_retained" : "rollback_failed_retained";
    case "pending":
      return "ownership_lost_pending";
    case "divergent":
    default:
      return "ownership_lost_unknown";
  }
}

/** Apply a terminal cluster result to the tick counters exactly once. */
function applyTerminalToCounters(result: SchedulerTickResult, terminal: ClusterMergeResult): void {
  switch (terminal) {
    case "retained":
      result.mergedPairs++;
      break;
    case "restored":
    case "already_restored":
    case "ineligible":
      result.skippedPairs++;
      break;
    case "replay_failed_restored":
    case "apply_failed":
      result.skippedPairs++;
      result.errors++;
      break;
    case "finalize_failed_retained":
    case "rollback_failed_retained":
    case "ownership_lost_pending":
      result.mergedPairs++;
      result.errors++;
      break;
    case "ownership_lost_unknown":
      result.errors++;
      break;
  }
}

// ─── Scheduler tick ───────────────────────────────────────────────────────────

async function runTick(ctx: SchedulerContext, workspaceId?: string): Promise<SchedulerTickResult> {
  const result: SchedulerTickResult = {
    workspaceCount: 0,
    candidateCount: 0,
    mergedPairs: 0,
    skippedPairs: 0,
    errors: 0,
    availability: "ready",
  };

  let workspaceIds: string[];
  try {
    workspaceIds = workspaceId ? [workspaceId] : await ctx.listWorkspaceIds();
    result.workspaceCount = workspaceIds.length;
  } catch (err) {
    console.warn("[consolidation-scheduler] listWorkspaceIds failed", err);
    result.errors++;
    return result;
  }

  for (const wsId of workspaceIds) {
    // 1. Recovery runs FIRST — even when the validator later fails to resolve.
    if (ctx.storage.recoverExpiredConsolidationMerges) {
      try {
        await ctx.storage.recoverExpiredConsolidationMerges({
          workspaceId: wsId,
          expiredBefore: new Date(),
        });
      } catch (err) {
        console.warn("[consolidation-scheduler] recovery failed", { workspaceId: wsId, err });
        result.errors++;
      }
    }

    // 2. Admin lock-out check (fail-closed on error).
    if (ctx.storage.isConsolidationLocked) {
      let locked: boolean;
      try {
        locked = await ctx.storage.isConsolidationLocked(wsId);
      } catch (err) {
        console.warn(
          "[consolidation] isConsolidationLocked DB error — skipping workspace (fail-closed)",
          { workspaceId: wsId, err }
        );
        continue;
      }
      if (locked) {
        console.warn("[consolidation-scheduler] workspace is admin-locked, skipping", {
          workspaceId: wsId,
        });
        continue;
      }
    }

    // 3. Resolve ONE complete validator for the workspace. Reused for every
    //    classification + replay in this workspace tick.
    let validator: ReplayValidatorContext | undefined;
    try {
      validator = ctx.getReplayValidator ? await ctx.getReplayValidator(wsId) : ctx.replayValidator;
    } catch (err) {
      console.warn("[consolidation-scheduler] validator resolution threw", {
        workspaceId: wsId,
        err,
      });
      validator = undefined;
    }
    if (!validator) {
      // Fail-closed: never merge without replay. Recovery already ran.
      result.availability = "validator_unavailable";
      continue;
    }

    // 4. Fetch candidates. Confidential/restricted excluded up-front.
    let candidates: MnemoFact[];
    try {
      const page = await ctx.storage.queryFacts({
        workspaceId: wsId,
        status: "active",
        minConfidence: 0,
        limit: CANDIDATE_LIMIT,
      });
      candidates = page.items
        .filter(isReplayEligibleSensitivity)
        .filter((f) => f.worth <= WORTH_CANDIDATE_CEILING);
      result.candidateCount += candidates.length;
    } catch (err) {
      console.warn("[consolidation-scheduler] queryFacts failed", { workspaceId: wsId, err });
      result.errors++;
      continue;
    }

    if (candidates.length < 3) continue;

    // 5. Gather clusters and run the gate.
    for (const cluster of gatherClusters(candidates)) {
      const gateResult = runConsolidationGate({ members: gateMembers(cluster) });
      if (!gateResult.passed) {
        result.skippedPairs++;
        console.warn("[consolidation-scheduler] gate failed", {
          cluster: cluster.map((f) => f.id),
          workspaceId: wsId,
          failedCondition: gateResult.failedCondition,
          minCosine: gateResult.minCosine,
        });
        continue;
      }

      const survivor = cluster[0]!;
      let absorbed = cluster.slice(1);

      // Deep mode: classify each absorbed fact against the survivor with the
      // SAME resolved validator. Only DUPLICATE-classified facts proceed.
      if (ctx.mode === "deep") {
        // Per-cluster memo load (design.md D2/D3): two getRelations calls (one
        // per direction) across BOTH conflicting verbs, reused for every
        // absorbed fact in this cluster — not re-queried per pair. A failure
        // here skips the WHOLE cluster rather than falling back to classifying
        // anyway (a DB-degraded tick must not re-pay full LLM cost).
        let memoized: Set<string>;
        try {
          memoized = await loadLinkedFactIds(ctx.storage, wsId, survivor.id, [
            "conflicts_with",
            "not_conflict",
          ]);
        } catch (err) {
          console.warn(
            "[consolidation-scheduler] deep-mode relation memo load failed — skipping cluster",
            {
              survivorId: survivor.id,
              workspaceId: wsId,
              err,
            }
          );
          result.skippedPairs++;
          continue;
        }

        const contradictionIds: string[] = [];
        const compatibleIds: string[] = [];
        const classifyFailedIds: string[] = [];
        const memoHitIds: string[] = [];
        for (const a of absorbed) {
          if (memoized.has(a.id)) {
            // Already classified (either verb) on a prior tick — never
            // reclassify, never re-write.
            memoHitIds.push(a.id);
            continue;
          }
          try {
            const cls = await classifyFactPair(validator.llm, survivor.statement, a.statement);
            if (cls.classification === "CONTRADICTION") contradictionIds.push(a.id);
            else if (cls.classification === "COMPATIBLE") compatibleIds.push(a.id);
            // DUPLICATE falls through — merged below.
          } catch (err) {
            // Safe-default skip (spec Requirement 3): a classification
            // failure must NEVER fall through to merge as if DUPLICATE.
            console.warn(
              "[consolidation-scheduler] classifyFactPair error (skipping fact, no merge)",
              {
                survivorId: survivor.id,
                absorbedId: a.id,
                workspaceId: wsId,
                err,
              }
            );
            classifyFailedIds.push(a.id);
          }
        }

        for (const contraId of contradictionIds) {
          console.warn(
            "[consolidation-scheduler] contradiction detected — creating conflicts_with relation",
            {
              sourceId: survivor.id,
              targetId: contraId,
              workspaceId: wsId,
            }
          );
          if (ctx.storage.createRelation) {
            try {
              await ctx.storage.createRelation({
                workspaceId: wsId,
                sourceId: survivor.id,
                sourceType: "fact",
                targetId: contraId,
                targetType: "fact",
                verb: "conflicts_with",
                evidence: { detectedBy: "semantic_classifier", consolidationMode: "deep" },
                actorId: ctx.actor.actorId,
                userId: ctx.actor.userId,
                actorType: ctx.actor.actorType,
              });
            } catch (err) {
              console.warn(
                "[consolidation-scheduler] createRelation failed (contradiction not persisted)",
                {
                  sourceId: survivor.id,
                  targetId: contraId,
                  workspaceId: wsId,
                  err,
                }
              );
            }
          }
        }
        for (const compatId of compatibleIds) {
          console.warn(
            "[consolidation-scheduler] compatible pair detected — creating not_conflict relation",
            {
              sourceId: survivor.id,
              targetId: compatId,
              workspaceId: wsId,
            }
          );
          if (ctx.storage.createRelation) {
            try {
              await ctx.storage.createRelation({
                workspaceId: wsId,
                sourceId: survivor.id,
                sourceType: "fact",
                targetId: compatId,
                targetType: "fact",
                verb: "not_conflict",
                evidence: { detectedBy: "semantic_classifier", consolidationMode: "deep" },
                actorId: ctx.actor.actorId,
                userId: ctx.actor.userId,
                actorType: ctx.actor.actorType,
              });
            } catch (err) {
              console.warn(
                "[consolidation-scheduler] createRelation failed (not_conflict not persisted)",
                {
                  sourceId: survivor.id,
                  targetId: compatId,
                  workspaceId: wsId,
                  err,
                }
              );
            }
          }
        }

        const skipIds = new Set([
          ...contradictionIds,
          ...compatibleIds,
          ...classifyFailedIds,
          ...memoHitIds,
        ]);
        absorbed = absorbed.filter((a) => !skipIds.has(a.id));
        if (absorbed.length === 0) {
          result.skippedPairs++;
          continue;
        }
      }

      // Both fast duplicates and deep-mode duplicate subsets use ONE helper.
      const terminal = await mergeClusterWithReplay({
        storage: ctx.storage,
        workspaceId: wsId,
        survivor,
        absorbed,
        validator,
      });
      applyTerminalToCounters(result, terminal);
      console.warn("[consolidation-scheduler] cluster settled", {
        survivor: survivor.id,
        absorbed: absorbed.map((a) => a.id),
        workspaceId: wsId,
        terminal,
        minCosine: gateResult.minCosine,
      });
    }
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a single consolidation tick for a specific workspace (or all workspaces).
 */
export async function runConsolidationTick(
  ctx: SchedulerContext,
  workspaceId?: string
): Promise<SchedulerTickResult> {
  return runTick(ctx, workspaceId);
}

/**
 * Start the background consolidation scheduler.
 *
 * Single-flight: `running` is set BEFORE `runTick` and cleared only in its
 * `finally`. If a tick is still in flight, the next interval is skipped rather
 * than overlapping writes. `stop()` clears future intervals but does not lie
 * about in-flight work — an active tick still completes and clears `running`.
 */
export function startConsolidationScheduler(
  ctx: SchedulerContext,
  intervalMs = 60_000
): SchedulerHandle {
  let stopped = false;
  let running = false;

  const handle = setInterval(() => {
    if (stopped || running) return;
    running = true;
    const tickStart = Date.now();
    void runTick(ctx)
      .then((result) => {
        console.warn("[consolidation-scheduler] tick complete", {
          ...result,
          elapsedMs: Date.now() - tickStart,
        });
      })
      .catch((err) => {
        console.warn("[consolidation-scheduler] unhandled tick error", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  (handle as unknown as { unref(): void }).unref();

  console.warn("[consolidation-scheduler] started", {
    intervalMs,
    candidateLimit: CANDIDATE_LIMIT,
    worthCeiling: WORTH_CANDIDATE_CEILING,
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
      console.warn("[consolidation-scheduler] stopped");
    },
  };
}
