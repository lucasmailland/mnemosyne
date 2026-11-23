// TASK-3002: Surprise-gated encoding for all 10 cognitive primitives.
//
// Pipeline:
//   1. Embed content
//   2. Surprise gate: PE = 1 - max(cosine_sim(embedding, top_5_existing))
//   3. PE < threshold → recorded on the row's metadata as `predictionError`.
//      It no longer diverts the write: see the P74 note at the gate itself for
//      why the old "staging queue" branch was silent data loss.
//   4. Map RememberRequest to kind-specific Create*Input
//   5. Write via StorageAdapter (DB defaults initialize worthAlpha=2.0, worthBeta=2.0)
//   6. Append outbox: vector_upsert + cache_bust (transactional outbox — CRIT-05)
//   7. Append audit: action="create"
//   8. Return RememberResponse

import { createHash } from "node:crypto";
import type {
  RememberRequest,
  RememberResponse,
  StoredWriteFacts,
  RememberConflict,
  RememberConflictCandidate,
  AuthContext,
  MnemoFact,
  MnemoDecision,
  MnemoEntity,
  VectorSearchHit,
  ContradictingFact,
  FindContradictingFactsInput,
} from "@mnemo-ai/types";
import {
  PRIMITIVE_SUBTYPES,
  RECALLABLE_KINDS,
  SENSITIVITY_ORDER,
  isSensitiveTier,
  isSpecificFactSubject,
  sensitiveTextMayReachEmbedder,
  sensitiveTextMayReachLlm,
} from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";
import { enqueuePrimitiveIndex } from "./indexing.js";
import { computeDeltaEpisodeLink } from "./delta-episode.js";
import { lshBands } from "./lsh.js";
import { effectiveCeiling } from "./recall-cold.js";
import { addEmbeddingNoise } from "../security/embedding-noise.js";
import { scoreAnomaly } from "../security/anomaly.js";
import { applyIngestSafety, piiMetadata } from "../ingest-safety.js";
// PURE deterministic §33 resolver — drizzle-free (see conflict/decide.ts). Safe
// to import from the port-only core/v3 path.
import { decideAutoResolution, type ConflictFactView } from "../conflict/decide.js";
import { factStatementHash } from "@mnemo-ai/types";
import {
  classifyFactPair,
  FactPairClassificationError,
  type FactPairClassifierLLM,
  type SemanticClass,
} from "./fact-pair-classifier.js";
import { reportLlmUsage } from "./llm-usage.js";

/** New facts carry the neutral Beta-Bernoulli prior (α=β=2 ⇒ worth = 0.5). */
const NEUTRAL_PRIOR_WORTH = 0.5;

/**
 * auto-trigger-scoped-consolidation: minimum cosine similarity for a
 * write-time neighbour to qualify as a candidate for the scoped semantic
 * conflict check. Same value as the scheduler's cluster-membership cosine
 * (single tuning point).
 */
const SCOPED_CONFLICT_SIMILARITY_THRESHOLD = 0.85;
/** Defensive cap on candidates enqueued per outbox job (producer-side). */
const SCOPED_CONFLICT_MAX_NEIGHBOURS = 3;

/**
 * A write `remember()` refuses because it conflicts with a live row it must not
 * overwrite — today, an entity whose name and kind are already taken. The
 * server maps it to 409; it used to surface as a 500.
 */
export class RememberConflictError extends Error {
  readonly code = "remember_conflict";
  /**
   * Sensitivity of the row that owns the key, when it was found. Kept OUT of
   * `details` (which reach the wire): the caller decides from it whether the
   * conflict may be disclosed at all — a row above the requester's read
   * ceiling must answer 404, not 409 with its id.
   */
  existingSensitivity?: string;

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RememberConflictError";
  }
}

/**
 * CHAOS-7 — the unique index a write violated, read off the error chain.
 *
 * The ORM wraps the driver's error ("Failed query: insert into …") and keeps
 * the Postgres error — `code: "23505"`, `constraint_name` — in `cause`. The
 * old checks matched `err.message`, which is the wrapper's, so a race on
 * either index was never recognised and every loser got a 500. Returns `""`
 * for a unique violation that names no index; `undefined` for anything else.
 * The collapse's persist step reads it too (Q-1).
 */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; constraint_name?: unknown; message?: unknown };
    const named =
      typeof e.message === "string"
        ? /duplicate key value violates unique constraint "([^"]+)"/.exec(e.message)?.[1]
        : undefined;
    if (typeof e.constraint_name === "string" && e.code === "23505") return e.constraint_name;
    if (named) return named;
    if (e.code === "23505") return "";
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True for the storage layer's "a live row already owns this key" failures. */
function isStorageConflict(err: unknown): boolean {
  return (
    (err as { code?: unknown } | null)?.code === "conflict" ||
    uniqueViolationConstraint(err) !== undefined
  );
}

/** AGENTSIM-7: how long a decision title derived from its statement may be. */
const DECISION_TITLE_MAX = 120;

/**
 * AGENTSIM-7 — the title of a decision written through `remember()` when the
 * caller gave none: the statement's first sentence, capped at a word boundary.
 * It used to be `subject`, so a decision about payments-api was titled
 * "payments-api" (or "general"), and rendered as that word above its body.
 */
