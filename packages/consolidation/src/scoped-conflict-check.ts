// auto-trigger-scoped-consolidation: write-time, near-real-time scoped
// semantic conflict check handler (design.md D4/D5/D6).
//
// Triggered by an outbox `queue_job` row appended in `remember.ts` (core)
// whenever a new fact has a write-time neighbour at cosine similarity >= 0.85.
// This handler:
//   1. Resolves an LLM (per-workspace, else global) — no provider → no-op.
//   2. Loads the fact; requires it to still be active (a §33 supersede may
//      have archived it in the meantime).
//   3. Dedupes against any existing `conflicts_with` or `not_conflict`
//      relation for this fact, in EITHER direction, regardless of which path
//      created it — a pair a judge already resolved with keep_both (which
//      turns the relation into `not_conflict`) is never reopened.
//   4. Classifies at most SCOPED_CONFLICT_MAX_PAIRS candidates via
//      classifyFactPair; only CONTRADICTION creates a relation. A failed
//      classification is logged as one and leaves the pair untouched.
//
// Best-effort / advisory (spec Requirement 7): every step is try/catch +
// logged. "Nothing to check" (no LLM, invalid payload, fact gone or sealed)
// returns normally. APP-010: a TRANSIENT failure (a read that failed, a model
// that did not answer, a relation write that failed) rejects once the other
// pairs were judged, so the outbox keeps the entry and retries it — it used to
// be logged and the entry marked done, losing the check. A replay is safe: the
// dedupe set skips every pair already linked.

import type {
  MnemoFact,
  MnemoRelation,
  RelationNodeKind,
  ActorProvenance,
  FactPort,
  RelationPort,
  SensitiveTextPolicy,
} from "@mnemo-ai/types";
import { isSensitiveTier, sensitiveTextMayReachLlm } from "@mnemo-ai/types";
import { classifyFactPair, FactPairClassificationError } from "./SemanticClassifier.js";
import type { ReplayValidatorContext } from "./ReplayValidator.js";
import { loadLinkedFactIds } from "./relation-memo.js";

export const SCOPED_CONFLICT_JOB = "scoped_semantic_conflict_check";
/**
 * Confidential and restricted facts go to the LLM classifier only when
 * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=all or its judge provider is local
 * (stored encrypted, SECURITY.md §7). Unknown or missing tiers count as
 * sensitive: fail closed.
 */
export const isSealedForLlm = (f: MnemoFact): boolean => isSensitiveTier(f.sensitivity);

/** Defensive cap on classifyFactPair calls per job; the producer (remember.ts) is the tuning point. */
export const SCOPED_CONFLICT_MAX_PAIRS = 3;

export interface ScopedConflictJobData {
  factId: string;
  workspaceId: string;
  candidates: Array<{ id: string; score: number }>;
}

/**
 * Narrow structural surface — canonical composition of `@mnemo-ai/types` sub-ports
 * (segregate-storage-ports design D6), not a hand-rolled duplicate. Every real
 * `StorageAdapter` satisfies it by construction. One itemized delta:
 */
export type ScopedConflictStorage = Pick<FactPort, "getFact"> &
  /** zero delta — byte-identical to `RelationPort.getRelations`. Required: the dedupe
   *  set is what stops this handler re-writing an existing `conflicts_with` relation. */
  Pick<RelationPort, "getRelations"> & {
    /**
     * delta 1 — kept local, verbatim, NOT derived from `RelationPort`. Two deliberate
     * constraints canonical `CreateRelationInput` cannot express: the single-verb
     * narrowing (this write-time handler must never write the other 8 verbs) and
     * required provenance (`actorId`/`userId`/`actorType` are optional canonically).
     * Also avoids relying on method-bivariance surviving a mapped type (D6 delta 3).
     * Optional: when absent, CONTRADICTION verdicts are logged only.
     */
    createRelation?(input: {
      workspaceId: string;
      sourceId: string;
      sourceType: RelationNodeKind;
      targetId: string;
      targetType: RelationNodeKind;
      verb: "conflicts_with";
      evidence?: Record<string, unknown>;
      actorId: ActorProvenance["actorId"];
      userId: ActorProvenance["userId"];
      actorType: ActorProvenance["actorType"];
    }): Promise<MnemoRelation>;
  };

export interface ScopedConflictCheckContext {
  storage: ScopedConflictStorage;
  /** WHO this handler is attributed to — forwarded verbatim, never re-derived. */
  actor: ActorProvenance;
  replayValidator?: ReplayValidatorContext;
  getReplayValidator?: (workspaceId: string) => Promise<ReplayValidatorContext | undefined>;
  logger?: { warn(msg: string, ctx?: Record<string, unknown>): void };
  /** MNEMO_SENSITIVE_TEXT_TO_PROVIDERS (SECURITY.md §7). Unset = "embed". */
  sensitiveTextToProviders?: SensitiveTextPolicy;
}

function isValidJobData(data: unknown): data is ScopedConflictJobData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.factId === "string" &&
    typeof d.workspaceId === "string" &&
    Array.isArray(d.candidates) &&
    d.candidates.every(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Record<string, unknown>).id === "string" &&
        typeof (c as Record<string, unknown>).score === "number"
    )
  );
}