function decisionTitleFrom(content: string): string {
  const firstSentence = (content.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? "").trim();
  const title = firstSentence.length > 0 ? firstSentence : content.trim();
  if (title.length <= DECISION_TITLE_MAX) return title;
  const cut = title.slice(0, DECISION_TITLE_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * WP-7: how many of the closest existing facts a fact write classifies. Each
 * costs one short LLM call, run in parallel; the real contradiction of a
 * statement is almost always among its nearest neighbours.
 */
const CONFLICT_CANDIDATE_LIMIT = 3;
/** WP-7: how long a write waits for those calls before deferring them. */
const CONFLICT_CLASSIFICATION_TIMEOUT_MS = 8_000;
/**
 * WP-7: after the classifier fails (error or timeout), writes skip it for this
 * long and defer to the async scoped check instead — an LLM outage must not
 * turn every write into a wait for the deadline.
 */
const CONFLICT_CLASSIFIER_COOLDOWN_MS = 60_000;
/**
 * WP-7 / LIFECYCLE-11: a DUPLICATE verdict reuses the existing fact only above
 * this cosine — the scheduler's cluster-membership value. Both signals must
 * agree before a write is folded into another fact.
 */
const PARAPHRASE_MIN_SIMILARITY = SCOPED_CONFLICT_SIMILARITY_THRESHOLD;

/** Per-LLM cooldown deadline (epoch ms); keyed by the adapter object. */
const _classifierCooldownUntil = new WeakMap<object, number>();
/** Contexts already told that no LLM is configured for classification. */
const _warnedNoClassifier = new WeakSet<object>();

/**
 * Process-lifetime cache of workspaceIds whose built-in composition rules have
 * been seeded in this server instance. Prevents a DB call on every remember()
 * after the first write for a given workspace. The set is never cleared because
 * mnemo_seed_builtin_rules() is ON CONFLICT DO NOTHING and we only gain by
 * skipping it — we never need to re-seed within a single process lifetime.
 */
const _seededWorkspaces = new Set<string>();

// ─── WP-7: write-time conflict classification ────────────────────────────────
//
// A similar fact is a CANDIDATE, never a conflict. Candidates come from
// findContradictingFacts (cosine ≥ 0.55, or the lexical predicate for rows with
// no usable vector) and every one goes through the fact-pair classifier before
// anything is persisted. Before this, cosine alone was promoted straight into a
// pending `conflicts_with` relation and `judgmentRequired:true`: 42 of 62 writes
// in the agent simulation, 3,037 review items from 641 writes under load, and
// four paraphrases of one claim flagged against each other (AGENTSIM-3,
// CHAOS-11, LIFECYCLE-11). With bge-m3, two sentences about the same project
// clear 0.55 whether they agree or not — similarity measures topic, not
// polarity, and no threshold turns one into the other.
//
// The verdicts:
//   - CONTRADICTION → persisted after the insert (relation + review item) and
//     reported with judgmentRequired:true — the only path that asks for one;
//   - DUPLICATE     → the write may reuse the existing fact (see
//     findReusableDuplicate for the guards);
//   - COMPATIBLE    → nothing;
//   - no verdict    → nothing at write time. No LLM, an error or a timeout
//     never counts as compatible and never as conflicting: the pair is logged
//     and handed to the async scoped check, which resolves the workspace's own
//     LLM and classifies without a caller waiting.

interface ScreenedCandidates {
  /** Confident CONTRADICTION verdicts, in candidate (similarity) order. */
  contradictions: ContradictingFact[];
  /** Confident DUPLICATE verdicts, in candidate (similarity) order. */
  duplicates: ContradictingFact[];
  /** Candidates with no verdict — for the async scoped check. */
  deferred: Array<{ id: string; score: number }>;
  /** Every candidate that DID get a verdict — the async check skips these. */
  classifiedIds: string[];
}

class ClassificationTimeoutError extends Error {
  constructor(ms: number) {
    super(`fact-pair classification timed out after ${ms}ms`);
    this.name = "ClassificationTimeoutError";
  }
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClassificationTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function screenFactCandidates(
  ctx: CoreContext,
  input: {
    workspaceId: string;
    subject: string;
    statement: string;
    embedding: Float32Array | null;
    sensitivity: MnemoFact["sensitivity"];
    context: NonNullable<FindContradictingFactsInput["writeContext"]>;
  },
  auth: AuthContext
): Promise<ScreenedCandidates> {
  const screened: ScreenedCandidates = {
    contradictions: [],
    duplicates: [],
    deferred: [],
    classifiedIds: [],
  };
  // CHAOS-5: a write whose embedding was deferred is not screened. Without its
  // vector the candidate search is lexical only and cannot find a
  // contradiction (P130), so the write-time check is skipped and the response
  // says the embedding was deferred — it is not declared conflict-free.
  if (!input.embedding) return screened;
  // Opt-in (MNEMO_WRITE_CONFLICT_CLASSIFICATION): the screen costs up to
  // CONFLICT_CANDIDATE_LIMIT LLM calls on every fact write. Off, nothing is
  // looked up or deferred — deferring would only move the same calls to the
  // async job; the scoped check still covers the close neighbours.
  if (ctx.config.writeConflictClassification !== true) return screened;
  // Egress: every pair screened here goes to the LLM provider, the incoming
  // statement and the candidate's. Confidential and restricted text is stored
  // encrypted so that it does not leave in the clear; unless
  // MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=all or the judge provider is local, it
  // must not leave through the classifier either: a confidential+ write is not
  // screened and candidates stop at `internal` whatever the caller may read, so
  // contradictions involving confidential+ facts are not detected at write
  // time (SECURITY.md §7).
  const sensitiveToJudge = sensitiveTextMayReachLlm(
    ctx.config.sensitiveTextToProviders,
    ctx.llm,
    "judge"
  );
  if (!sensitiveToJudge && isSensitiveTier(input.sensitivity)) return screened;
  const callerCeiling = effectiveCeiling(auth);
  const candidates = await ctx.storage.findContradictingFacts(input.workspaceId, {
    subject: input.subject,
    statement: input.statement,
    // P130 — the embedding remember() already computed for this very
    // statement. Without it the storage layer falls back to the lexical
    // predicate, which cannot find a contradiction (plainto_tsquery ANDs every
    // term, including the one that differs).
    embedding: Array.from(input.embedding),
    limit: CONFLICT_CANDIDATE_LIMIT,
    // The candidates' text also goes back to this caller (conflicts,
    // paraphrase reuse): never above what it may recall (recall's own rule).
    maxSensitivity:
      sensitiveToJudge || SENSITIVITY_ORDER[callerCeiling] < SENSITIVITY_ORDER.internal
        ? callerCeiling
        : "internal",
    // ...and only from the context this write lives in.
    writeContext: input.context,
  });
  if (candidates.length === 0) return screened;

  const defer = (c: ContradictingFact) =>
    screened.deferred.push({ id: c.id, score: c.similarity ?? 0 });

  const llm = ctx.llm;
  if (!llm) {
    // Configuration, not a failure: say it once, then quietly defer.
    if (!_warnedNoClassifier.has(ctx)) {
      _warnedNoClassifier.add(ctx);
      ctx.logger.warn(
        "remember: no LLM configured — write-time conflict classification is deferred to the scoped check",
        { workspaceId: input.workspaceId }
      );
    }
    candidates.forEach(defer);
    return screened;
  }

  const pausedUntil = _classifierCooldownUntil.get(llm) ?? 0;
  if (Date.now() < pausedUntil) {
    ctx.logger.debug("remember: conflict classifier paused after a failure — candidates deferred", {
      workspaceId: input.workspaceId,
      candidates: candidates.length,
      resumesInMs: pausedUntil - Date.now(),
    });
    candidates.forEach(defer);
    return screened;
  }

  // Usage reporting rides on the call, same as every other completion in core.
  const reportingLlm: FactPairClassifierLLM = {
    generate: async (opts) => {
      const out = await llm.generate(opts);
      reportLlmUsage(
        ctx,
        llm.id,
        out.model,
        out.tokensUsed?.input ?? 0,
        out.tokensUsed?.output ?? 0,
        out.costUSD
      );
      return out;
    },
  };
  const timeoutMs =
    ctx.config.conflictClassificationTimeoutMs ?? CONFLICT_CLASSIFICATION_TIMEOUT_MS;

  const verdicts = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const result = await withDeadline(
          classifyFactPair(reportingLlm, input.statement, candidate.statement),
          timeoutMs
        );
        return { candidate, classification: result.classification as SemanticClass };
      } catch (err) {
        return { candidate, error: err };
      }
    })
  );

  let llmDown = false;
  for (const v of verdicts) {
    if ("classification" in v && v.classification) {
      screened.classifiedIds.push(v.candidate.id);
      if (v.classification === "CONTRADICTION") screened.contradictions.push(v.candidate);
      else if (v.classification === "DUPLICATE") screened.duplicates.push(v.candidate);
      continue;
    }
    const err = (v as { error: unknown }).error;
    const reason =
      err instanceof ClassificationTimeoutError
        ? "timeout"
        : err instanceof FactPairClassificationError
          ? err.reason
          : "llm_error";
    if (reason !== "unrecognised_response") llmDown = true;
    ctx.logger.warn(
      "remember: conflict classification failed — pair deferred to the scoped check",
      {
        workspaceId: input.workspaceId,
        candidateId: v.candidate.id,
        reason,
        err: err instanceof Error ? err.message : String(err),
      }
    );
    defer(v.candidate);
  }

  if (llmDown) {
    _classifierCooldownUntil.set(llm, Date.now() + CONFLICT_CLASSIFIER_COOLDOWN_MS);
    ctx.logger.warn(
      "remember: conflict classifier unavailable — pausing write-time classification",
      {
        workspaceId: input.workspaceId,
        pauseMs: CONFLICT_CLASSIFIER_COOLDOWN_MS,
      }
    );
  }
  return screened;
}

/**
 * LIFECYCLE-11 — the existing fact a confident paraphrase may be folded into,
 * or null.
 *
 * The content-hash check above catches a repeat of the same bytes; this one
 * catches the same claim reworded, which used to be stored again and then
 * flagged as a "conflict" against its twin. Reusing the existing id is what the
 * hash path already does, so the caller gets the same contract for both.
 *
 * Folding a write into another fact hides the new wording, so every signal has
 * to agree. The classifier said DUPLICATE (it is told a duplicate adds no
 * information), the vectors are at least {@link PARAPHRASE_MIN_SIMILARITY}
 * apart, and nothing about the write's identity differs: same scope, scopeRef,
 * owner and sensitivity tier, and the same subject unless the write's subject
 * is the generic default. A write that carries a topicKey never gets here — the
 * caller named the slot it wants.
 */
async function findReusableDuplicate(
  ctx: CoreContext,
  duplicates: ContradictingFact[],
  write: {
    workspaceId: string;
    subject: string;
    scope: MnemoFact["scope"];
    scopeRef?: string;
    scopeOwner: string;
    sensitivity: MnemoFact["sensitivity"];
  }
): Promise<MnemoFact | null> {
  // confidential/restricted rows are stored encrypted, and the candidate and
  // getFact statements are ciphertext: there is no text to compare or to
  // report back, so such a write is never folded.
  if (SENSITIVITY_ORDER[write.sensitivity] >= SENSITIVITY_ORDER.confidential) return null;
  for (const candidate of duplicates) {
    if ((candidate.similarity ?? 0) < PARAPHRASE_MIN_SIMILARITY) continue;
    const prior = await ctx.storage.getFact(candidate.id, write.workspaceId);
    if (!prior || prior.status !== "active" || prior.validTo != null) continue;
    if (prior.scope !== write.scope) continue;
    if ((prior.scopeRef ?? null) !== (write.scopeRef ?? null)) continue;
    if ((prior.scopeOwner ?? `workspace:${write.workspaceId}`) !== write.scopeOwner) continue;
    if (SENSITIVITY_ORDER[prior.sensitivity] !== SENSITIVITY_ORDER[write.sensitivity]) continue;
    if (isSpecificFactSubject(write.subject) && prior.subject !== write.subject) continue;
    return prior;
  }
  return null;
}

/**
 * §33 Distributed Consensus on the PRODUCTION fact-write path.
 *
 * Persists the contradictions the classifier confirmed (screenFactCandidates)
 * for a genuinely new insert, and returns one RememberConflictCandidate per
 * persisted pair. topicKey merges are the explicit idempotency mechanism and
 * skip this.
 *
 * For each pair the PURE deterministic resolver still runs and its verdict
 * (supersede / reject / review) rides on the candidate, the relation evidence
 * and the review item — a recommendation for the judge, never applied here
 * (P108, below).
 *
 * write-time-conflict-surfacing: the pending `conflicts_with` relation is what
 * GET /conflicts → memory_judge resolves. It is written FIRST and the review
 * item second, carrying the relation id: a failed relation write drops the
 * candidate (D2 — never judgmentRequired:true with nothing judgeable) and
 * leaves no review row behind pointing at a conflict that does not exist.
 */
async function resolveFactContradictions(
  ctx: CoreContext,
  fact: {
    id: string;
    attribution: MnemoFact["attribution"];
    validFrom: Date;
  },
  workspaceId: string,
  auth: AuthContext,
  contradictions: ContradictingFact[]
): Promise<RememberConflictCandidate[]> {
  if (contradictions.length === 0) return [];

  const incoming: ConflictFactView = {
    attribution: fact.attribution,
    worth: NEUTRAL_PRIOR_WORTH,
    validFrom: fact.validFrom,
  };

  const candidates: RememberConflictCandidate[] = [];

  for (const existing of contradictions) {
    const decision = decideAutoResolution(
      { attribution: existing.attribution, worth: existing.worth, validFrom: existing.validFrom },
      incoming
    );

    // P108 — the `supersede` verdict USED to archive the existing fact right
    // here. It no longer does, and every verdict takes the review path.
    // decideAutoResolution ranks on trust(attribution), recency and a worth
    // gap: three signals, none of them semantic. Since WP-7 the pair IS a
    // classified contradiction, but which side is right is still the judge's
    // call — `user_stated` (trust 90) beat `inferred` (trust 40) on every
    // ordinary write, so letting the rule act alone archived inferred facts
    // whenever a user said anything near them. The verdict is recorded where
    // a resolver sees it; a wrong archive is invisible until someone looks
    // for a fact that is no longer there.
    if (decision.action === "supersede") {
      ctx.logger.info("remember: §33 supersede verdict — queued, not applied", {
        workspaceId,
        incomingFactId: fact.id,
        dominatedFactId: existing.id,
        reason: decision.reason,
      });
    }

    // Separate transaction from the fact write (GraphRepository.createRelation
    // opens its own tx and sets its own workspace GUC) — failure here MUST NOT
    // fail the already-committed fact write.
    let relationId: string;
    try {
      const rel = await ctx.storage.createRelation({
        workspaceId,
        sourceId: fact.id, // the NEW fact → factA in GET /conflicts
        sourceType: "fact",
        targetId: existing.id, // the EXISTING fact → factB
        targetType: "fact",
        verb: "conflicts_with",
        evidence: {
          detectedBy: "section33_resolver",
          classification: "CONTRADICTION",
          ...(existing.similarity !== undefined ? { similarity: existing.similarity } : {}),
          action: decision.action,
          verdictReason: decision.reason,
        },
        actorId: auth.actorId,
        userId: auth.userId,
        actorType: auth.actorType,
      });
      relationId = rel.id;
    } catch (err) {
      // Untyped catch (D2 / purity guard) — GraphRepository.createRelation has
      // no typed error wrapper, so what propagates is a raw postgres.js /
      // drizzle driver error. Never import a driver error class into core.
      ctx.logger.warn("remember: §33 conflicts_with relation write failed (candidate dropped)", {
        workspaceId,
        factId: fact.id,
        contradictsFactId: existing.id,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    try {
      await ctx.storage.enqueueReviewItem({
        workspaceId,
        primitiveId: fact.id,
        primitiveKind: "fact",
        reason: "contradiction",
        detail: {
          action: decision.action,
          verdictReason: decision.reason,
          contradictsFactId: existing.id,
          classification: "CONTRADICTION",
          relationId,
        },
      });
    } catch (err) {
      // The relation is the judgeable record (GET /conflicts reads it); the
      // review row is its audit trail. Losing the second must not drop the first.
      ctx.logger.warn("remember: §33 review item write failed (relation kept)", {
        workspaceId,
        factId: fact.id,
        relationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    ctx.logger.info("remember: §33 contradiction enqueued for review", {
      workspaceId,
      factId: fact.id,
      contradictsFactId: existing.id,
      relationId,
      action: decision.action,
      reason: decision.reason,
    });

    candidates.push({
      id: existing.id,
      subject: existing.subject,
      statement: existing.statement,
      action: decision.action,
      relationId,
    });
  }

  return candidates;
}

// ─── Surprise gate + anomaly neighbours ──────────────────────────────────────
//
// Wave X: a SINGLE vector search serves both the surprise gate (PE = 1 − maxSim)
// and the anomaly scorer (neighbourScores array). This avoids two round-trips.

interface NeighbourResult {
  pe: number;
  neighbourScores: number[];
  /**
   * auto-trigger-scoped-consolidation (D2): raw hits from the SAME
   * vector.search call above, reused by the scoped conflict check so the
   * handler never issues a second vector.search. Empty when no neighbours.
   */
  neighbours: VectorSearchHit[];
}

async function fetchNeighbours(
  ctx: CoreContext,
  embedding: Float32Array,
  workspaceId: string
): Promise<NeighbourResult> {
  const results = await ctx.vector.search({
    workspaceId,
    vector: embedding,
    limit: 10, // top-10 for anomaly; PE uses max only
    minSimilarity: 0,
  });
  if (results.length === 0) {
    return { pe: 1.0, neighbourScores: [], neighbours: [] }; // completely novel
  }
  const scores = results.map((r) => r.score);
  const maxSim = Math.max(...scores);
  return { pe: 1.0 - maxSim, neighbourScores: scores, neighbours: results };
}

// ─── Kind-specific dispatch ───────────────────────────────────────────────────

/**
 * P122: project a written row into the wire-shaped subset the route reports.
 * One place, so the three fact paths cannot drift from each other.
 */
function toStoredWriteFacts(row: {
  validFrom: Date;
  validTo?: Date | null;
  createdAt: Date;
  pinned: boolean;
  confidence: number;
  sensitivity: string;
}): StoredWriteFacts {
  return {
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    pinned: row.pinned,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
  };
}

async function createPrimitive(
  ctx: CoreContext,
  req: RememberRequest,
  auth: AuthContext,
  // The embedding remember() already computed (host vector or server-side embed).
  // Threaded into createFact so the fact's vector_upsert outbox entry carries the
  // authoritative vector rather than a text-form re-embed (Bug 2 clobber fix).
  // CHAOS-5: `null` when the embedder failed — the row is written without a
  // vector and createFact queues a text-form job the outbox worker embeds.
  storedVector: Float32Array | null
): Promise<{
  id: string;
  kind: RememberRequest["kind"];
  revision?: number;
  conflict?: RememberConflict;
  /**
   * P76: the row came back from a topicKey merge (a bitemporal supersede), not
   * from an INSERT. remember()'s audit step hardcoded `action: "create"`, which
   * for this branch described an operation that did not happen.
   */
  mergedViaTopicKey?: boolean;
  /**
   * P122: the row as written, for the five fields the HTTP route used to
   * fabricate. Populated on every path that produces a fact row — the INSERT,
   * the topicKey merge, and the content-hash dedupe hit — because all three
   * already hold the row and only ever read `.id` off it.
   */
  stored?: StoredWriteFacts;
  /**
   * WP-7: the write reused an existing record — nothing new was inserted.
   * `paraphrase`: a confident paraphrase of a fact, folded into it; carries
   * the statement memory actually holds, which is what the caller is told was
   * stored. `exact_repeat`: a decision or strategy identical to an active one
   * (PRIM-18).
   */
  reused?: { via: "paraphrase"; statement: string } | { via: "exact_repeat" };
  /**
   * WP-7: conflict candidates the write-time classifier could not judge (no
   * LLM, error, timeout) — handed to the async scoped check.
   */
  deferredConflictCandidates?: Array<{ id: string; score: number }>;
  /** WP-7: candidates that got a verdict — the async scoped check skips them. */
  classifiedConflictCandidateIds?: string[];
}> {
  // §7: thread the caller's sensitivity through to createFact (CreateFactInput
  // supports it). Omitted → the DB default ("internal") still applies.
  const {
    workspaceId,
    kind,
    content,
    provenance,
    tags,
    sessionId,
    metadata,
    sensitivity,
    scope,
    scopeRef,
    scopeOwner,
  } = req;
  const subject = req.subject ?? "general";
  // Derive scopeOwner: use explicit value if provided, otherwise default to workspace-level.
  // Auth context carries userId/tenantId when the key has user binding — used to resolve
  // "user" / "tenant" shorthand values.
  const resolvedScopeOwner = scopeOwner ?? `workspace:${workspaceId}`;

  // P76: true only on the topicKey-race branch, where the row that comes back
  // is a merge successor rather than an insert. Declared out here because Step 7
  // (the audit) is shared by every kind and sits outside this switch.
  let mergedViaTopicKeyRace = false;

  switch (kind) {
    case "fact": {
      // Topic-key idempotent upsert (spec §25.4): if a topicKey is provided and
      // an active fact already exists for it, update in place instead of inserting.
      const topicKey = req.topicKey;
      if (topicKey) {
        const existing = await ctx.storage.mergeFactByTopicKey({
          workspaceId,
          topicKey,
          statement: content,
          metadata,
          tags,
          // The update came from this session: the successor belongs to it.
          ...(sessionId ? { sessionId } : {}),
          ...(storedVector
            ? { embedding: Array.from(storedVector), embeddingModel: ctx.embed.model }
            : {}),
        });
        if (existing) {
          await ctx.storage.upsertFactHash({
            workspaceId,
            statementHash: factStatementHash(content, subject),
            factId: existing.id,
          });
          // P76 point 3 — this path wrote NO audit entry at all.
          //
          // The item described it as "the audit records it as create". That was
          // half of it, and the better half: this branch returns before Step 7
          // ever runs, so a topicKey update — the idempotent write path the
          // SKILL.md recommends — left no trace whatsoever. The race branch
          // below does reach Step 7, and there it really did say `create`.
          //
          // `update`, because that is what happened, and because the row this
          // returns is now a SUCCESSOR: mergeFactByTopicKey closes the previous
          // interval and links the two with `supersedes` instead of overwriting
          // in place. `supersededId` is what makes the history walkable from the
          // log alone.
          await ctx.storage.appendAuditEntry({
            workspaceId,
            actorType: auth.actorType,
            actorId: auth.actorId,
            action: "update",
            resourceKind: "fact",
            resourceId: existing.id,
            isTerminal: false,
            detail: { topicKey, revision: existing.revisionCount, via: "topic_key_merge" },
          });
          return {
            id: existing.id,
            kind: "fact",
            revision: existing.revisionCount,
            stored: toStoredWriteFacts(existing),
          };
        }
      }
      // P85.3 / P109 — content-hash idempotency, finally connected.
      //
      // `upsertFactHash` has run on every fact write since the feature landed,
      // and `lookupFactHash` — implemented on all three adapters — had no
      // production caller: the hashes were all there and nothing ever read them
      // back. Meanwhile memory_remember's description promised "Idempotente vía
      // content-hash: re-enviar el mismo statement no duplica", which was simply
      // untrue. The only write-time deduplication the system actually had was
      // the surprise gate, and that deduplicated by discarding the content (P74).
      //
      // Runs only when no `topicKey` was supplied: topicKey is the EXPLICIT
      // idempotency key and is handled above, so it wins.
      //
      // The archived case is why this is a lookup plus a re-read rather than a
      // lookup alone. `archiveFact` does not delete the hash row, so a hash can
      // point at a fact that was later forgotten. Returning that id would hand
      // back an id for something recall can no longer see — a fresh instance of
      // the very shape this codebase keeps getting bitten by. A re-asserted
      // statement after a forget is a NEW assertion: fall through, create, and
      // let upsertFactHash re-point the hash below.
      const dedupHash = factStatementHash(content, subject);
      const priorHash = await ctx.storage.lookupFactHash(workspaceId, dedupHash);
      if (priorHash) {
        const hashed = await ctx.storage.getFact(priorHash.factId, workspaceId);
        // APP-009 — the hash is statement + subject and says nothing about
        // where the fact lives or who may read it. The same sentence under
        // another scopeRef, owner or sensitivity tier is a different fact:
        // folding it here stored nothing for the second scope and handed a
        // writer the id of a row above its own ceiling. The hash table holds
        // one fact per hash, so when the row it points at is someone else's,
        // look for this write's own twin by its full identity instead.
        const writeScope = (scope === "personal" ? "global" : scope) ?? "global";
        const writeTier = sensitivity ?? "internal";
        const sameIdentity = (f: MnemoFact): boolean =>
          f.scope === writeScope &&
          (f.scopeRef ?? null) === (scopeRef ?? null) &&
          (f.scopeOwner ?? `workspace:${workspaceId}`) === resolvedScopeOwner &&
          SENSITIVITY_ORDER[f.sensitivity] === SENSITIVITY_ORDER[writeTier];
        const live = (f: MnemoFact | null | undefined): f is MnemoFact =>
          !!f && f.status === "active" && f.validTo == null;
        let prior: MnemoFact | null = live(hashed) && sameIdentity(hashed) ? hashed : null;
        if (!prior && live(hashed) && ctx.storage.findLiveFactByStatement) {
          const twin = await ctx.storage.findLiveFactByStatement({
            workspaceId,
            scope: writeScope,
            ...(scopeRef ? { scopeRef } : {}),
            subject,
            statement: content,
            scopeOwner: resolvedScopeOwner,
            sensitivity: writeTier,
          });
          prior = live(twin) && sameIdentity(twin) ? twin : null;
        }
        if (prior) {
          // Bumps seenCount/lastSeenAt on the existing row — the hash table has
          // always tracked repetition, and this is the signal reaching it. Note
          // it is deliberately NOT a worth update: worth is a TD(λ) utility
          // measure ("did it help when recalled"), and "someone said it twice"
          // is a different question that must not be mixed into it.
          await ctx.storage.upsertFactHash({
            workspaceId,
            statementHash: dedupHash,
            factId: prior.id,
          });
          return {
            id: prior.id,
            kind: "fact",
            revision: prior.revisionCount,
            stored: toStoredWriteFacts(prior),
          };
        }
      }

      // ── P109: verify a caller-supplied episodeId before it reaches the INSERT ──
      //
      // `mnemo_fact.episode_id` is the CANONICAL origin link and the only one
      // with referential integrity (DATA_MODEL.md §4.9). That FK is exactly why
      // this check exists: an id naming no episode aborts the insert, and the
      // caller loses the write — the P74 failure class, re-imported through a
      // brand-new field.
      //
      // So: verify, and on a miss DROP THE LINK AND KEEP THE FACT. That trade is
      // not symmetric. A missing episode link is recoverable — the collapse's
      // `linkSessionFactsToEpisode` fills it from `sessionId` afterwards — while
      // a rejected write is gone. Loud in the log, never fatal to the content.
      //
      // Rejecting the whole call (400) was the alternative and was dropped for
      // the same reason the sessionId FK was dropped: the id comes from an LLM
      // that may be holding a stale one from an earlier session, and the fact it
      // is trying to save is not the thing that is wrong.
      let resolvedEpisodeId: string | undefined;
      if (req.episodeId) {
        const episode = await ctx.storage.getEpisode(req.episodeId, workspaceId).catch(() => null);
        if (episode) {
          resolvedEpisodeId = req.episodeId;
        } else {
          ctx.logger.warn("remember: episodeId names no episode — writing fact without the link", {
            operation: "remember.episode_link",
            workspaceId,
            episodeId: req.episodeId,
            ...(sessionId ? { sessionId } : {}),
          });
        }
      }

      // ── WP-7: classify the closest existing facts BEFORE writing ──────────
      // One pass serves both outcomes: a confident paraphrase is folded into
      // its twin instead of inserted, and confirmed contradictions are
      // persisted once the new row exists (see screenFactCandidates).
      const screened = await screenFactCandidates(
        ctx,
        {
          workspaceId,
          subject,
          statement: content,
          embedding: storedVector,
          sensitivity: sensitivity ?? "internal",
          context: {
            scope: (scope === "personal" ? "global" : scope) ?? "global",
            ...(scopeRef ? { scopeRef } : {}),
            scopeOwner: resolvedScopeOwner,
          },
        },
        auth
      );
      if (!topicKey && screened.duplicates.length > 0) {
        const twin = await findReusableDuplicate(ctx, screened.duplicates, {
          workspaceId,
          subject,
          scope: (scope === "personal" ? "global" : scope) ?? "global",
          ...(scopeRef ? { scopeRef } : {}),
          scopeOwner: resolvedScopeOwner,
          sensitivity: sensitivity ?? "internal",
        });
        if (twin) {
          // No content-hash alias for this wording. The hash path treats a hit
          // as "the row holds these exact bytes"; an alias pointing at a twin
          // with other wording made a repeat of the paraphrase re-index the
          // twin with the paraphrase's vector and report text the row does not
          // hold. A repeat comes back through this screen instead.
          ctx.logger.info("remember: paraphrase of an existing fact — reusing it", {
            workspaceId,
            factId: twin.id,
          });
          return {
            id: twin.id,
            kind: "fact",
            revision: twin.revisionCount,
            stored: toStoredWriteFacts(twin),
            reused: { via: "paraphrase", statement: twin.statement },
          };
        }
      }

      let factId: string;
      // Non-null only on a genuinely new insert — the topicKey-race update path
      // leaves this null so §33 contradiction resolution is skipped there.
      let createdFact: MnemoFact | null = null;
      try {
        // req.kind is always "fact" here (dispatch already narrowed it) — the real
        // subtype comes from req.subtype (e.g. "preference", "trait"). Bug fix:
        // this used to compare req.kind (always "fact", never in factKinds)
        // against factKinds, so resolvedFactKind was unconditionally "other".
        const resolvedFactKind = (
          PRIMITIVE_SUBTYPES.fact.includes(req.subtype as (typeof PRIMITIVE_SUBTYPES.fact)[number])
            ? req.subtype
            : "other"
        ) as MnemoFact["kind"];
        const fact = await ctx.storage.createFact({
          workspaceId,
          statement: content,
          subject,
          kind: resolvedFactKind,
          scope: (scope === "personal" ? "global" : scope) ?? "global",
          ...(scopeRef ? { scopeRef } : {}),
          scopeOwner: resolvedScopeOwner,
          // agentId is a caller-supplied logical label (never auto-filled from
          // auth — that was polluting it with the same value as actorId).
          agentId: req.agentId,
          actorId: auth.actorId,
          userId: auth.userId,
          actorType: auth.actorType,
          attribution: (provenance ?? "user_stated") as MnemoFact["attribution"],
          sessionId,
          // Verified above; undefined when the caller sent none or sent one that
          // does not resolve.
          ...(resolvedEpisodeId ? { episodeId: resolvedEpisodeId } : {}),
          ...(req.validFrom ? { validFrom: req.validFrom } : {}),
          tags,
          topicKey,
          ...(req.confidence !== undefined ? { confidence: req.confidence } : {}),
          metadata: {
            ...(metadata ?? {}),
            ...(tags ? { tags } : {}),
            ...(req.conversationId ? { conversationId: req.conversationId } : {}),
          },
          // Authoritative embedding → createFact enqueues a vector-form
          // vector_upsert (no statement re-embed that could clobber it).
          // CHAOS-5: without one, createFact queues the text-form job, and
          // `indexLsh` has the worker write the LSH bands once it embeds.
          ...(storedVector
            ? { embedding: Array.from(storedVector), embeddingModel: ctx.embed.model }
            : { vectorJob: { indexLsh: true } }),
          ...(sensitivity ? { sensitivity } : {}),
        });
        factId = fact.id;
        createdFact = fact;
      } catch (err: unknown) {
        const violated = uniqueViolationConstraint(err);
        // CHAOS-7 — an identical concurrent write won `uniq_mnemo_fact_dedup`.
        // Both callers read no hash row (the winner writes it AFTER its insert
        // commits), so the content-hash check above could not catch it, and
        // this caller got a 500 for content that WAS stored. Same answer as a
        // sequential repeat: the winner's id. The write landed.
        if (violated === "uniq_mnemo_fact_dedup" && ctx.storage.findLiveFactByStatement) {
          const winner = await ctx.storage.findLiveFactByStatement({
            workspaceId,
            scope: (scope === "personal" ? "global" : scope) ?? "global",
            ...(scopeRef ? { scopeRef } : {}),
            subject,
            statement: content,
            // APP-009: the index now includes owner and tier; so does this lookup.
            scopeOwner: resolvedScopeOwner,
            sensitivity: sensitivity ?? "internal",
          });
          if (!winner) throw err;
          await ctx.storage.upsertFactHash({
            workspaceId,
            statementHash: dedupHash,
            factId: winner.id,
          });
          return {
            id: winner.id,
            kind: "fact",
            revision: winner.revisionCount,
            stored: toStoredWriteFacts(winner),
          };
        }
        // Concurrent caller raced us: both read nothing, both attempted createFact,
        // the second hit PG unique constraint idx_fact_topic (error 23505).
        // Re-query for the row the winner inserted and update it in place.
        // CHAOS-7: matched on the constraint the driver names
        // (`idx_fact_topic_active_unique`, migration 0007), not on the
        // wrapper's message, which never contained it.
        const isTopicKeyRace =
          topicKey !== undefined &&
          ((violated !== undefined && violated.startsWith("idx_fact_topic")) ||
            violated === "" ||
            (err instanceof Error && err.message.includes("idx_fact_topic")));
        if (!isTopicKeyRace) throw err;

        const winner = await ctx.storage.mergeFactByTopicKey({
          workspaceId,
          topicKey,
          statement: content,
          metadata,
          tags,
          ...(sessionId ? { sessionId } : {}),
        });
        if (!winner) throw err;
        factId = winner.id;
        // P76: the row that comes back is a successor produced by a merge, not
        // an insert. remember()'s audit step hardcoded `create`; this marks the
        // one case where that is false so the action matches the operation.
        mergedViaTopicKeyRace = true;
      }
      await ctx.storage.upsertFactHash({
        workspaceId,
        statementHash: factStatementHash(content, subject),
        factId,
      });
      // §33 — persist the contradictions the classifier confirmed (PROD path).
      // CHAOS-5: it needs this write's vector. Without one it is not run with
      // a fake (empty) vector, and the write is not declared conflict-free —
      // the response says the embedding, and with it this check, was deferred.
      let conflict: RememberConflict | undefined;
      // A classified contradiction is done only once its relation exists. One
      // whose write failed goes back to the scoped check (a durable outbox
      // job) instead of counting as handled.
      let deferred = screened.deferred;
      let classifiedIds = screened.classifiedIds;
      if (createdFact && storedVector) {
        const candidates = await resolveFactContradictions(
          ctx,
          {
            id: createdFact.id,
            attribution: createdFact.attribution,
            validFrom: createdFact.validFrom,
          },
          workspaceId,
          auth,
          screened.contradictions
        );
        const persisted = new Set(candidates.map((c) => c.id));
        const unpersisted = screened.contradictions.filter((c) => !persisted.has(c.id));
        if (unpersisted.length > 0) {
          const retry = new Set(unpersisted.map((c) => c.id));
          deferred = [
            ...deferred,
            ...unpersisted.map((c) => ({ id: c.id, score: c.similarity ?? 0 })),
          ];
          classifiedIds = classifiedIds.filter((id) => !retry.has(id));
        }
        // D3: omit `conflict` entirely when the surviving candidate list is
        // empty (not null, not {}) — keeps no-conflict writes byte-identical.
        if (candidates.length > 0) {
          // P108 — was `candidates.some((c) => c.action !== "supersede")`, on the
          // premise that a supersede had already been applied and so had nothing
          // left to judge. That premise is gone: supersede no longer archives, so
          // every candidate carries an unresolved conflicts_with relation. Left
          // as it was, a supersede-only conflict would report "nothing to judge"
          // while leaving a live conflict behind — the same shape of lie this
          // branch keeps removing. Every surviving candidate is judgeable by
          // construction: the loop drops any whose relation write failed.
          conflict = {
            judgmentRequired: true,
            candidates,
          };
        }
      }
      const committed = createdFact ?? (await ctx.storage.getFact(factId, workspaceId));
      return {
        id: factId,
        kind: "fact",
        revision: committed?.revisionCount ?? 1,
        // P122: `committed` is already resolved above, and until now only its
        // revisionCount was read off it. The row was right there.
        ...(committed ? { stored: toStoredWriteFacts(committed) } : {}),
        ...(conflict ? { conflict } : {}),
        ...(mergedViaTopicKeyRace ? { mergedViaTopicKey: true } : {}),
        // The topicKey-race path wrote no new row of its own: nothing to defer.
        ...(createdFact
          ? {
              deferredConflictCandidates: deferred,
              classifiedConflictCandidateIds: classifiedIds,
            }
          : {}),
      };
    }

    case "decision": {
      // AGENTSIM-7 — the row used to be `title = subject` (a project name, or
      // "general") with `scopeRef` and the session dropped. The title is now the
      // caller's, or the statement's first sentence; `body` keeps the whole
      // statement; `scopeRef` and the session (as `conversationId`) are
      // stored; and `subject`, which a decision has no column for, is kept in
      // metadata instead of being silently discarded.
      const decisionTitle = req.title?.trim() ? req.title.trim() : decisionTitleFrom(content);
      const decisionConversationId = req.conversationId ?? sessionId;
      const decisionMetadata = {
        ...(req.subject ? { subject: req.subject } : {}),
        ...(metadata ?? {}),
      };
      const resolvedDecisionKind = (
        PRIMITIVE_SUBTYPES.decision.includes(
          req.subtype as (typeof PRIMITIVE_SUBTYPES.decision)[number]
        )
          ? req.subtype
          : "decision"
      ) as MnemoDecision["kind"];
      // Topic-key idempotent upsert, mirroring the fact path above: if a
      // topicKey is provided and an active decision already exists for it,
      // update in place instead of inserting (mergeDecisionByTopicKey).
      const decisionTopicKey = req.topicKey;
      if (decisionTopicKey) {
        const existing = await ctx.storage.mergeDecisionByTopicKey({
          workspaceId,
          topicKey: decisionTopicKey,
          title: decisionTitle,
          body: content,
          kind: resolvedDecisionKind,
          metadata: decisionMetadata,
          ...(scopeRef ? { scopeRef } : {}),
          ...(decisionConversationId ? { conversationId: decisionConversationId } : {}),
        });
        if (existing) {
          return { id: existing.id, kind: "decision", revision: existing.revisionCount };
        }
      }
      const decisionInput = {
        workspaceId,
        title: decisionTitle,
        body: content,
        kind: resolvedDecisionKind,
        agentId: req.agentId,
        actorId: auth.actorId,
        userId: auth.userId,
        actorType: auth.actorType,
        scopeOwner: resolvedScopeOwner,
        topicKey: decisionTopicKey,
        ...(scopeRef ? { scopeRef } : {}),
        ...(decisionConversationId ? { conversationId: decisionConversationId } : {}),
        // PRIM-14: never silently store a decision below the tier it was sent with.
        ...(sensitivity ? { sensitivity } : {}),
        metadata: decisionMetadata,
      };
      // PRIM-18 — an exact repeat of an active decision is that decision, the
      // way an exact repeat of a fact already is (content hash, above). The
      // adapter compares the row this input would write (title, body, kind,
      // owner, scopeRef, sensitivity and metadata.subject) and inserts in the
      // same locked transaction, so identical concurrent writes make one row.
      // A write that names a topicKey has named its slot: the merge above
      // found none, so it gets a row of its own under that key.
      if (!decisionTopicKey && ctx.storage.createDecisionUnlessDuplicate) {
        const { decision, reused } = await ctx.storage.createDecisionUnlessDuplicate(decisionInput);
        return {
          id: decision.id,
          kind: "decision",
          revision: decision.revisionCount,
          ...(reused ? { reused: { via: "exact_repeat" as const } } : {}),
        };
      }
      try {
        const decision = await ctx.storage.createDecision(decisionInput);
        return { id: decision.id, kind: "decision", revision: decision.revisionCount };
      } catch (err: unknown) {
        // Concurrent caller raced us: both read nothing, both attempted
        // createDecision, the second hit uniq_mnemo_decision_topic (23505).
        // Re-query for the row the winner inserted and update it in place.
        const violated = uniqueViolationConstraint(err);
        const isTopicKeyRace =
          decisionTopicKey !== undefined &&
          (violated === "uniq_mnemo_decision_topic" ||
            violated === "" ||
            (err instanceof Error &&
              (err.message.includes("uniq_mnemo_decision_topic") ||
                err.message.includes("23505"))));
        if (!isTopicKeyRace) throw err;

        const winner = await ctx.storage.mergeDecisionByTopicKey({
          workspaceId,
          topicKey: decisionTopicKey,
          title: decisionTitle,
          body: content,
          kind: resolvedDecisionKind,
          metadata: decisionMetadata,
          ...(scopeRef ? { scopeRef } : {}),
          ...(decisionConversationId ? { conversationId: decisionConversationId } : {}),
        });
        if (!winner) throw err;
        return { id: winner.id, kind: "decision", revision: winner.revisionCount };
      }
    }

    case "episode": {
      // DELTAMEM §16 — delta-encode against the nearest existing episode when
      // similar (> 0.85), forming delta-trees; otherwise create a root episode.
      const deltaLink = await computeDeltaEpisodeLink(ctx, workspaceId, content);
      const episode = await ctx.storage.createEpisode({
        workspaceId,
        title: subject,
        narrative: content,
        occurredAt: new Date(),
        agentId: req.agentId,
        actorId: auth.actorId,
        userId: auth.userId,
        actorType: auth.actorType,
        scopeOwner: resolvedScopeOwner,
        topics: tags,
        isSynthetic: false,
        metadata: metadata ?? {},
        ...deltaLink,
      });
      return { id: episode.id, kind: "episode" };
    }

    case "entity": {
      const resolvedEntityKind = (
        PRIMITIVE_SUBTYPES.entity.includes(
          req.subtype as (typeof PRIMITIVE_SUBTYPES.entity)[number]
        )
          ? req.subtype
          : "concept"
      ) as MnemoEntity["kind"];
      let entity: MnemoEntity;
      try {
        entity = await ctx.storage.createEntity({
          workspaceId,
          name: subject,
          kind: resolvedEntityKind,
          description: content,
          actorId: auth.actorId,
          agentId: req.agentId,
          userId: auth.userId,
          actorType: auth.actorType,
          scopeOwner: resolvedScopeOwner,
          metadata: metadata ?? {},
        });
      } catch (err) {
        // A live entity already owns this name and kind (the adapter's typed
        // conflict, or the raw unique violation of an adapter without one).
        // Overwriting it would drop its description and links, so the caller
        // gets a 409 that names it — update it through the entity routes.
        if (!isStorageConflict(err)) throw err;
        const existing = await ctx.storage
          .queryEntities({ workspaceId, name: subject, kind: resolvedEntityKind, limit: 5 })
          .then((page) => page.items.find((e) => e.validTo == null) ?? null)
          .catch(() => null);
        const conflict = new RememberConflictError(
          `An entity named '${subject}' of kind '${resolvedEntityKind}' already exists.`,
          {
            kind: "entity",
            name: subject,
            entityKind: resolvedEntityKind,
            ...(existing ? { existingId: existing.id } : {}),
          }
        );
        if (existing) conflict.existingSensitivity = existing.sensitivity;
        throw conflict;
      }
      return { id: entity.id, kind: "entity" };
    }

    case "strategy": {
      const strategyInput = {
        workspaceId,
        trigger: subject,
        action: content,
        agentId: req.agentId,
        actorId: auth.actorId,
        userId: auth.userId,
        actorType: auth.actorType,
        scopeOwner: resolvedScopeOwner,
        metadata: metadata ?? {},
      };
      // PRIM-18 — same rule as decisions: an exact repeat is the same record.
      if (ctx.storage.createStrategyUnlessDuplicate) {
        const { strategy, reused } = await ctx.storage.createStrategyUnlessDuplicate(strategyInput);
        return {
          id: strategy.id,
          kind: "strategy",
          ...(reused ? { reused: { via: "exact_repeat" as const } } : {}),
        };
      }
      const strategy = await ctx.storage.createStrategy(strategyInput);
      return { id: strategy.id, kind: "strategy" };
    }

    case "workflow": {
      const workflow = await ctx.storage.createWorkflow({
        workspaceId,
        name: subject,
        description: content,
        steps: [{ order: 1, action: content, expectedDurationMs: 0 }],
        actorId: auth.actorId,
        agentId: req.agentId,
        userId: auth.userId,
        actorType: auth.actorType,
        scopeOwner: resolvedScopeOwner,
        metadata: metadata ?? {},
      });
      return { id: workflow.id, kind: "workflow" };
    }

    case "skill": {
      const skill = await ctx.storage.createSkill({
        workspaceId,
        name: subject,
        promptTemplate: content,
        actorId: auth.actorId,
        agentId: req.agentId,
        userId: auth.userId,
        actorType: auth.actorType,
        scopeOwner: resolvedScopeOwner,
        metadata: metadata ?? {},
      });
      return { id: skill.id, kind: "skill" };
    }

    case "task": {
      const task = await ctx.storage.createTask({
        workspaceId,
        title: subject,
        description: content,
        assignedTo: auth.actorId,
        actorId: auth.actorId,
        agentId: req.agentId,
        userId: auth.userId,
        actorType: auth.actorType,
        sessionId,
        scopeOwner: resolvedScopeOwner,
        metadata: metadata ?? {},
      });
      return { id: task.id, kind: "task" };
    }

    case "event": {
      const event = await ctx.storage.createEvent({
        workspaceId,
        name: subject,
        description: content,
        type: "agent",
        occurredAt: new Date(),
        source: auth.actorId,
        agentId: req.agentId,
        // MnemoEvent gained actorId for the first time in migration 0023 — it
        // never had a real provenance field before (only the free-text
        // `source` above, which stays as-is).
        actorId: auth.actorId,
        userId: auth.userId,
        actorType: auth.actorType,
        scopeOwner: resolvedScopeOwner,
        metadata: metadata ?? {},
      });
      return { id: event.id, kind: "event" };
    }

    case "reasoning": {
      const reasoning = await ctx.storage.createReasoning({
        workspaceId,
        question: subject,
        chain: [{ step: 1, reasoning: content }],
        conclusion: content,
        agentId: req.agentId,
        // MnemoReasoning gained actorId for the first time in migration 0023.
        actorId: auth.actorId,
        userId: auth.userId,
        actorType: auth.actorType,
        scopeOwner: resolvedScopeOwner,
        metadata: metadata ?? {},
      });
      return { id: reasoning.id, kind: "reasoning" };
    }

    case "hyperedge": {
      // Hyperedges require ≥3 memberIds — not expressible via RememberRequest.
      // Use the dedicated POST /hyperedges endpoint or memory_hyperedge MCP tool.
      throw new Error(
        "Cannot create a hyperedge via remember(). Use storage.createHyperedge() directly with memberIds."
      );
    }

    default: {
      // TypeScript exhaustiveness guard
      const _exhaustive: never = kind;
      throw new Error(`Unknown kind: ${_exhaustive}`);
    }
  }
}

// ─── Public: remember ─────────────────────────────────────────────────────────

export async function remember(
  ctx: CoreContext,
  req: RememberRequest,
  auth: AuthContext
): Promise<RememberResponse> {
  const span = ctx.telemetry.startSpan("mnemo.remember", {
    attributes: { kind: req.kind, workspaceId: req.workspaceId },
  });

  try {
    // Step 0 (CORE-1): write-time safety gate, mirroring primitives/fact.ts's
    // createFact(). Every kind maps `content` to a genuine free-text field
    // (statement/description/action/promptTemplate/chain/...), so this runs
    // unconditionally rather than per-kind. Poisoning is a hard reject — runs
    // BEFORE PII redaction, since a delimiter-injection payload that gets
    // PII-redacted is still a delimiter injection. PII is redacted-and-stored:
    // the original text never reaches the embed provider or the DB.
    // SEC-2: the gate itself lives in ingest-safety.ts, shared with POST /import.
    const pii = applyIngestSafety(req.content);
    // P121: the caller must be able to learn that its text was changed. The
    // row already recorded it in `metadata.pii`; what was missing was telling
    // whoever asked for the write.
    const redactedCategories = pii.piiCategories.length > 0 ? [...pii.piiCategories] : undefined;
    if (pii.piiCategories.length > 0) {
      req = {
        ...req,
        content: pii.content,
        metadata: {
          ...(req.metadata ?? {}),
          pii: piiMetadata(pii.piiCategories),
        },
      };
    }

    // Step 1: Embed — use host-supplied vector when available so the server
    // never needs its own LLM credentials for the write path.
    //
    // CHAOS-5 — an embedder that is configured but NOT ANSWERING used to fail
    // the whole write: a 500, nothing stored, nothing queued. Embedding is a
    // derived artifact; the statement is the thing the caller asked us to
    // keep. So the write proceeds without a vector, FTS finds it at once, and
    // the outbox worker embeds it when the provider is back (and the daily
    // repair picks up whatever the outbox gave up on). Same line P128 drew for
    // recall. "No embedder configured" (model "none") is a deployment choice,
    // not an outage, and still fails the way it always did (501).
    let embedding: Float32Array | null;
    let embeddingDeferred = false;
    // Egress (SECURITY.md §7, MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=none): every
    // kind carries a tier, and the text of a confidential+ one does not go to
    // an external embedder. Stored without a vector it is found only by exact
    // repeat; no text job is queued here, and the outbox worker and the
    // re-embed sweep re-read the row's tier before embedding anything.
    const sealedFromEmbedder =
      isSensitiveTier(req.sensitivity ?? "internal") &&
      !sensitiveTextMayReachEmbedder(ctx.config.sensitiveTextToProviders, ctx.embed);
    if (req.precomputedEmbedding) {
      embedding = req.precomputedEmbedding;
    } else if (sealedFromEmbedder) {
      embedding = null;
    } else if (ctx.embed.model === "none") {
      embedding = await ctx.embed.embedSingle(req.content);
    } else {
      try {
        embedding = await ctx.embed.embedSingle(req.content);
      } catch (err) {
        embedding = null;
        embeddingDeferred = true;
        ctx.logger.warn("remember: embedder unavailable — storing now, embedding deferred", {
          workspaceId: req.workspaceId,
          kind: req.kind,
          model: ctx.embed.model,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Step 1b: §5 optional ε-DP noise (mode "off" = no-op passthrough; default off).
    // storedVector is used for the surprise gate, stored vector upsert, and LSH bands
    // so the gate and the stored index are always consistent.
    const noiseCfg = ctx.config.embeddingNoise;
    const storedVector =
      embedding && noiseCfg && noiseCfg.mode !== "off"
        ? Float32Array.from(addEmbeddingNoise(Array.from(embedding), noiseCfg))
        : embedding;

    // Step 2–3: Surprise gate + neighbour fetch (ONE search — Wave X).
    // CHAOS-5: no vector, no neighbours — the gate and the anomaly scorer have
    // nothing to measure, and `pe` is recorded as unknown (null), not invented.
    const { pe, neighbourScores, neighbours } = storedVector
      ? await fetchNeighbours(ctx, storedVector, req.workspaceId)
      : { pe: null, neighbourScores: [] as number[], neighbours: [] as VectorSearchHit[] };
    // P74: this gate used to DROP the write. It appended a `staging_evaluation`
    // outbox job and returned a fabricated `crypto.randomUUID()`. Three
    // independent breakages turned that into silent data loss:
    //   1. the outbox payload was written flat, but OutboxWorker destructures
    //      `{ job, data, opts }` — so `data` was undefined and `{}` was enqueued;
    //   2. no consumer was ever registered for `staging_evaluation`, and
    //      InMemoryQueueAdapter.enqueue no-ops silently when no handler exists;
    //   3. the returned id matched no row, so memory_forget confirmed deletions
    //      and memory_relate created dangling relations against a phantom.
    // There is no staged storage anywhere in the schema either — no table, no
    // migration, no repository — so nothing could ever have promoted it.
    //
    // Low prediction error now writes normally. `pe` is preserved on the row so
    // a future deduplication pass keeps the signal; discarding the content was
    // never a prerequisite for using it. Note that `pe` measures topical
    // similarity with no notion of polarity — a correction scores as
    // "unsurprising" against the very statement it corrects, which is precisely
    // the content a memory must not throw away.
    // `pe` is not stashed on req.metadata: that field is the caller's namespace
    // and round-trips back to them. The audit entry at step 7 already records
    // `pe` on every write, and mnemo_audit_log is append-only — a better home
    // for an internal pipeline measurement than caller-owned metadata.
    const lowSurprise = pe !== null && pe < ctx.config.surpriseThreshold;
    if (lowSurprise) {
      ctx.logger.debug("remember: low prediction error, writing anyway", {
        workspaceId: req.workspaceId,
        kind: req.kind,
        pe,
        threshold: ctx.config.surpriseThreshold,
      });
    }

    // Step 3b: Wave X — Semantic anomaly detection (reuses the same neighbour scores)
    // piiRiskScore is not available at this layer without a full PII scan; callers
    // that run PII detection before remember() should pass it via req.metadata.
    const piiRiskScore = (req.metadata?.piiRiskScore as number | undefined) ?? 0;
    const anomaly = scoreAnomaly({
      neighbourScores,
      piiRiskScore,
      threshold: ctx.config?.anomalyScoreThreshold,
    });

    // Step 4–5: Create primitive via storage (DB initialises worthAlpha=2.0, worthBeta=2.0)
    // Lazily seed built-in composition rules for this workspace on first write.
    // mnemo_seed_builtin_rules() is ON CONFLICT DO NOTHING — idempotent. We
    // skip it after the first successful call per process lifetime using a Set.
    if (!_seededWorkspaces.has(req.workspaceId)) {
      await ctx.storage.ensureBuiltinCompositionRules(req.workspaceId);
      _seededWorkspaces.add(req.workspaceId);
    }

    // NOTE: createPrimitive is called BEFORE the anomaly outbox append so that id + kind
    // are available to include in the anomaly_review payload (spec Wave X fix).
    const {
      id,
      kind,
      revision,
      conflict,
      mergedViaTopicKey,
      stored,
      reused,
      deferredConflictCandidates,
      classifiedConflictCandidateIds,
    } = await createPrimitive(ctx, req, auth, storedVector);
    // WP-7: a write that reused an existing record wrote no row. The steps
    // below that index or re-check THIS write's text must not run against the
    // existing id — a fact twin's vector would be overwritten with the
    // paraphrase's.
    const wroteNewFact = kind === "fact" && !reused;

    // Anomaly outbox append (AFTER createPrimitive so id/kind are known)
    if (anomaly.flagged) {
      ctx.logger.warn("remember: anomaly flagged — routing to review queue", {
        workspaceId: req.workspaceId,
        kind: req.kind,
        anomalyScore: anomaly.score,
        signals: anomaly.signals,
      });
      // P111 — the log line above has always said "routing to review queue".
      // It now goes to one.
      //
      // This used to append an `anomaly_review` queue_job. P74 fixed its payload
      // shape (it was written flat, so the outbox worker enqueued `{}` and the
      // content never travelled), but the deeper problem survived: no
      // `queue.process` handler was ever registered for that job, so a flagged
      // anomaly went nowhere either way.
      //
      // Routed to `mnemo_review_item`, the durable queue that already backs the
      // §33 contradiction review a few lines below, the §34.7 self-edit abuse
      // flag, and self-reflect's knowledge gaps. Wave X's scoreAnomaly exists to
      // surface writes that look like poisoning or exfiltration; a detector
      // whose output is unreadable is worse than no detector, because the log
      // line makes it look handled.
      //
      // The primitive already exists at this point — createPrimitive runs above
      // precisely so `id`/`kind` are real here — so the review row points at a
      // row that can be inspected and resolved.
      await ctx.storage.enqueueReviewItem({
        workspaceId: req.workspaceId,
        primitiveId: id,
        primitiveKind: kind,
        reason: "anomaly",
        detail: {
          anomalyScore: anomaly.score,
          signals: anomaly.signals,
          actorId: auth.actorId,
          ...(req.subject ? { subject: req.subject } : {}),
        },
      });
    }

    // auto-trigger-scoped-consolidation: write-time, near-real-time scoped
    // semantic conflict check. Neighbour-scoped, capped, best-effort — fires
    // on a separate outbox job, so nothing here waits on it.
    //
    // WP-7: it is now also the fallback for the write-time classifier. Its
    // candidates are the close neighbours plus every §33 candidate that got no
    // verdict at write time (no LLM, error, timeout — at any cosine, not only
    // ≥ 0.85), minus the pairs that DID get one: classifying those twice would
    // pay the LLM twice for the same answer.
    if (wroteNewFact && ctx.config.scopedConflictCheckEnabled !== false) {
      const classified = new Set(classifiedConflictCandidateIds ?? []);
      const byId = new Map<string, number>();
      for (const hit of [
        ...neighbours.filter((n) => n.score >= SCOPED_CONFLICT_SIMILARITY_THRESHOLD),
        ...(deferredConflictCandidates ?? []),
      ]) {
        if (hit.id === id || classified.has(hit.id)) continue;
        byId.set(hit.id, Math.max(byId.get(hit.id) ?? 0, hit.score));
      }
      const scopedConflictCandidates = [...byId]
        .map(([candidateId, score]) => ({ id: candidateId, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, SCOPED_CONFLICT_MAX_NEIGHBOURS);
      if (scopedConflictCandidates.length > 0) {
        await ctx.storage.appendOutbox({
          workspaceId: req.workspaceId,
          eventType: "queue_job",
          payload: {
            job: "scoped_semantic_conflict_check",
            data: {
              factId: id,
              workspaceId: req.workspaceId,
              candidates: scopedConflictCandidates,
            },
          },
        });
      }
    }

    // Step 6: Transactional outbox — vector upsert + cache bust (CRIT-05)
    // CORE-5: FactRepository.createFact (adapter-postgres) already enqueues
    // its own vector-form vector_upsert entry inside the same INSERT
    // transaction whenever input.embedding is set — and it always is for
    // facts (see the "Authoritative embedding" comment above). Enqueuing
    // again here duplicated it on every single fact write.
    //
    // make-primitives-recallable (design.md D1/D2): DecisionRepository's
    // createDecision/mergeDecisionByTopicKey were ALSO already enqueuing
    // their own in-transaction vector_upsert entry — this block, gated only
    // on `kind !== "fact"`, was therefore double-enqueuing every decision
    // write too. RECALLABLE_KINDS is exactly the set of kinds whose
    // repository owns its own in-transaction enqueue; every other kind has
    // no such repository-owned enqueue and still needs this one.
    if (
      !(RECALLABLE_KINDS as readonly string[]).includes(kind) &&
      !reused &&
      (storedVector || !sealedFromEmbedder)
    ) {
      await enqueuePrimitiveIndex(ctx, {
        workspaceId: req.workspaceId,
        id,
        kind,
        // CHAOS-5: the text the vector would have been computed from, for the
        // worker to embed once the provider answers.
        ...(storedVector ? { vector: Array.from(storedVector) } : { text: req.content }),
        ...(revision !== undefined ? { revision } : {}),
        model: ctx.embed.model,
      });
    }
    // Step 6a (Bug 2 fix): apply the fact embedding SYNCHRONOUSLY so a freshly
    // written fact is vector-searchable the moment remember() returns, instead of
    // depending solely on the async outbox drain. The vector_upsert entry above
    // stays as an idempotent durability fallback — if this best-effort write
    // fails, the OutboxWorker still applies it later.
    //
    // Why this matters: a fact's embedding lives in mnemo_fact.embedding (same DB,
    // not a remote vector store), yet it was only ever written by whichever
    // process drained the vector_upsert outbox entry. Any consumer that claims
    // that entry but fails to route it to the vector sink — e.g. a second/stale
    // server whose OutboxWorker no-ops unknown event types — silently drops the
    // embedding, leaving recall of new facts lexical-only. Writing it here, in the
    // request path, makes the embedding immune to that race. ctx.vector targets
    // mnemo_fact, so this is fact-only; other kinds keep their existing
    // outbox → storage.updateEmbeddingVector path.
    if (wroteNewFact && storedVector) {
      try {
        await ctx.vector.upsert(id, storedVector, {
          kind,
          revision,
          model: ctx.embed.model,
          workspaceId: req.workspaceId,
        });
      } catch (err) {
        ctx.logger.warn("remember: synchronous fact embedding failed; outbox fallback will retry", {
          workspaceId: req.workspaceId,
          factId: id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Step 6b: LSH band signatures for Tier 2 pointer recall (spec §17).
    // CHAOS-5: a deferred fact gets its bands from the worker (`indexLsh`).
    if (wroteNewFact && storedVector) {
      const lshBandValues = lshBands(storedVector).map((b) => ({
        bandIdx: b.bandIdx,
        bandHash: b.bandHash.toString(),
      }));
      await ctx.storage.appendOutbox({
        workspaceId: req.workspaceId,
        eventType: "lsh_upsert",
        payload: { factId: id, revision, bands: lshBandValues },
      });
    }
    await ctx.storage.appendOutbox({
      workspaceId: req.workspaceId,
      eventType: "cache_bust",
      payload: { pattern: `mnemo:${req.workspaceId}:hot:*` },
    });

    // Step 7: Audit trail
    await ctx.storage.appendAuditEntry({
      workspaceId: req.workspaceId,
      actorType: auth.actorType,
      actorId: auth.actorId,
      // P76: "create" was hardcoded, so a topicKey merge that reached this point
      // (the race branch) was logged as an insert of a row that already existed.
      // WP-7: a write that reused an existing record created nothing either.
      action: mergedViaTopicKey || reused ? "update" : "create",
      resourceKind: kind,
      resourceId: id,
      isTerminal: false,
      // `staged` is now always false — nothing stages any more (P74). `lowSurprise`
      // marks the writes the old gate would have silently discarded, so the
      // population it used to swallow stays measurable from the audit log alone.
      detail: {
        pe,
        staged: false,
        lowSurprise,
        anomalyScore: anomaly.score,
        anomalyFlagged: anomaly.flagged,
        ...(embeddingDeferred ? { embeddingDeferred: true } : {}),
        ...(reused ? { via: `${reused.via}_reuse` } : {}),
      },
    });

    ctx.logger.info("remember: committed", {
      workspaceId: req.workspaceId,
      kind,
      id,
      pe,
    });

    return {
      id,
      kind,
      staged: false,
      // make-primitives-recallable (design.md D1/D2): reports whether `kind`
      // is indexed on write at all (RECALLABLE_KINDS), not merely whether it
      // was indexed SYNCHRONOUSLY (that was the old `kind === "fact"` check
      // — see CORE-6 below). Facts stay synchronous (Step 6a); decisions and
      // future recallable kinds land asynchronously via the outbox worker.
      vectorSearchable: (RECALLABLE_KINDS as readonly string[]).includes(kind),
      // P121: what was WRITTEN, not what was asked for. `req.content` was
      // reassigned by the redaction gate at step 0, so this is the post-
      // redaction text — the same string the row holds. WP-7: for a
      // paraphrase folded into an existing fact, the row holds the twin's
      // statement, and that is what the caller is told.
      storedContent: reused?.via === "paraphrase" ? reused.statement : req.content,
      // P122: absent for the non-fact kinds, which produce no fact row. Absent
      // means "not known here", never "empty" — the route falls back rather
      // than reporting zeros.
      ...(stored ? { stored } : {}),
      ...(redactedCategories ? { redactedCategories } : {}),
      ...(conflict ? { conflict } : {}),
      ...(embeddingDeferred ? { embeddingDeferred: true } : {}),
    };
  } catch (err) {
    throw err;
  } finally {
    span.end();
  }
}