/**
 * `getRelations` calls (not per-pair) — one per direction and verb — covering
 * any `conflicts_with` or `not_conflict` relation touching `factId`,
 * regardless of which path (§33 resolver, the scheduler, or this scoped
 * check) created it.
 *
 * CHAOS-11: `not_conflict` is in the set because `memory_judge` keep_both
 * resolves a conflict by turning its relation into `not_conflict`. With only
 * `conflicts_with` here, a replayed job reopened every pair a judge had
 * already settled — the same set the scheduler's deep-mode memo uses.
 */
async function loadDedupeSet(
  storage: ScopedConflictStorage,
  workspaceId: string,
  factId: string
): Promise<Set<string>> {
  return loadLinkedFactIds(storage, workspaceId, factId, ["conflicts_with", "not_conflict"]);
}

/**
 * Build the write-time scoped semantic conflict check job handler.
 *
 * Returns a `(data: unknown) => Promise<void>` suitable for
 * `queue.process(SCOPED_CONFLICT_JOB, handler)`. Every failure is logged;
 * a transient one rejects so the outbox retries the job (APP-010).
 */
export function createScopedConflictCheckHandler(
  ctx: ScopedConflictCheckContext
): (data: unknown) => Promise<void> {
  return async function scopedConflictCheckHandler(data: unknown): Promise<void> {
    if (!isValidJobData(data)) {
      ctx.logger?.warn("scoped_conflict_check.invalid_job_data", { data });
      return;
    }
    const { factId, workspaceId, candidates } = data;

    let llm: ReplayValidatorContext["llm"] | undefined;
    try {
      const perWorkspace = await ctx.getReplayValidator?.(workspaceId);
      llm = perWorkspace?.llm ?? ctx.replayValidator?.llm;
    } catch (err) {
      ctx.logger?.warn("scoped_conflict_check.get_replay_validator_failed", {
        workspaceId,
        factId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (!llm) {
      ctx.logger?.warn("scoped_conflict_check.no_llm_provider", { workspaceId, factId });
      return;
    }

    let fact: MnemoFact | null;
    try {
      fact = await ctx.storage.getFact(factId, workspaceId);
    } catch (err) {
      ctx.logger?.warn("scoped_conflict_check.get_fact_failed", {
        workspaceId,
        factId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!fact || fact.status !== "active") {
      // Missing, or archived by a §33 supersede that raced this job — no-op.
      return;
    }
    // Egress: reads return confidential+ text decrypted, and both statements
    // of a pair go to the LLM provider. That text stays in the process unless
    // the policy or a local judge allows it.
    // A row that could not be opened (`redacted`) carries a placeholder, not
    // its text: never judged.
    const sealed = (f: MnemoFact) =>
      f.redacted !== undefined ||
      (isSealedForLlm(f) && !sensitiveTextMayReachLlm(ctx.sensitiveTextToProviders, llm, "judge"));
    if (sealed(fact)) return;

    let dedupeSet: Set<string>;
    try {
      dedupeSet = await loadDedupeSet(ctx.storage, workspaceId, factId);
    } catch (err) {
      ctx.logger?.warn("scoped_conflict_check.load_dedupe_set_failed", {
        workspaceId,
        factId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const qualifying = candidates
      .filter((c) => c.id !== factId && !dedupeSet.has(c.id))
      .slice(0, SCOPED_CONFLICT_MAX_PAIRS);

    let transientFailures = 0;
    for (const candidate of qualifying) {
      try {
        const candidateFact = await ctx.storage.getFact(candidate.id, workspaceId);
        if (
          !candidateFact ||
          candidateFact.status !== "active" ||
          candidateFact.id === factId ||
          sealed(candidateFact)
        ) {
          continue;
        }

        const cls = await classifyFactPair(llm, fact.statement, candidateFact.statement);
        if (cls.classification !== "CONTRADICTION") continue;

        if (!ctx.storage.createRelation) continue;
        await ctx.storage.createRelation({
          workspaceId,
          sourceId: factId,
          sourceType: "fact",
          targetId: candidate.id,
          targetType: "fact",
          verb: "conflicts_with",
          evidence: {
            detectedBy: "scoped_write_time_check",
            similarity: candidate.score,
          },
          actorId: ctx.actor.actorId,
          userId: ctx.actor.userId,
          actorType: ctx.actor.actorType,
        });
      } catch (err) {
        if (err instanceof FactPairClassificationError) {
          // LIFECYCLE-14 — no verdict, so no relation; say so instead of
          // letting the pair look classified-compatible.
          ctx.logger?.warn("scoped_conflict_check.classification_failed", {
            workspaceId,
            factId,
            candidateId: candidate.id,
            reason: err.reason,
            err: err.message,
          });
          // A model that did not answer may next time; an answer it could not
          // read would be the same answer again (temperature 0).
          if (err.reason === "llm_error") transientFailures++;
          continue;
        }
        ctx.logger?.warn("scoped_conflict_check.candidate_failed", {
          workspaceId,
          factId,
          candidateId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        });
        // One bad candidate must not abort the rest of the job.
        transientFailures++;
      }
    }
    if (transientFailures > 0) {
      throw new Error(
        `scoped_conflict_check: ${transientFailures} pair(s) failed transiently for fact ${factId}; retry the job`
      );
    }
  };
}
