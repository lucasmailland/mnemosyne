// Port interfaces — PACKAGE_ARCHITECTURE.md §3 (updated by TASK-0006/0007)
// These are the hexagonal-architecture "ports": the contracts @mnemo-ai/core
// depends on. Zero infrastructure imports here; all adapters implement these.

import type {
  MnemoFact,
  MnemoDecision,
  MnemoEpisode,
  MnemoEntity,
  MnemoStrategy,
  MnemoWorkflow,
  MnemoSkill,
  MnemoTask,
  MnemoEvent,
  MnemoReasoning,
  MnemoHyperedge,
  MnemoCompositionRule,
  MnemoInferenceLogEntry,
  MnemoFactHash,
  MnemoAgentProfile,
  ConfidenceMapRow,
  KnowledgeGapRow,
  MetacognitionTrends,
  SequentialPatternRow,
  PeriodicPatternRow,
  ConditionalPatternRow,
  CoOccurrencePatternRow,
  WorkflowStep,
  EventAnnotation,
} from "./primitives.js";
import type {
  MnemoRelation,
  RelationVerb,
  JudgmentStatus,
  MarkerKind,
  RelationNodeKind,
  MnemoCitation,
  CitationFilter,
  GraphSnapshotFilter,
  GraphSnapshot,
} from "./relations.js";
import type {
  ManagedArchiveReason,
  ManagedCollapseRetry,
  ManagedLifecycleQuiesceResult,
  ManagedSessionClaim,
  MnemoSession,
  SessionTurn,
} from "./session.js";
import type { OutboxEntry } from "./outbox.js";
import type { AuditLogEntry } from "./audit.js";
import type {
  PaginatedResult,
  WorthDelta,
  HealthStatus,
  Sensitivity,
  DecayClass,
} from "./common.js";
import type { PrimitiveKind } from "./primitives.js";
import type {
  Provenance,
  RecallFilter,
  RecallHitObservation,
  RecallRequestObservation,
  RememberKind,
} from "./recall.js";
import type { ActorType } from "./provenance.js";
import type { HarnessEvent, HarnessEventAck, ManagedSessionProvenance } from "./harness.js";

// ─── Input/Filter types ───────────────────────────────────────────────────────

export interface CreateSessionInput {
  workspaceId: string;
  agentId?: string;
  /** The authenticating CREDENTIAL, namespaced ActorRef ("key:<id>").
   *  Persisted to metadata — NEVER to mnemo_session.user_id. */
  actorId?: string;
  /** The real mnemo_user.id behind the request, or null. Persisted to
   *  mnemo_session.user_id. */
  userId?: string | null;
  actorType?: ActorType;
  metadata?: Record<string, unknown>;
  label?: string;
  trafficOrigin?: import("./session.js").TrafficOrigin;
  sourceSessionId?: string;
  sourceClientInstanceId?: string;
  sourceGeneration?: number;
  predecessorSessionId?: string;
}

export interface CreateFactInput {
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  scope: MnemoFact["scope"];
  scopeRef?: string;
  statement: string;
  subject: string;
  kind: MnemoFact["kind"];
  confidence?: number;
  relevance?: number;
  attribution?: MnemoFact["attribution"];
  attributedTo?: MnemoFact["attribution"];
  sourceMessageIds?: string[];
  sessionId?: string;
  extractionSource?: string;
  topicKey?: string;
  entityId?: string;
  episodeId?: string;
  validFrom?: Date;
  validTo?: Date;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sensitivity?: MnemoFact["sensitivity"];
  /**
   * PRIM-15 — restore paths (POST /import) only. A new fact starts `active` and
   * unpinned; a restored one keeps what the export said, so a forgotten fact
   * comes back closed and a pinned one stays pinned. Omitted → the column
   * defaults (`active`, `false`), exactly as before.
   */
  status?: MnemoFact["status"];
  pinned?: boolean;
  /**
   * Ownership level: "workspace:<id>" | "user:<id>" | "tenant:<id>".
   * Defaults to "workspace:<workspaceId>" when omitted.
   * Used by multi-level recall to route facts to the right context pool.
   */
  scopeOwner?: string;
  /**
   * Precomputed embedding for the fact's statement. When supplied, createFact
   * enqueues an authoritative vector-form `vector_upsert` outbox entry (the
   * worker re-applies this exact vector) instead of the text-form entry it would
   * otherwise embed itself. This honours the "server skips its own embed pass
   * when a vector is supplied" contract and prevents a re-embed of the statement
   * from clobbering a host-supplied vector. Length must match the workspace
   * embedding dimensions.
   */
  embedding?: number[];
  /** The model stamp (e.g. 'text-embedding-3-small') used to generate the embedding. */
  embeddingModel?: string;
  /**
   * Extra fields to stamp on the `vector_upsert` outbox entry this call enqueues.
   *
   * `mnemo_outbox` grants `mnemo_app_role` SELECT and INSERT only (0001 baseline),
   * matching the append-only posture of the audit and deletion logs. A caller that
   * needs the job to say more than the defaults therefore has to supply it here,
   * to be written with the row — an UPDATE afterwards fails with 42501 under the
   * non-bypass role `withMnemoTx` installs.
   */
  vectorJob?: {
    /**
     * Ask the worker to also persist this fact's LSH band signatures, inside the
     * same job, before it acknowledges.
     *
     * `remember()` embeds synchronously and can enqueue its own `lsh_upsert` entry
     * with precomputed bands. A caller with no embedding at creation time (managed
     * collapse) cannot, so it rides the request on the vector job — which also
     * makes vector + LSH + acknowledgement one atomic retry unit rather than two
     * independently ackable entries. Fact-only: LSH bands serve near-duplicate
     * fact recall (spec §17).
     */
    indexLsh?: boolean;
    /** Managed-collapse operation that produced this fact, for provenance. */
    operationId?: string;
    /**
     * Revision the job should index at. Defaults to 1, which is right for a new
     * fact; a bitemporal successor must pass its predecessor's count plus one so
     * the LSH row is keyed to the revision the successor actually carries.
     */
    revision?: number;
  };
}

export interface UpdateFactInput {
  statement?: string;
  confidence?: number;
  relevance?: number;
  status?: MnemoFact["status"];
  pinned?: boolean;
  /**
   * P85.2 — `null` REOPENS the bitemporal interval; omitting the field leaves it
   * untouched. Implementations already distinguish the two (`if (input.validTo
   * !== undefined)`), but the type only allowed a Date, so there was no way to
   * express "this fact is valid again".
   *
   * That is what made `POST /facts/:id/restore` a lie: it set `status: "active"`
   * and nothing else, while every recall path filters on `validTo IS NULL`. The
   * fact came back 200, reported `status: "active"`, and stayed unrecallable.
   */
  validTo?: Date | null;
  metadata?: Record<string, unknown>;
  /**
   * flatten-legacy-dual-core PR15 (task 6c.2) — additive widening backing
   * `PATCH /facts/:id`'s subject/kind edit fields. Legacy `patchFact()`
   * (factory.ts) has always supported patching `subject`/`kind`; both
   * columns are physically present on `mnemo_fact` and already modeled by
   * `MnemoFact`, but this port-interface method never exposed them — same
   * class of narrow, additive widening as PR9c's `sourceIds`/PR9f's
   * `targetIds`, not new domain modeling.
   */
  subject?: string;
  kind?: MnemoFact["kind"];
  /**
   * CHAOS-8 — optimistic precondition. When set, the update applies only if
   * the row is still at this `revisionCount`; otherwise the adapter throws
   * {@link FactRevisionConflictError} and changes nothing. Read-modify-write
   * callers (self-edit `append`, `PATCH /facts/:id` with `expectedRevision`)
   * use it so two writers cannot silently overwrite each other.
   */
  expectedRevision?: number;
}

/**
 * CHAOS-8 — thrown by `updateFact` when `expectedRevision` no longer matches
 * the row. Nothing was written; re-read and retry, or report a conflict.
 */
export class FactRevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(
    readonly factId: string,
    readonly expectedRevision: number,
    readonly currentRevision: number
  ) {
    super(`fact ${factId} is at revision ${currentRevision}, not the expected ${expectedRevision}`);
    this.name = "FactRevisionConflictError";
  }
}

/** CHAOS-7 — the `uniq_mnemo_fact_dedup` key of a fact write. */
export interface FindLiveFactByStatementInput {
  workspaceId: string;
  scope: MnemoFact["scope"];
  scopeRef?: string;
  subject: string;
  /** The statement as stored (post-redaction, plaintext tiers only). */
  statement: string;
  /**
   * APP-009 — the rest of a fact's identity. When given, only a row with this
   * owner (a row with none counts as the workspace's) and this tier matches:
   * the same sentence owned by another user, or kept at another tier, is a
   * different fact. Omitted, the lookup is by the first four fields alone.
   */
  scopeOwner?: string;
  sensitivity?: MnemoFact["sensitivity"];
}

export interface MergeFactByTopicKeyInput {
  workspaceId: string;
  topicKey: string;
  statement: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  /**
   * The session the new statement came from (WP-4 request). When given, the
   * successor carries it and starts with `episode_id = NULL`, so the collapse
   * of THAT session links it (`linkSessionFactsToEpisode`) instead of it
   * staying attached to the predecessor's episode. Omitted → both inherited.
   */
  sessionId?: string;
  /** Provenance of the new statement (e.g. "collapse"). Omitted → inherited. */
  extractionSource?: string;
  /**
   * The vector the caller already computed from the new statement's plaintext.
   * A confidential+ successor is never re-embedded from its column (that holds
   * ciphertext), so without this it would drop out of semantic recall.
   */
  embedding?: number[];
  embeddingModel?: string;
}

export interface MergeDecisionByTopicKeyInput {
  workspaceId: string;
  topicKey: string;
  title: string;
  body: string;
  kind: MnemoDecision["kind"];
  metadata?: Record<string, unknown>;
  /**
   * AGENTSIM-7 support: persisted on the revised row when given, so a decision
   * written through `remember` keeps its scope and session correlation on the
   * topic-key update path too (create already carries both). Left untouched
   * when omitted.
   */
  scopeRef?: string;
  conversationId?: string;
}

export interface ReplaceFactInput {
  id: string;
  workspaceId: string;
  statement: string;
  requestedBy: string;
  agentId?: string;
  actorIsolationId?: string;
  /**
   * Real `mnemo_user.id`. Presence is the enable signal for the
   * user-isolation RLS backstop (`mnemo_fact_user_isolation_select`) — there
   * is no separate boolean toggle, so enforcement can never be turned on
   * without a concrete identity to scope it to.
   */
  userIsolationId?: string;
}

export interface ReplaceFactResult {
  previous: MnemoFact;
  replacement: MnemoFact;
}

export interface FactFilter {
  workspaceId: string;
  status?: MnemoFact["status"];
  kind?: MnemoFact["kind"];
  scope?: MnemoFact["scope"];
  entityId?: string;
  sessionId?: string;
  minConfidence?: number;
  topicKey?: string;
  tags?: string[];
  validAt?: Date;
  offset?: number;
  limit?: number;
  /**
   * complete-mcp-tools B3 — transaction-time lower bound (created_at >= x).
   * Additive-only field: when set, `queryFacts` also orders results by
   * `created_at DESC` so callers surfacing genuine creation events (e.g.
   * `GET /timeline`) can rely on newest-first ordering. Does not replace or
   * rename any existing field.
   */
  createdSince?: Date;
  /** The caller's read ceiling: rows above it are left out of the page and of `total`. */
  maxSensitivity?: Sensitivity;
}

// ─── flatten-legacy-dual-core PR9b (D6.3 — T2) — keyset fact list + hard purge ──
//
// `queryFacts`/`FactFilter` above are left UNTOUCHED (its `PaginatedResult`
// offset contract has many existing callers, incl. PR8's `linkedFactCount`).
// `FactPageFilter`/`FactPage`/`queryFactsPage` are a SEPARATE, additive
// keyset-pagination method living beside it — ports `GET /facts` (list),
// which legacy `CoreLike.listFacts` (factory.ts) backed with cursor
// pagination, FTS, sortBy/order, and a bitemporal `asOf` snapshot.

export interface FactPageFilter {
  workspaceId: string;
  kind?: MnemoFact["kind"];
  scope?: MnemoFact["scope"];
  scopeRef?: string;
  /**
   * P135: other spellings of the project `scopeRef` names (its canonical name
   * and aliases). A row matches when its scope_ref is `scopeRef` or any of
   * these. Filled by the core from the workspace's `project` entities, never
   * by callers; ignored without `scopeRef`.
   */
  scopeRefAliases?: string[];
  status?: MnemoFact["status"] | "all";
  pinned?: boolean;
  sensitivity?: Sensitivity;
  /** Plain-text FTS over text_lemmatized — plainto_tsquery over the shared
   * `mnemosyne.mnemo_fts` config (P131 B1), same as findContradictingFacts. */
  q?: string;
  sortBy?: "created_at" | "updated_at" | "relevance" | "hit_count";
  order?: "asc" | "desc";
  /** Opaque base64 keyset cursor `{v, id}` — legacy wire format, preserved verbatim. */
  cursor?: string;
  asOf?: Date;
  /** Incremental pull: only facts modified after this instant (federation.ts's future use). */
  updatedSince?: Date;
  /** Only facts created at or after this instant (`created_at >= x`). */
  createdSince?: Date;
  /**
   * PRIM-8 — the caller's read ceiling. Rows above it are excluded in the
   * query itself, so both the page and `total` only ever describe what the
   * caller may read. Omitted → no ceiling (internal callers).
   */
  maxSensitivity?: Sensitivity;
  /**
   * PRIM-16 — only rows whose validity is still open (`valid_to IS NULL`).
   * `status: "active"` alone admits a row whose interval already ended.
   */
  currentOnly?: boolean;
  limit: number;
}

export interface FactPage {
  items: MnemoFact[];
  nextCursor: string | null;
  total: number;
  /**
   * PRIM-19 — `itemCursors[i]` resumes strictly after `items[i]`, rendered with
   * the database's own precision (a JS Date would lose microseconds). Lets a
   * caller that merges this page with another stream stop at any item.
   */
  itemCursors?: string[];
}

// ─── flatten-legacy-dual-core Slice 3a pt.2 (PR6) — workspace vitals + audit feed ──
//
// Ported 1:1 from the legacy `CoreLike.vitals()`/`CoreLike.audit()` shapes
// (packages/core/src/factory-types.ts's `CoreWorkspaceVitals`/`CoreAuditEntry`)
// so `routes/health.ts` and `routes/audit.ts` can move off `deps.core` without
// changing their observable HTTP contract (D3 Tier A parity pins the response
// shape byte-for-byte before this port).

/** Workspace-scoped fact vitals — GET /health's response body. */
export interface WorkspaceVitals {
  workspaceId: string;
  factsLive: number;
  factsClosed: number;
  pinnedCount: number;
  lastRecallAt: string | null;
  lastWriteAt: string | null;
  embeddings: { indexed: number; pending: number };
  /** Live fact counts grouped by scope_ref. Only non-null scope_ref values. */
  factsByScopeRef: Array<{ scopeRef: string; count: number }>;
}

/**
 * The undo-log feed (GET /audit) counted, not listed: exactly `days` UTC days ending
 * today, zero-filled, oldest first, each with the day's user forgets and system
 * archives; `totals` over the window.
 */
export interface AuditFeedStats {
  days: Array<{ day: string; user: number; system: number }>;
  totals: { user: number; system: number };
}

/** One entry in the inspector's "Undo log" — GET /audit's response items. */
export interface AuditFeedEntry {
  id: string;
  factId: string;
  factStatement: string;
  factSubject: string;
  factKind: string;
  action: "forgotten";
  actorKind: "user" | "system";
  actorName: string | null;
  timestamp: string;
  revertible: boolean;
}

/** Filter for {@link StorageAdapter.getAuditFeed} — mirrors GET /audit's query params. */
export interface AuditFeedFilter {
  workspaceId: string;
  limit: number;
  actorKind?: "user" | "system";
  from?: string;
  to?: string;
  q?: string;
  /** Only facts at or below this tier (the caller's read ceiling). Omitted: every tier. */
  maxSensitivity?: Sensitivity;
}

// ─── flatten-legacy-dual-core Phase 9 (task 9.1) — health snapshot ────────────
//
// Ported 1:1 from `packages/core/src/health/{index,compute}.ts`'s
// `HealthSnapshot`/`GetHealthSnapshotInput` shapes (Requirement 4) so
// `routes/admin.ts`, `routes/governance.ts`, and the `mnemo.health.snapshot`
// cron can move off the direct `@mnemo-ai/core` import onto the v3
// `StorageAdapter` port, matching the `getWorkspaceVitals`/`getAuditFeed`
// precedent above (PR6). Same physical `mnemo_health`/`mnemo_extraction_job`
// tables; same computed-metric definitions; response shape unchanged.

/** One `mnemo_health` row — a per-workspace memory-drift snapshot. */
export interface HealthSnapshot {
  workspaceId: string;
  snapshotAt: Date;
  factCountActive: number;
  factCountArchived: number;
  factCountEmbedded: number;
  factCountUnembedded: number;
  decisionCountActive: number;
  relationCountConflicts: number;
  factsWithZeroHits: number;
  /** NULL when no telemetry exists yet (cold start). */
  recallHitRate30d: number | null;
  extractionJobsFailed7d: number;
  extractionJobsDeferred: number;
  computedInMs: number;
}

/**
 * One UTC day of the snapshot history: exactly `days` entries ending today, oldest
 * first; a day with no snapshot has every figure null. Shares, not row counts: a
 * snapshot covers every sensitivity tier, so absolute counts are left out.
 * `zeroHitShare` = facts never recalled / active facts; `embeddedShare` = embedded /
 * (embedded + unembedded); `recallHitRate30d` as stored; `failedJobs7d` as stored.
 */
export interface HealthSnapshotDay {
  day: string;
  recallHitRate30d: number | null;
  zeroHitShare: number | null;
  embeddedShare: number | null;
  failedJobs7d: number | null;
}

/** Input for {@link StorageAdapter.getHealthSnapshot}. */
export interface GetHealthSnapshotInput {
  workspaceId: string;
  /**
   * When true, recompute the snapshot now AND persist it. When false
   * (default), return the most recently persisted snapshot, or `null`
   * when none exist yet.
   */
  fresh?: boolean;
}

// ── flatten-legacy-dual-core Slice 3c pt.1 (PR10) — active-learning review
// queue (`mnemo_review_queue`, Mnemosyne v1.3+). Backs `routes/review.ts`.
// See {@link StorageAdapter.listActiveLearningReview} for the disambiguation
// against the Wave Y §25.1 `enqueueReview`/`enqueueReviewItem` pair, which
// target the unrelated `mnemo_review_item` table.

export type ActiveLearningReviewReason = "low_confidence" | "contradiction" | "manual";
export type ActiveLearningReviewResolution = "kept" | "edited" | "forgotten" | "dismissed";

export interface ActiveLearningReviewRow {
  id: string;
  workspaceId: string;
  /** Populated for fact-sourced rows; null for decision-sourced rows. */
  factId: string | null;
  /** Populated for decision-sourced rows; null for fact-sourced rows. */
  decisionId: string | null;
  reason: ActiveLearningReviewReason;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: ActiveLearningReviewResolution | null;
}

/** Filter for {@link StorageAdapter.listActiveLearningReview} — mirrors GET /review's query params. */
export interface ActiveLearningReviewFilter {
  workspaceId: string;
  reason?: ActiveLearningReviewReason;
  /** When true, include resolved rows. Defaults to unresolved-only. */
  includeResolved?: boolean;
  limit?: number;
}

export interface EnqueueActiveLearningReviewInput {
  workspaceId: string;
  /** Exactly one of `factId`/`decisionId` must be supplied. */
  factId?: string;
  decisionId?: string;
  reason: ActiveLearningReviewReason;
}

export interface EnqueueActiveLearningReviewResult {
  /** id of the row queued, OR the pre-existing open row's id on a dedup hit. */
  id: string;
  /** True iff a fresh row was inserted; false on a dedup hit. */
  inserted: boolean;
}

export interface ResolveActiveLearningReviewInput {
  workspaceId: string;
  reviewId: string;
  resolvedBy: string;
  resolution: ActiveLearningReviewResolution;
}

export interface ResolveActiveLearningReviewResult {
  /** True when an open row was resolved; false when already resolved or missing. */
  resolved: boolean;
  factId: string | null;
  decisionId: string | null;
  /** True when `resolution: 'forgotten'` cascaded to the linked fact's status. */
  cascaded: boolean;
}

// ── §33 Distributed Consensus — contradiction detection on write ──────────────

/**
 * Query for active facts that potentially contradict a candidate fact.
 * Mirrors the candidate-on-write matching in core conflict/fact-candidate.ts:
 * same `subject` (catches "user prefers X" → "user prefers Y") OR FTS overlap
 * on the statement. Scoped to ACTIVE facts in the workspace.
 */
/**
 * P130 — default cosine floor for contradiction candidates.
 *
 * Measured against the real pairs, worst case on each side:
 *
 *   worst TRUE contradiction that must pass   0.6861
 *     ("usamos Postgres" / "ya no usamos Postgres, migramos a MySQL")
 *   worst FALSE pair that must not            0.4356
 *     ("Verificacion de P117: soft delete" / "The team uses PostgreSQL…")
 *
 * 0.55 sits between them with margin on both sides, and leans low on purpose:
 * this is a candidate GATE and the resolver still judges polarity downstream,
 * so admitting a near-miss costs one review item while rejecting a true
 * contradiction loses it silently. Asymmetric cost, asymmetric placement.
 *
 * Lives here rather than in an adapter so the production adapter and the
 * in-memory double cannot drift to different floors — a divergence that would
 * make every contradiction test meaningless without failing anything.
 */
export const DEFAULT_CONTRADICTION_MIN_SIMILARITY = 0.55;

/**
 * PRIM-5 — the subject a fact gets when the caller sends none (remember,
 * collapse, import all default to it). It says nothing about what a fact is
 * about, so for a row without a usable vector, sharing it must never make a
 * contradiction candidate on its own: one such row (a restored fact with a NULL
 * embedding) turned every later default-subject write into a "conflict".
 */
export const GENERIC_FACT_SUBJECT = "general";

/** True when `subject` names something — neither empty nor {@link GENERIC_FACT_SUBJECT}. */
export function isSpecificFactSubject(subject: string): boolean {
  const s = subject.trim().toLowerCase();
  return s !== "" && s !== GENERIC_FACT_SUBJECT;
}

export interface FindContradictingFactsInput {
  /** Exact `subject` of the candidate fact (cheap same-subject match). */
  subject: string;
  /** The candidate statement, run through full-text search for overlap. */
  statement: string;
  /** When set, the just-inserted candidate is excluded from the results. */
  excludeId?: string;
  /** Max rows returned. Default 5 (adapter-defined). */
  limit?: number;
  /**
   * P130 — the incoming statement's embedding. When supplied, candidates are
   * generated by cosine similarity and `subject` stops generating them.
   *
   * The lexical predicate CANNOT find contradictions, by construction:
   * `plainto_tsquery` ANDs every term, so a candidate must contain every word
   * of the incoming statement — including the one that differs. A
   * contradiction differs by definition. Measured: "el broker de mensajes es
   * RabbitMQ" @@ plainto_tsquery("el broker de mensajes es Kafka") is FALSE.
   *
   * So `subject = $1` was not a crutch, it was the only clause producing
   * candidates at all — which is why conflicts were reported between pairs as
   * unrelated as "Verificacion de P117: soft delete" and "The team uses
   * PostgreSQL with pgvector" (both `general`). Removing it without a
   * replacement was tried and reverted: it swapped 100% false positives for
   * 100% false negatives.
   *
   * Cosine is the replacement because it measures the thing the predicate was
   * always reaching for — "talks about the same thing" — leaving polarity to
   * the resolver. Measured separation on the real cases, worst positive vs
   * worst negative: +0.25 with bge-m3, +0.17 with mxbai-embed-large. Both
   * separate; the current model separates more.
   *
   * Optional so callers without an embedding keep the old behaviour rather
   * than silently getting no candidates.
   */
  embedding?: number[];
  /**
   * Cosine floor for the semantic arm. Adapter default sits between the
   * measured worst-positive and worst-negative above. Ignored when
   * `embedding` is absent.
   */
  minSimilarity?: number;
  /**
   * The caller's read ceiling: facts above it are not candidates. The
   * candidates' text reaches the caller (`/remember` conflicts, paraphrase
   * reuse), so a writer must not see what it could not read.
   */
  maxSensitivity?: Sensitivity;
  /**
   * The context of the write being screened. When set, only facts in that
   * same context are candidates — the scope, scope_ref and owner (NULL owner =
   * `workspace:<id>`) a recall filtered to it, and paraphrase reuse, match on.
   */
  writeContext?: {
    scope: MnemoFact["scope"];
    scopeRef?: string;
    scopeOwner: string;
  };
}

/**
 * A fact surfaced as a potential contradiction. Carries exactly the fields the
 * pure §33 resolver (decideAutoResolution) consumes — attribution, worth,
 * validFrom — plus identity/context (id, statement, subject, confidence) the
 * caller needs to act on the verdict (supersede / review) and to log it.
 *
 * `worth` is the generated Beta-Bernoulli posterior (NUMERIC in Postgres);
 * adapters MUST coerce it to a JS number before returning.
 */
export interface ContradictingFact {
  id: string;
  subject: string;
  statement: string;
  confidence: number;
  attribution: MnemoFact["attribution"];
  worth: number;
  validFrom: Date;
  /**
   * Cosine similarity to the incoming embedding, when the candidate was found
   * by its vector. Absent for a candidate found by the lexical predicate (no
   * usable vector, or no embedding supplied) — there is no cosine to report.
   */
  similarity?: number;
}

export interface CreateDecisionInput {
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  conversationId?: string;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  /** Project/entity scope reference (e.g. 'project-x'). Mirrors mnemo_fact.scope_ref. */
  scopeRef?: string;
  kind: MnemoDecision["kind"];
  title: string;
  body: string;
  topicKey?: string;
  decidedByUserId?: string;
  confidence?: number;
  validFrom?: Date;
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export interface UpdateDecisionInput {
  workspaceId: string;
  title?: string;
  body?: string;
  status?: MnemoDecision["status"];
  supersededById?: string;
  validTo?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * WP-6 / PRIM-18 — atomic decision supersession. Locks both decisions, then in
 * one transaction closes the predecessor (`status='superseded'`,
 * `supersededById`, `validTo`), records the `supersedes` lineage relation
 * (successor -> predecessor) and drops the predecessor from the vector index.
 *
 * Throws `StorageValidationError` for a self-supersede, `StorageNotFoundError`
 * when either decision is missing in the workspace, and `StorageConflictError`
 * when the successor is not active (which also rules out cycles) or the
 * predecessor was already replaced by a DIFFERENT decision. Repeating the same
 * transition is idempotent: it returns the predecessor unchanged.
 */
export interface SupersedeDecisionInput {
  workspaceId: string;
  /** The decision being replaced. */
  id: string;
  /** The decision that replaces it. */
  supersededById: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
}

export interface DecisionFilter {
  workspaceId: string;
  status?: MnemoDecision["status"];
  kind?: MnemoDecision["kind"];
  topicKey?: string;
  /** When set, return records with scope_ref = X OR scope_ref IS NULL. */
  scopeRef?: string;
  /**
   * P135: other spellings of the project `scopeRef` names (its canonical name
   * and aliases). A row matches when its scope_ref is `scopeRef` or any of
   * these. Filled by the core from the workspace's `project` entities, never
   * by callers; ignored without `scopeRef`.
   */
  scopeRefAliases?: string[];
  validAt?: Date;
  /** Only rows open now (`validTo IS NULL`): the clock-free "current" filter (see EntityFilter.openOnly). */
  openOnly?: boolean;
  /** Only decisions in one of these statuses (ANDed with `status`). */
  statuses?: MnemoDecision["status"][];
  /** Read ceiling: decisions above it are excluded in the query. Omitted → no ceiling. */
  maxSensitivity?: Sensitivity;
  /** Only decisions created at or after this instant. */
  createdSince?: Date;
  /** Only decisions whose `validTo ?? updatedAt` (ms precision) is strictly after this instant. */
  closedSince?: Date;
  /**
   * Newest first by this instant at ms precision, ties broken by id in byte
   * order, descending. `closedAt` is `validTo ?? updatedAt`. Unset keeps the
   * storage order.
   */
  orderBy?: "createdAt" | "closedAt";
  /** Keyset: only rows that sort after this position (older, or same ms and a smaller id). Needs `orderBy`. */
  before?: { at: Date; id: string };
  /** No COUNT: `total` is then `offset + items.length` and `hasMore` means the page came back full. */
  skipTotal?: boolean;
  offset?: number;
  limit?: number;
}

export interface CreateEpisodeInput {
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  title: string;
  narrative: string;
  occurredAt: Date;
  durationMinutes?: number;
  participants?: string[];
  topics?: string[];
  linkedFactIds?: string[];
  parentEpisodeId?: string;
  deltaContent?: string;
  isSynthetic?: boolean;
  sourceConversationId?: string;
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export type UpdateEpisodeInput = { workspaceId: string } & Partial<
  Pick<MnemoEpisode, "title" | "narrative" | "topics" | "linkedFactIds" | "metadata">
>;

export interface EpisodeFilter {
  workspaceId: string;
  topics?: string[];
  participantId?: string;
  isSynthetic?: boolean;
  parentEpisodeId?: string; // NEW — direct children of this episode (spec §16 trees)
  after?: Date;
  before?: Date;
  /** P18 — asOf filter: validFrom <= validAt AND (validTo IS NULL OR validTo > validAt) */
  validAt?: Date;
  offset?: number;
  limit?: number;
}

export interface CreateEntityInput {
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  name: string;
  kind: MnemoEntity["kind"];
  aliases?: string[];
  canonicalId?: string;
  description?: string;
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export type UpdateEntityInput = { workspaceId: string } & Partial<
  Pick<
    MnemoEntity,
    "name" | "kind" | "aliases" | "metadata" | "linkedUserId" | "validTo" | "sensitivity"
  >
> & {
    /**
     * `null` explicitly clears the field (canonicalId: null = "this row is
     * canonical again"; description: null = "no description"); `undefined`
     * (omitted key) leaves it untouched. Widened beyond MnemoEntity's
     * (undefined-only) read shape to match the mutation semantics legacy
     * `CoreLike.updateEntity` already modeled (`description?: string | null`,
     * `canonicalId?: string | null`) — flatten-legacy-dual-core PR9a, found
     * while porting `routes/entities.ts patchEntityRoute` off `deps.core`.
     */
    description?: string | null;
    canonicalId?: string | null;
  };

/**
 * WP-6 / PRIM-2 — atomic bitemporal revision of ONE live entity: close it,
 * insert a successor carrying the same name/kind/aliases/description, record
 * the `supersedes` lineage relation (successor -> closed) and enqueue the
 * embedding upkeep, all in one transaction. Unlink and reassignment are this
 * operation with a different `linkedUserId`; doing them as separate calls lost
 * the entity whenever the second one failed.
 *
 * Throws `StorageNotFoundError` when the entity does not exist in the
 * workspace, and `StorageConflictError` when it is already closed or when the
 * successor would collide with a live row (name/kind, or the user's live link).
 * A conflict rolls everything back, including the close.
 */
export interface SupersedeEntityInput {
  workspaceId: string;
  /** The live entity to close. */
  id: string;
  successor: {
    /** `null` = the successor is not linked to any user (unlink). */
    linkedUserId: string | null;
    sensitivity?: Sensitivity;
    actorId?: string;
    userId?: string | null;
    actorType?: ActorType;
  };
}

export interface EntityFilter {
  workspaceId: string;
  kind?: MnemoEntity["kind"];
  /** Exact match on `name`. For substring search across name + aliases, use `q`. */
  name?: string;
  /**
   * Case-insensitive substring search across `name` AND `aliases`
   * (flatten-legacy-dual-core PR9a / D6.2) — mirrors legacy
   * `core/src/entity/query.ts`'s `listEntities` `q` filter. Distinct from
   * `name`, which stays exact-match.
   */
  q?: string;
  /** P18 — asOf filter: validFrom <= validAt AND (validTo IS NULL OR validTo > validAt) */
  validAt?: Date;
  /**
   * Only rows that are open now (`validTo IS NULL`), decided by the row alone.
   * This is the "current list" filter. `validAt: new Date()` is not: rows are
   * stamped by Postgres `now()`, so a server clock a few milliseconds behind
   * the database's hid a row created a moment earlier.
   */
  openOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface CreateStrategyInput {
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  /** Project/entity scope reference (e.g. 'project-x'). Mirrors mnemo_fact.scope_ref. */
  scopeRef?: string;
  trigger: string;
  action: string;
  context?: string;
  relatedFacts?: string[];
  attribution?: MnemoStrategy["attribution"];
  supersedesId?: string;
  validFrom?: Date;
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export type UpdateStrategyInput = { workspaceId: string } & Partial<
  Pick<
    MnemoStrategy,
    | "trigger"
    | "action"
    | "context"
    | "status"
    | "validTo"
    | "metadata"
    | "successCount"
    | "failureCount"
    | "worth"
    | "relatedFacts"
    | "attribution"
  >
>;

export interface StrategyFilter {
  workspaceId: string;
  status?: MnemoStrategy["status"];
  /** When set, return records with scope_ref = X OR scope_ref IS NULL. */
  scopeRef?: string;
  /**
   * P135: other spellings of the project `scopeRef` names (its canonical name
   * and aliases). A row matches when its scope_ref is `scopeRef` or any of
   * these. Filled by the core from the workspace's `project` entities, never
   * by callers; ignored without `scopeRef`.
   */
  scopeRefAliases?: string[];
  validAt?: Date;
  /** Only rows open now (`validTo IS NULL`): the clock-free "current" filter (see EntityFilter.openOnly). */
  openOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface CreateWorkflowInput {
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  /** Project/entity scope reference (e.g. 'project-x'). Mirrors mnemo_fact.scope_ref. */
  scopeRef?: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export type UpdateWorkflowInput = { workspaceId: string } & Partial<
  Pick<MnemoWorkflow, "name" | "description" | "steps" | "status" | "metadata">
>;

export interface WorkflowFilter {
  workspaceId: string;
  status?: MnemoWorkflow["status"];
  /** When set, return records with scope_ref = X OR scope_ref IS NULL. */
  scopeRef?: string;
  /**
   * P135: other spellings of the project `scopeRef` names (its canonical name
   * and aliases). A row matches when its scope_ref is `scopeRef` or any of
   * these. Filled by the core from the workspace's `project` entities, never
   * by callers; ignored without `scopeRef`.
   */
  scopeRefAliases?: string[];
  /** P18 — asOf filter: validFrom <= validAt AND (validTo IS NULL OR validTo > validAt) */
  validAt?: Date;
  /** Only rows open now (`validTo IS NULL`): the clock-free "current" filter (see EntityFilter.openOnly). */
  openOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface CreateSkillInput {
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  name: string;
  promptTemplate: string;
  variables?: string[];
  requiredContext?: string[];
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export type UpdateSkillInput = { workspaceId: string } & Partial<
  Pick<MnemoSkill, "name" | "promptTemplate" | "variables" | "requiredContext" | "metadata">
>;

export interface SkillFilter {
  workspaceId: string;
  /** P18 — asOf filter: validFrom <= validAt AND (validTo IS NULL OR validTo > validAt) */
  validAt?: Date;
  /** Only rows open now (`validTo IS NULL`): the clock-free "current" filter (see EntityFilter.openOnly). */
  openOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface CreateTaskInput {
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  title: string;
  description?: string;
  priority?: MnemoTask["priority"];
  assignedTo: string;
  sessionId?: string;
  parentTaskId?: string;
  dueAt?: Date;
  delegatedBy?: string;
  relatedFacts?: string[];
  relatedEntities?: string[];
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export interface DelegateTaskInput {
  assignedTo: string;
  delegatedBy: string;
}

export type UpdateTaskInput = { workspaceId: string } & Partial<
  Pick<
    MnemoTask,
    | "title"
    | "description"
    | "status"
    | "priority"
    | "assignedTo"
    | "blockedBy"
    | "subtaskIds"
    | "outcome"
    | "lessonsLearned"
    | "startedAt"
    | "completedAt"
    | "dueAt"
    | "metadata"
  >
>;

export interface TaskFilter {
  workspaceId: string;
  status?: MnemoTask["status"];
  assignedTo?: string;
  parentTaskId?: string;
  /** P18 — asOf filter: validFrom <= validAt AND (validTo IS NULL OR validTo > validAt) */
  validAt?: Date;
  /** Only rows open now (`validTo IS NULL`): the clock-free "current" filter (see EntityFilter.openOnly). */
  openOnly?: boolean;
  offset?: number;
  limit?: number;
}

/**
 * B7 — the task statuses with no outgoing transitions (mirrors
 * `TASK_TRANSITIONS` entries that are `[]` in `@mnemo-ai/core`'s
 * `cognitive/tasks.ts`). Lives here, not in `@mnemo-ai/core`, because
 * storage adapters (`@mnemo-ai/adapter-postgres`, the in-memory test
 * adapter) implement `archiveTask` and must stay terminal-aware without
 * importing core. `core/cognitive/__tests__/task-state-machine.test.ts`
 * asserts this set equals the derived terminal set — single source of
 * truth enforced by test, not by re-exporting from core.
 */
export const TERMINAL_TASK_STATUSES = ["completed", "cancelled"] as const;

export interface CreateEventInput {
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  type: MnemoEvent["type"];
  name: string;
  description: string;
  occurredAt: Date;
  durationS?: number;
  source: string;
  relatedEntities?: string[];
  annotations?: EventAnnotation[];
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export interface EventFilter {
  workspaceId: string;
  type?: MnemoEvent["type"];
  source?: string;
  after?: Date;
  before?: Date;
  offset?: number;
  limit?: number;
}

export interface CreateReasoningInput {
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>". Defaults to "workspace:<workspaceId>". */
  scopeOwner?: string;
  question: string;
  chain: MnemoReasoning["chain"];
  conclusion: string;
  topicKey?: string;
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
}

export type UpdateReasoningInput = { workspaceId: string } & Partial<
  Pick<MnemoReasoning, "status" | "chain" | "conclusion" | "metadata">
>;

export interface ReasoningFilter {
  workspaceId: string;
  status?: MnemoReasoning["status"];
  topicKey?: string;
  /** PRIM-16 — validFrom <= validAt AND (validTo IS NULL OR validTo > validAt): current rows. */
  validAt?: Date;
  /** Only rows open now (`validTo IS NULL`): the clock-free "current" filter (see EntityFilter.openOnly). */
  openOnly?: boolean;
  offset?: number;
  limit?: number;
}

// ── Hyperedges ──────────────────────────────────────────────────────────────

export interface CreateHyperedgeInput {
  workspaceId: string;
  memberIds: string[];
  label?: string;
  description?: string;
  contextQuery?: string;
  contextEmbedding?: Float32Array;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /**
   * WP-6 / PRIM-13: also require every member id to exist in this workspace
   * (any primitive kind). Off by default so internal writers that already hold
   * real ids pay nothing; the HTTP route turns it on. Repeated members are
   * rejected either way (`StorageValidationError`).
   */
  verifyMembers?: boolean;
  /**
   * With `verifyMembers`: the caller's sensitivity ceiling. A member above it is
   * treated exactly like a nonexistent one (same error, no ids), so member
   * validation is not an existence oracle across sensitivity levels. Omitted =
   * no ceiling (trusted internal callers).
   */
  maxSensitivity?: Sensitivity;
}

export type UpdateHyperedgeInput = Partial<
  Pick<MnemoHyperedge, "label" | "description" | "contextQuery">
> & {
  /**
   * WP-6 / PRIM-12: the workspace the hyperedge belongs to. The update has to
   * set the RLS workspace GUC BEFORE reading the row; without it the lookup
   * ran as no workspace and every PATCH failed under the production role.
   * Optional only for backward compatibility with callers that predate it.
   */
  workspaceId?: string;
};

export interface HyperedgeFilter {
  workspaceId: string;
  memberId?: string;
  label?: string;
  /** Include closed (deleted) hyperedges. Default false: only open ones. */
  includeClosed?: boolean;
  /**
   * The caller's ceiling: a hyperedge with any member above it is left out of
   * the page and of `total`. Member ids that resolve to no row don't hide it.
   */
  maxSensitivity?: Sensitivity;
  offset?: number;
  limit?: number;
}

// ── Composition rules ───────────────────────────────────────────────────────

export interface CreateCompositionRuleInput {
  workspaceId: string;
  name: string;
  description?: string;
  conditionDsl: unknown;
  actionDsl: unknown;
  priority?: number;
  isActive?: boolean;
  createdBy?: string;
  source?: MnemoCompositionRule["source"];
  metadata?: Record<string, unknown>;
}

export type UpdateCompositionRuleInput = Partial<
  Pick<
    MnemoCompositionRule,
    "name" | "description" | "conditionDsl" | "actionDsl" | "priority" | "isActive" | "metadata"
  >
>;

export interface CompositionRuleFilter {
  workspaceId: string;
  isActive?: boolean;
  source?: MnemoCompositionRule["source"];
  offset?: number;
  limit?: number;
}

// ── Inference log ───────────────────────────────────────────────────────────

export interface AppendInferenceInput {
  workspaceId: string;
  ruleId: string;
  inputFactIds: string[];
  derivedKind?: string;
  derivedId?: string;
  confidence: number;
  rationale?: string;
  triggeredByQuery?: string;
  conversationId?: string;
}

export interface MaterialiseInferenceInput {
  ruleId: string;
  workspaceId: string;
  fact: {
    scope: string;
    kind: string;
    subject: string;
    statement: string;
    attribution: string;
    sensitivity: Sensitivity;
    metadata: Record<string, unknown>;
  };
  inferenceLog: {
    inputFactIds: string[];
    derivedKind: string;
    confidence: number;
    rationale: string;
    triggeredByQuery?: string;
    conversationId?: string;
  };
}

export interface InferenceLogFilter {
  workspaceId: string;
  ruleId?: string;
  derivedId?: string;
  since?: Date;
  offset?: number;
  limit?: number;
}

// ── Fact hash ───────────────────────────────────────────────────────────────

export interface UpsertFactHashInput {
  workspaceId: string;
  statementHash: string;
  factId: string;
}

export interface CreateRelationInput {
  workspaceId: string;
  sourceId: string;
  sourceType: RelationNodeKind;
  targetId: string;
  targetType: RelationNodeKind;
  verb: RelationVerb;
  weight?: number;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;

  /**
   * flatten-legacy-dual-core D6.4 — the judgment-workflow overlay on the
   * SAME physical `mnemo_relation` row. All optional: DB defaults stay
   * authoritative when omitted (`judgmentStatus: 'pending'`,
   * `markedByKind: 'system'`, everything else `null`). `evidence` is the
   * real physical column — there is no separate `metadata` field.
   */
  judgmentStatus?: JudgmentStatus;
  reason?: string | null;
  evidence?: Record<string, unknown> | null;
  confidence?: number | null;
  markedByUserId?: string | null;
  markedByKind?: MarkerKind;
  markedByModel?: string | null;
  markedByPromptVersion?: string | null;
  provenance?: string | null;
  conversationId?: string | null;
  supersededByRelationId?: string | null;
  validFrom?: Date;
  validTo?: Date | null;
}

export interface RelationFilter {
  workspaceId: string;
  sourceId?: string;
  targetId?: string;
  /** TRAVERSE-1 batched BFS layer — routes/relations.ts already needs this. */
  sourceIds?: string[];
  /**
   * flatten-legacy-dual-core PR9f (design.md D6.5) — the batched-BFS
   * counterpart of `sourceIds`, matching a frontier node against the
   * `targetId` column. `mnemo_relation` is a single directed row per pair;
   * legacy `traverseRelations`/`findShortestPath` treat it as UNDIRECTED
   * (`r.source_id = node OR r.target_id = node`). `sourceIds` alone would
   * silently miss every edge where the frontier node happens to be stored
   * in the `target_id` column — `traverseGraph`/`findGraphPath` query both
   * batched filters per hop to reproduce the exact undirected semantics.
   */
  targetIds?: string[];
  verb?: RelationVerb;
  verbs?: RelationVerb[];
  judgmentStatus?: JudgmentStatus;
  /** Bitemporal point-in-time filter: `validFrom <= validAt AND (validTo IS NULL OR validTo > validAt)`. */
  validAt?: Date;
  /**
   * Only relations that are open now (`validTo IS NULL`). Defaults to true
   * unless `validAt` is given: a relation closed by a delete or a hard delete
   * is not part of the current graph (PRIM-12, PRIM-13). Readers that need
   * the history (export, lineage, conflict bookkeeping) pass `false`.
   */
  openOnly?: boolean;
  /**
   * The caller's sensitivity ceiling. A relation whose source or target row is
   * above it is left out (before `limit`), so a capped walk never reaches, names
   * or counts a node it may not see. Ids that resolve to no row still pass.
   */
  maxSensitivity?: Sensitivity;
  limit?: number;
}

/**
 * flatten-legacy-dual-core D6.4 — apply a judgment decision to an existing
 * relation (PATCH /relations/:id equivalent, wired by PR 9d). Always sets
 * `judgmentStatus: "judged"` on the target row; every other field is set
 * only when provided. Returns `null` when the row does not exist in this
 * workspace (never throws for "not found").
 */
export interface ApplyRelationJudgmentInput {
  workspaceId: string;
  id: string;
  relation: RelationVerb;
  reason?: string;
  evidence?: Record<string, unknown>;
  confidence?: number;
  markedByKind: MarkerKind;
  markedByUserId?: string | null;
  markedByModel?: string;
  markedByPromptVersion?: string;
  /** The caller's ceiling: a relation with an endpoint above it reads as missing (`null`). */
  maxSensitivity?: Sensitivity;
}

/**
 * flatten-legacy-dual-core Slice 3c (B5, design.md's "Coordination decision").
 *
 * `routes/conflicts.ts`'s `POST /conflicts/:id/resolve` chains up to 6 separate
 * writes (close 1-2 facts, optionally create a merged fact, patch the judged
 * relation, create 1-2 `supersedes` relations). The legacy `CoreLike` chained
 * 6 independently-committed calls — non-atomic, the exact bug this closes.
 * `MnemoRelation`/`CreateRelationInput`'s judgment-workflow fields have no v3
 * port equivalent for `patchRelation` (no v3 method at all) and only a subset
 * for `createRelation` (see PR8's disclosed `relations.ts` finding in
 * design.md's Open Questions) — reusing those generic methods here would
 * still need 4-6 separate calls, reintroducing the same non-atomicity. This
 * ONE composite method performs the whole resolution inside a single DB
 * transaction instead, matching the `FactRepository.replaceFact` precedent
 * (close + insert + relation-insert, one `db.transaction`).
 */
export type ConflictResolutionAction = "supersede_a" | "supersede_b" | "keep_both" | "merge";

export interface ResolveConflictInput {
  workspaceId: string;
  /** The existing `conflicts_with` relation id being resolved. */
  relationId: string;
  sourceId: string;
  sourceKind: string;
  targetId: string;
  targetKind: string;
  action: ConflictResolutionAction;
  /** Required when action === "merge". */
  mergedStatement?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
}

export interface ResolveConflictResult {
  /** The newly created merged fact's id, only when action === "merge". */
  mergedFactId: string | null;
}

export interface RecallLogEntry {
  workspaceId: string;
  factId: string;
  sessionId?: string;
  queryText?: string;
  hitRank?: number;
  tdCredit?: number;
  activationScore?: number;
  latencyMs?: number; // Wall-clock recall latency in ms; NULL for legacy rows
}

// ─── harden-hooks-and-measure-precision (Slice 4, A2-read) — precision-at-k ──
//
// Requirement 5/6: "of the hits served at rank < k, what fraction went on to
// receive TD(λ) credit ... in the same session." Derived ENTIRELY from
// already-persisted `mnemo_recall_log` + `mnemo_session` columns — no new
// write path, no port write method, no schema migration. See
// openspec/harden-hooks-and-measure-precision/design.md for the full
// data-mapping, the exact definition of "credited", and documented
// limitations of this coarse proxy.

/** One k value's precision figure, always paired with its sample size. */
export interface RecallPrecisionAtK {
  k: number;
  /** null when sampleSize is 0 — never a fabricated 0 or 1 (Requirement 5). */
  precision: number | null;
  /** Count of hits at hitRank < k whose session resolved (collapsed). */
  sampleSize: number;
}

/** Fixed caveat text returned on every {@link RecallPrecisionReport} — Requirement 6. */
export const RECALL_PRECISION_METHODOLOGY_NOTE =
  "TD(λ) credit is a coarse session-level proxy, not per-hit attribution: a hit " +
  'counts as "credited" only when its session collapsed AND created at least one ' +
  "fact, and the hit falls within the 20-most-recently-recalled window that " +
  "propagateTdCredit actually reads (mnemo_session.fact_count > 0, recency rank " +
  "≤ 20 within its session) — not because this specific hit was verified to " +
  "shape that fact. Hits whose session never collapsed are excluded from every " +
  "denominator, not counted as failures (design.md). Per-hit attribution requires " +
  "the D5 citation write path, which is out of scope for this report.";

/** Requirement 5/6 report shape — see {@link RecallPort.getRecallPrecision}. */
export interface RecallPrecisionReport {
  workspaceId: string;
  computedAt: Date;
  /** All mnemo_recall_log rows considered (hitRank IS NOT NULL, sessionId IS NOT NULL). */
  totalHits: number;
  /** Hits whose session never collapsed — excluded from every precisionAtK denominator. */
  pendingHits: number;
  /** Precision at k = 1, 3, 5 (Requirement 5's "at least k ∈ {1, 3, 5}"). */
  precisionAtK: RecallPrecisionAtK[];
  /** true when every k has sampleSize === 0 (Requirement 5's insufficient-data scenario). */
  insufficientData: boolean;
  /** Always present; equal to {@link RECALL_PRECISION_METHODOLOGY_NOTE}. */
  methodologyNote: string;
}

// ─── Webhook types ────────────────────────────────────────────────────────────

export interface MnemoWebhookEndpoint {
  id: string;
  workspaceId: string;
  url: string;
  events: string[];
  secretHash: string;
  isActive: boolean;
  description: string | null;
  failureCount: number;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookEndpointInput {
  id: string;
  workspaceId: string;
  url: string;
  events: string[];
  secretHash: string;
  description?: string;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  events?: string[];
  isActive?: boolean;
  description?: string;
  /** Delivery-worker: increment failure count for 3-strike auto-disable. */
  failureCount?: number;
  /** Delivery-worker: set when endpoint is auto-disabled after 3 strikes. */
  disabledAt?: Date | null;
}

export interface MnemoWebhookDelivery {
  id: string;
  webhookId: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  responseStatus: number | null;
  responseBody: string | null;
  attempt: number;
  deliveredAt: Date | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
}

export interface CreateWebhookDeliveryInput {
  id: string;
  webhookId: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  responseStatus?: number;
  responseBody?: string;
  attempt?: number;
  deliveredAt?: Date;
}

// ─── Prospective memory (reminders) ──────────────────────────────────────────

export interface MnemoReminder {
  id: string;
  workspaceId: string;
  content: string;
  /** REMIND-1: nullable — a reminder may be time-only (no semantic condition). */
  condition: string | null;
  triggerAt: Date | null;
  status: "pending" | "triggered" | "dismissed";
  conditionEmbedding: number[] | null;
  triggeredAt: Date | null;
  dismissedAt: Date | null;
  /**
   * LIFECYCLE-6: when a recall first returned this reminder to an agent. Null
   * on a triggered reminder means it fired (by the poller, or by a recall that
   * failed to answer) and no agent has seen it yet.
   */
  deliveredAt?: Date | null;
  createdByAgentId: string | null;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReminderInput {
  id: string;
  workspaceId: string;
  content: string;
  /** REMIND-1: optional — a reminder needs at least one of condition/triggerAt. */
  condition?: string;
  triggerAt?: Date;
  conditionEmbedding?: number[];
  createdByAgentId?: string;
  /** The authenticating CREDENTIAL, namespaced ActorRef (e.g. "key:<id>"). */
  actorId?: string;
  /** The real mnemo_user.id behind the request, or null. */
  userId?: string | null;
  actorType?: ActorType;
}

// ─── Wave P: LSH Tier 2 types ────────────────────────────────────────────────

export interface LshBandValue {
  bandIdx: number;
  bandHash: bigint;
}

export interface UpsertFactLshInput {
  workspaceId: string;
  factId: string;
  revision: number;
  bands: LshBandValue[];
}

export type RecallPrimitiveValue =
  | MnemoFact
  | MnemoDecision
  | MnemoEpisode
  | MnemoEntity
  | MnemoStrategy
  | MnemoWorkflow
  | MnemoSkill
  | MnemoTask
  | MnemoEvent
  | MnemoReasoning;

export interface RecallPrimitiveRef {
  id: string;
  kind: Exclude<PrimitiveKind, "hyperedge">;
}

export interface RecallPrimitiveRecord extends RecallPrimitiveRef {
  value: RecallPrimitiveValue;
}

export interface RecallLogRecord {
  memoryId: string;
  id: string;
  recalledAt: string;
  recallScore: number;
}

export interface RecallStructures {
  relations: MnemoRelation[];
  hyperedges: Array<{ memberId: string; hyperedge: MnemoHyperedge }>;
}

export interface PointerCandidateQuery {
  workspaceId: string;
  terms: string[];
  bands: LshBandValue[];
  limit: number;
  filter?: RecallFilter;
  includeArchived?: boolean;
  includeLowWorth?: boolean;
  /** Recall-only: retry an empty strict FTS result with two content-term matches. */
  relaxedOnEmpty?: boolean;
  /**
   * Point-in-time recall: only rows whose validity interval contains this
   * instant (`validFrom <= asOf AND (validTo IS NULL OR validTo > asOf)`),
   * whatever their status now. Replaces the "current rows" gate and
   * `includeArchived`.
   */
  asOf?: Date;
}

export interface PointerCandidate {
  factId: string;
  statement: string;
  embedding: number[] | null;
  sensitivity: Sensitivity;
  worth: number;
  worthAlpha?: number;
  worthBeta?: number;
  /** Judged observations; both 0 means untested (see isUntestedWorth). */
  worthSuccess?: number;
  worthFailure?: number;
  attribution: Provenance;
  createdAt: Date;
  validFrom?: Date;
  status: MnemoFact["status"];
  validTo: Date | null;
  confidence?: number;
  tags?: string[];
  scope?: MnemoFact["scope"];
  scopeRef?: string;
  actorId?: string | null;
  /**
   * Platform account behind the write, when one exists. NOTE: as of the
   * provenance-identity fix (migration 0023), the storage-adapter query that
   * populates PointerCandidate has not yet been updated to select user_id —
   * this field will read undefined via that path until it is. Present here
   * so the recall-cold.ts FTS hit mapper is ready to carry it through once
   * the adapter catches up.
   */
  userId?: string | null;
  actorType?: ActorType;
  entityId?: string;
  sessionId?: string;
  /** Ownership label ("workspace:<id>" | "user:<id>" | "tenant:<id>"); absent on legacy rows. */
  scopeOwner?: string;
  /** The fact's topicKey, when it has one — shown on recall hits so a writer can reuse it. */
  topicKey?: string;
  subject?: string;
}

export interface FtsCandidate extends PointerCandidate {
  rank: number;
}

/**
 * make-primitives-recallable (design.md D4/Interfaces) — one candidate hit
 * from `StorageAdapter.recallableCandidates?()`. Deliberately NOT an
 * `FtsCandidate`/`PointerCandidate` extension: those two are irreducibly
 * fact-shaped (`factId`, `statement`, `worth`, `attribution`,
 * `status: MnemoFact["status"]`); reshaping them to fit a decision would move
 * the fact ranking path this change must leave untouched. `score` is either a
 * cosine similarity in [0,1] (semantic arm) or a `ts_rank` value (lexical
 * arm) — the caller (recall-cold.ts, PR4) decides how the two are compared
 * and damped, this port method only reports which arm(s) produced a match.
 */
export interface PrimitiveCandidate {
  id: string;
  kind: PrimitiveKind;
  score: number;
  sensitivity: Sensitivity;
  /**
   * WP-3: the evidence behind `score`, kept per arm. `score` is the larger of
   * the two when both arms matched, which mixes a cosine with a `ts_rank`; a
   * caller that ranks across kinds needs them apart. Optional so an adapter
   * that predates them still works: recall-cold then reads `score` as the
   * cosine when it sent no `terms`.
   */
  similarity?: number;
  lexicalRank?: number;
}

/**
 * Query for `StorageAdapter.recallableCandidates?()`. `kinds` DRIVES which
 * table(s) are searched — it is not a post-filter — so `kinds: ["decision"]`
 * searches only `mnemo_decision`, never facts. Supply `embedding` for the
 * semantic (cosine) arm, `terms` for the lexical (`ts_rank`) arm, either or
 * both; supplying neither returns `[]` without issuing a query.
 */
export interface PrimitiveCandidateQuery {
  workspaceId: string;
  kinds: PrimitiveKind[];
  limit: number;
  embedding?: number[];
  minSimilarity?: number;
  terms?: string[];
  /**
   * RECALL-7: when the strict lexical match (every term) finds nothing for a
   * kind, retry with rows matching at least two distinct content terms — the
   * fallback the fact FTS arm already has. Recall sets it; default off.
   */
  relaxedOnEmpty?: boolean;
  /**
   * RECALL-6: exact ownership label, applied in both arms before `limit`, so a
   * personal-only recall is not starved by a window full of workspace rows.
   */
  scopeOwner?: string;
  /** Point-in-time recall: rows valid at this instant instead of the live ones. */
  asOf?: Date;
}

/** Query for `StorageAdapter.federatedRecallCandidates?()`. */
export interface FederatedRecallQuery {
  workspaceId: string;
  terms: string[];
  limit: number;
  /** The tiers the caller may read; a row at any other tier is never returned. */
  sensitivity: Sensitivity[];
}

/** One federated item that matched a recall, as the receiving server stored it. */
export interface FederatedRecallCandidate {
  /** The item's id on this server (`local_id`). */
  id: string;
  /** The peer it came from, as that peer named itself. */
  peerDomain: string;
  statement: string;
  /** The tier the peer gave it; anything but the four tiers reads as `restricted`. */
  sensitivity: Sensitivity;
  /** ISO timestamps as the peer sent them; the caller drops unparseable ones. */
  validFrom: string | null;
  validTo: string | null;
  /** `ts_rank` of the match. */
  lexicalRank: number;
}

export interface ConsolidationWorthSnapshot {
  alpha: number;
  beta: number;
  success: number;
  failure: number;
}

export interface ConsolidationMergeSnapshot {
  operationId: string;
  workspaceId: string;
  survivorId: string;
  absorbedFactIds: string[];
  previousWorth: ConsolidationWorthSnapshot;
  expectedMergedWorth: ConsolidationWorthSnapshot;
}

export interface ApplyConsolidationMergeInput {
  operationId: string;
  workspaceId: string;
  survivorId: string;
  absorbedFactIds: string[];
  leaseExpiresAt: Date;
}

export interface ReplayFailureReview {
  reason: "replay_validation_failed" | "replay_execution_failed";
  passCount: number;
  failCount: number;
  queriesUsed: string[];
}

// ── SOC2 CF3 — Retention purge ──────────────────────────────────────────────

/**
 * Filter passed to StorageAdapter.purgeFacts?().
 * Caller MUST never pass sensitivity='public' (spec: public facts are never purged).
 */
export interface PurgeFactsFilter {
  workspaceId: string;
  /** The sensitivity tier to purge. Must not be 'public'. */
  sensitivity: Sensitivity;
  /** Soft-close facts with createdAt < now() - olderThanDays. */
  olderThanDays: number;
  /**
   * When true: count matching rows and compute erase candidates but do NOT
   * execute any UPDATE or append any deletion-log row.
   */
  dryRun?: boolean;
  /** Max rows updated per call (default 500). Bounds transaction length. */
  limit?: number;
}

/**
 * Result returned by StorageAdapter.purgeFacts?().
 */
export interface PurgeFactsResult {
  /** Number of fact rows whose status was set to 'forgotten' (0 in dry-run). */
  softClosed: number;
  /**
   * actorIds whose encrypted facts (confidential + restricted combined) all
   * have validTo IS NOT NULL after this purge — safe to call destroyActorDek.
   * Always empty when sensitivity='internal' (no DEK for plaintext tier).
   * Always empty in dry-run mode.
   */
  eraseCandidateActorIds: string[];
  /**
   * userIds (the platform account behind a write, when one exists) whose
   * encrypted facts — across EVERY actorId/key they've used — all have
   * validTo IS NOT NULL after this purge. Safe to call destroyUserDeks,
   * which destroys ALL of that person's DEKs in one call (a person with
   * multiple keys has multiple actor-keyed DEKs; this is what makes erasure
   * actually per-person instead of per-credential). Always empty when
   * sensitivity='internal' or in dry-run mode, same as eraseCandidateActorIds.
   */
  eraseCandidateUserIds: string[];
}

// ─── StorageAdapter ───────────────────────────────────────────────────────────

export interface StorageCapabilities {
  vectorSearch: boolean;
  ftsSearch: boolean;
  bitemporal: boolean;
  graphExpansion: boolean;
  transactions: boolean;
  rls: boolean;
}

export interface HarnessIngestionPort {
  ingestHarnessEvent(input: {
    workspaceId: string;
    provenance: ManagedSessionProvenance;
    event: HarnessEvent;
    receivedAt: Date;
  }): Promise<HarnessEventAck>;
}

export interface ManagedSessionLifecyclePort {
  claimManagedSessions(input: {
    workspaceId: string;
    leaseOwner: string;
    limit: number;
    inactivityMs: number;
    provisionalGraceMs: number;
    leaseMs: number;
  }): Promise<ManagedSessionClaim[]>;
  markManagedCollapseRetry(input: {
    workspaceId: string;
    sessionId: string;
    leaseOwner: string;
    error: string;
    baseRetryMs: number;
    maxRetryMs: number;
  }): Promise<ManagedCollapseRetry | null>;
  finalizeManagedArchive(input: {
    workspaceId: string;
    sessionId: string;
    leaseOwner: string;
    operationId: string;
    reason: ManagedArchiveReason;
  }): Promise<boolean>;
  releaseExpiredManagedLeases(input: { workspaceId: string }): Promise<number>;
  retryLegacyManagedArchive(input: { workspaceId: string; sessionId: string }): Promise<boolean>;
  quiesceManagedLifecycle(input: { workspaceId: string }): Promise<ManagedLifecycleQuiesceResult>;
  listManagedCollapseTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]>;
  purgeManagedTurns(input: {
    workspaceId: string;
    terminalBefore: Date;
    limit: number;
  }): Promise<number>;

  /**
   * Cross-workspace managed lifecycle aggregate for scrape-time gauges.
   *
   * Deliberately a storage read rather than in-process counters: a counter only
   * knows what this replica saw since it started, which after a restart or beside
   * a second replica is not the state of the system.
   *
   * Returns only bounded, non-identifying groupings — never a workspace or
   * session id, which would become an unbounded Prometheus label.
   */
  /**
   * Erase the managed transcript behind an episode, tombstoning and auditing it
   * exactly as retention would but attributed to the caller.
   *
   * Exists as a port rather than route SQL so the governance rule — forgetting
   * knowledge also forgets the words that produced it — lives in one place and
   * cannot be half-applied by a caller that forgets to do it.
   */
  forgetManagedTranscriptForEpisode?(input: {
    workspaceId: string;
    episodeId: string;
    actorId: string;
  }): Promise<{ sessionId: string | null; turnsRemoved: number }>;

  /** Managed session metadata for a workspace export. Never includes content. */
  exportManagedSessions?(input: { workspaceId: string; limit: number }): Promise<
    Array<{
      sessionId: string;
      sourceHost: string;
      status: string;
      turnCount: number;
      startedAt: string | null;
      collapsedAt: string | null;
      archivedAt: string | null;
      archiveReason: string | null;
      captureIncomplete: boolean;
    }>
  >;

  /** Raw managed transcripts still held — a turn retention erased is simply absent. */
  exportManagedTranscripts?(input: { workspaceId: string; limit: number }): Promise<
    Array<{
      sessionId: string;
      turnIndex: number;
      role: string;
      content: string;
      sourceMessageId: string | null;
      createdAt: string | null;
    }>
  >;

  managedLifecycleStats?(): Promise<{
    active: number;
    pending: number;
    collapsed: number;
    archivedByReason: Array<{ reason: string; count: number }>;
    retryBuckets: Array<{ bucket: string; count: number }>;
    oldestPendingAgeSeconds: number | null;
    messageCountBuckets: Array<{ bucket: string; count: number }>;
    extraction: Array<{ result: string; count: number }>;
    incompleteCapture: number;
  }>;
}

// ─── segregate-storage-ports — narrow domain sub-ports (PR1, Phase 1 group A) ──
//
// PR1 of a stacked chain (design.md/tasks.md `segregate-storage-ports`) additively
// extracts Port Map rows 1-8 as named interfaces below. Every member's name,
// signature, optionality, and doc comment is copied VERBATIM from its original home
// in the flat `StorageAdapter` interface further down this file — nothing here is a
// behavior change. The flat `StorageAdapter` interface is intentionally left
// completely untouched in this PR (zero deletions); groups B-E (the remaining 30
// domain ports) and the final `StorageAdapter` intersection alias land in later PRs
// in this chain (tasks 1.4-1.11). See design.md D3/D4 for placement rationale and
// the per-method override table.

/** Session lifecycle: create, append turns, close, scratch pad, and dedup lookups. */
export interface SessionPort {
  createSession(input: CreateSessionInput): Promise<MnemoSession>;
  /**
   * Sessions started and episodes remembered in the last `days` UTC days. See
   * {@link SessionStats}. Episodes and their linked facts above `maxSensitivity`
   * are not counted; sessions carry no content and are all counted.
   */
  getSessionStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<SessionStats>;
  appendTurn(sessionId: string, turn: Omit<SessionTurn, "id" | "createdAt">): Promise<number>;
  listTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]>;
  closeSession(id: string, workspaceId: string): Promise<void>;
  recordCollapseFailure?(id: string, workspaceId: string, error: string): Promise<void>;
  /**
   * LIFECYCLE-7/8 — atomic, single-winner persistence of an ORDINARY
   * (non-managed) session collapse.
   *
   * Opens ONE workspace-scoped transaction and locks the session row. When the
   * session is missing, managed (`source_host` set) or already `collapsed`, it
   * returns `{ committed: false, status }` WITHOUT calling `apply`. Otherwise it
   * runs `apply` with a StorageAdapter bound to that transaction, then marks the
   * session `collapsed` in the same transaction and returns
   * `{ committed: true, value }`. A throw from `apply` rolls back every write it
   * made and leaves the session as it was, so the collapse can be retried.
   *
   * `apply` must only write: no model calls while the transaction is open.
   * Optional — callers fall back to the non-atomic write sequence + closeSession.
   *
   * `terminalStatus: "archived"` (review round) is the SKIPPED collapse's
   * commit: same lock and refusal rules, but the session ends `archived`, with
   * `archiveReason` stamped as `metadata.archiveReason`. Default `collapsed`.
   *
   * `topicLocks` (review round): the fact and decision topic keys `apply` will
   * create or merge. The adapter takes their locks in ONE sorted order right
   * after the session lock, before `apply` runs, so two collapses touching the
   * same topics in different orders queue instead of deadlocking.
   */
  commitSessionCollapse?<T>(
    input: {
      workspaceId: string;
      sessionId: string;
      /** Abort a stale snapshot before writing any extracted knowledge. */
      expectedTurnCount?: number;
      terminalStatus?: "collapsed" | "archived";
      archiveReason?: string;
      topicLocks?: { facts: string[]; decisions: string[] };
    },
    apply: (storage: StorageAdapter) => Promise<T>
  ): Promise<{ committed: true; value: T } | { committed: false; status: string | null }>;
  /**
   * §7 discard — archive a session WITHOUT collapsing it into durable knowledge.
   * Sets status='archived' (distinct from closeSession's 'collapsed') and leaves
   * context_snapshot null. Optional for backward-compat; callers guard with `?.`.
   *
   * `reason` (LIFECYCLE-14) is stamped as `metadata.archiveReason`, e.g.
   * `collapse_failed` when the sweep gave up after its last attempt. It is not
   * the managed `archive_reason` column, whose CHECK lists managed reasons only.
   */
  archiveSession?(id: string, workspaceId: string, reason?: string): Promise<void>;
  getSession(id: string, workspaceId: string): Promise<MnemoSession | null>;
  listSessions?(workspaceId: string, limit?: number, offset?: number): Promise<MnemoSession[]>;

  /**
   * Persist the explicit outcome rating a user gave a session.
   *
   * `mnemo_session.outcome_rating` has existed since the baseline migration,
   * constrained to 'success' | 'failure' | 'neutral', and is read by three
   * consumers: the `mnemo_metacognition_trends` SQL function (it *is*
   * `sessionCollapseQuality`), PluginRepository's §14 scored-trajectory list,
   * and MeteringRepository. No code ever wrote it — POST /session/:id/feedback
   * mapped the thumbs to a worth delta on the recalled facts and dropped the
   * session-level signal on the floor, so all three consumers read a column
   * that was permanently NULL.
   *
   * @returns true when a session row was updated, false when the id matched
   *          nothing in this workspace — the caller decides whether that is a
   *          404, rather than the write silently reporting success.
   */
  recordSessionOutcome(
    sessionId: string,
    workspaceId: string,
    rating: "success" | "failure" | "neutral"
  ): Promise<boolean>;
  updateSessionSummary?(args: {
    sessionId: string;
    workspaceId: string;
    summary: Record<string, unknown>;
    factCount: number;
  }): Promise<void>;
  /**
   * autonomous-memory Requirement 1/4 (session-correlation, compliance-backstop):
   * stamps `metadata.lastRecallAt` (ISO string) on the given session, merged
   * (not replaced) into whatever metadata already exists. Best-effort — the
   * caller (POST /recall) treats a failure here as non-fatal, matching the
   * existing anticipation-preinject pattern. Optional for backward-compat;
   * callers guard with `?.`. A no-op (never throws "not found") when the
   * session id doesn't exist in this workspace, since a stale/invalid
   * correlation id from a hook must never fail the recall it's attached to.
   */
  // NOTE (design D4): distinct from RecallPort.logRecall (ACT-R activation log)
  // and RecallPort.recordRecall (TD(λ) worth update) — both land in a later PR
  // in this chain (group C, task 1.5). This method stamps session metadata; it
  // never touches the recall log or worth-governance tables.
  recordSessionRecall?(sessionId: string, workspaceId: string): Promise<void>;
  /**
   * Pin or unpin one turn of a session, selected by id OR by ordinal index.
   *
   * Both selectors are first-class because `memory_session action:'pin_turn'`
   * has always advertised both, while nothing translated an index into an id —
   * the MCP tool did `args.turnId ?? String(args.turnIndex)`, so `turnIndex: 1`
   * reached SQL as the id `"1"` and blew up a uuid comparison with
   * `invalid input syntax for type uuid`. `mnemo_session_turn.turn_index` has
   * been populated all along; the index selector is one WHERE clause.
   *
   * Exactly one of `turnId` / `turnIndex` must be supplied. Note `turnIndex: 0`
   * is a legitimate selector (the first turn), so implementations must test it
   * with `!== undefined` rather than for truthiness.
   *
   * @returns whether a turn actually matched. Previously this returned void, so
   * a selector matching nothing was indistinguishable from success and the
   * route answered 204 for a turn that does not exist.
   */
  pinSessionTurn(input: {
    sessionId: string;
    workspaceId: string;
    turnId?: string;
    turnIndex?: number;
    pinned: boolean;
  }): Promise<boolean>;
  /**
   * flatten-legacy-dual-core Slice 3c pt.1 (PR10) — overwrite the session's
   * ephemeral scratch pad (`mnemo_session.scratch`, jsonb). Backs
   * `POST /session/:id/scratch` when no `SessionBuffer` is wired. Returns
   * false when the session doesn't exist in this workspace (route maps to 404).
   */
  replaceSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
    scratch: Record<string, unknown>;
  }): Promise<boolean>;
  /**
   * flatten-legacy-dual-core Phase 7 — read-side twin of
   * {@link replaceSessionScratch}. Backs the session-sweep background job's
   * `SessionScratchStore` wiring (`@mnemo-ai/server`'s `index.ts`), which
   * previously read scratch through the legacy `CoreLike.getSessionScratch`.
   * Returns `null` when the session doesn't exist in this workspace.
   */
  getSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<Record<string, unknown> | null>;
  /**
   * §22 Dedup gate — return distinct topic_keys for facts in a session that were
   * tagged with a specific extraction_source (e.g. "per_turn").
   *
   * Used by the hybrid collapse dedup gate to skip collapse outputs whose topic_key
   * already exists in the per-turn extraction set for the same session — preventing
   * the same knowledge from being written twice (once per-turn, once at collapse).
   *
   * OPTIONAL — when absent the dedup gate is skipped (collapse proceeds normally).
   * Callers MUST guard with `?.`.
   *
   * @param workspaceId  - scope the query to this workspace
   * @param sessionId    - only facts from this session
   * @param source       - extraction_source value (typically "per_turn")
   * @returns            - array of distinct topic_key strings (nulls excluded)
   */
  // D4 override: assigned to SessionPort, NOT WorkspacePort, despite this
  // method's original "RDD-4" comment header — it is a session+source scoped
  // dedup gate; the workspace repository was an incidental implementation
  // detail, not the domain this method answers.
  listSessionTopicKeysBySource?(
    workspaceId: string,
    sessionId: string,
    source: string
  ): Promise<string[]>;
}

/**
 * Fact CRUD, keyset paging, hard-delete, contradiction detection, and §11
 * governance (canonical flag, recalled-fact ids, provenance credit).
 */
export interface FactPort {
  createFact(input: CreateFactInput): Promise<MnemoFact>;
  getFact(id: string, workspaceId: string): Promise<MnemoFact | null>;
  updateFact(id: string, workspaceId: string, input: UpdateFactInput): Promise<MnemoFact | null>;
  mergeFactByTopicKey(input: MergeFactByTopicKeyInput): Promise<MnemoFact | null>;
  replaceFact(input: ReplaceFactInput): Promise<ReplaceFactResult | null>;
  /**
   * Close a live fact (`status = 'forgotten'`, `valid_to = now`).
   *
   * PRIM-3 / CHAOS-8: resolves `true` when THIS call closed the fact and
   * `false` when there was nothing to close — missing, already closed (a
   * repeat or the loser of a concurrent archive), or mid-consolidation. A
   * `false` call writes nothing. `void` is what adapters predating the flag
   * return; callers treat it as "closed".
   */
  archiveFact(id: string, workspaceId: string): Promise<boolean | void>;
  queryFacts(filter: FactFilter): Promise<PaginatedResult<MnemoFact>>;
  /**
   * CHAOS-7 — the live fact holding exactly this statement under the same
   * dedup key `uniq_mnemo_fact_dedup` enforces (workspace, scope, scopeRef,
   * subject, statement), or null. `remember()` calls it after losing that
   * index's race: the winner committed the row but not yet its content hash,
   * so the hash lookup cannot find it. Optional: adapters without a unique
   * dedup index never raise the race.
   */
  findLiveFactByStatement?(input: FindLiveFactByStatementInput): Promise<MnemoFact | null>;

  /**
   * PRIM-15 — the fact a previous POST /import created from export row
   * `importedId` (stored as `metadata.importedId`), open or closed, or null.
   * Searches the whole workspace: the import route used to scan only the first
   * page of `queryFacts`, so every re-import past 20 facts duplicated the row.
   * Optional — the route falls back to that scan when an adapter lacks it.
   */
  findFactByImportedId?(workspaceId: string, importedId: string): Promise<MnemoFact | null>;

  /**
   * P109 — bind a session's facts to the episode that session collapsed into,
   * populating `mnemo_fact.episode_id`.
   *
   * That column, and its FK to `mnemo_episode`, have existed since the baseline
   * migration, and `preferSourceEpisode` (core/src/cognitive/recall-cold.ts,
   * spec §17 "prefer source episode") reads it on every cold recall to surface
   * the richer episode above the bare fact. Nothing ever wrote it: the episode
   * is created at collapse step 7.5, AFTER the facts, and only ever recorded the
   * link on its own side (`mnemo_episode.linked_fact_ids`). So the enrichment
   * ran, found `episodeId` null on every hit, and returned unchanged — dead
   * machinery that looked wired.
   *
   * Keyed on `session_id` (indexed as `idx_fact_session`) rather than on an id
   * list, because it must cover both populations: the facts collapse extracts
   * AND the facts an agent wrote mid-session via remember(). Both carry the
   * session id; only the former is known to the caller as an id list.
   *
   * Only ever fills a NULL `episode_id` — it never re-points a fact already
   * bound to an episode — so re-running a collapse is idempotent.
   *
   * @returns how many facts were newly linked.
   */
  linkSessionFactsToEpisode(
    workspaceId: string,
    sessionId: string,
    episodeId: string
  ): Promise<number>;

  /**
   * flatten-legacy-dual-core PR9b (D6.3) — keyset-paginated fact list
   * backing `GET /facts`. Additive, NOT a replacement for {@link queryFacts}
   * (see the comment on {@link FactPageFilter}). REQUIRED — every adapter
   * implements it; it backs a first-class route, not an optional degrade.
   */
  queryFactsPage(filter: FactPageFilter): Promise<FactPage>;

  /**
   * Facts deleted outright (`hard` and `gdpr_erasure` rows of
   * mnemo_deletion_log whose fact is gone), oldest deletion first, keyset
   * paginated in the `{v, id}` cursor format of {@link queryFactsPage} sorted by
   * `updated_at`: `v` is the deletion time. `GET /memory/federation/items`
   * merges them into its fact stream as tombstones. `createdAt` is null on rows
   * written before migration 0068. Optional: without it no hard delete reaches
   * a peer.
   */
  queryDeletedFactsPage?(filter: {
    workspaceId: string;
    cursor?: string;
    deletedSince?: Date;
    limit: number;
  }): Promise<{ id: string; deletedAt: Date; createdAt: Date | null; cursor: string }[]>;

  /**
   * The latest creation time among the facts `GET /memory/federation/items`
   * served `peerId` in this workspace (migration 0070), or null if it served it
   * none. Bounds the tombstones that peer gets, whatever `knownCursor` it sends.
   * Optional: without it no tombstone is served.
   */
  federationServeMark?(workspaceId: string, peerId: string): Promise<Date | null>;
  /** Raises that mark to `servedUntil`; never lowers it. */
  raiseFederationServeMark?(workspaceId: string, peerId: string, servedUntil: Date): Promise<void>;

  /**
   * flatten-legacy-dual-core PR9b (D6.3) — hard DELETE of every
   * `status = 'forgotten'` fact row in the workspace, mirroring legacy
   * `purgeClosedFacts` (factory.ts). NOT GDPR erasure (no deletion-log entry,
   * no actor DEK crypto-erasure) — see `routes/facts.ts`'s `DELETE
   * /facts/purge` doc comment. Skips rows carrying the
   * `__mnemoConsolidationPending` marker, same guard every other write method
   * in this codebase uses. Distinct from {@link purgeFacts}, which is a SOFT
   * close (`SET status='forgotten'`) by sensitivity tier — the opposite
   * operation. REQUIRED — backs a first-class route.
   *
   * @returns the number of rows physically deleted.
   */
  // NOTE (design D4): this is the HARD delete path, distinct from
  // RetentionPort.purgeFacts? which is a SOFT retention close (sets
  // status='forgotten' by sensitivity tier, does not remove the row).
  //
  // P114: `actorId` is REQUIRED, not optional, and that is the point. This path
  // physically removes many rows at once and used to append nothing to
  // mnemo_deletion_log while the two single-row paths both did. An audit entry
  // needs an actor, so the type refuses to let a caller purge anonymously.
  // Pass a namespaced ActorRef from resolveProvenance() — never a bare id.
  purgeForgottenFacts(workspaceId: string, actorId: string): Promise<number>;

  /**
   * P72 — move a fact to another workspace, bitemporally and in one call.
   *
   * There is no `UPDATE ... SET workspace_id`, and there should not be: it would
   * rewrite history and leave a hole in the audit trail. This is the honest
   * remediation the two-step manual dance already implied — close the interval
   * in the wrong workspace, create the successor in the right one, and link
   * them with `supersedes` — done atomically so it cannot half-happen.
   *
   * Atomic across the workspace boundary because `mnemo_set_workspace` uses
   * `set_config(..., true)`, which is transaction-local and re-settable: one
   * transaction can adopt each workspace's RLS context in turn.
   *
   * The `supersedes` relation lives in the DESTINATION workspace. It has to live
   * in exactly one — RLS scopes relation rows too — and the destination is where
   * someone later asks "where did this come from?".
   *
   * Returns null when no active fact with that id exists in `fromWorkspaceId`.
   */
  relocateFact?(input: {
    id: string;
    fromWorkspaceId: string;
    toWorkspaceId: string;
    actorId: string;
    reason?: string;
  }): Promise<{ previousId: string; newId: string } | null>;

  /**
   * §33 Distributed Consensus — surface active facts that potentially
   * contradict a candidate fact, using the SAME matching as core
   * conflict/fact-candidate.ts: exact same-`subject` OR full-text overlap on
   * the statement, scoped to active facts in the workspace. Returns only the
   * fields the pure resolver (decideAutoResolution) needs, plus identity.
   *
   * This is the port surface that lets the port-only fact-write path
   * (core/v3 remember) run deterministic contradiction resolution without
   * importing drizzle. REQUIRED — every adapter implements it (the InMemory
   * test adapter does a substring/subject match).
   */
  findContradictingFacts(
    workspaceId: string,
    input: FindContradictingFactsInput
  ): Promise<ContradictingFact[]>;

  /** §11 governance: set/clear the canonical exemption flag. */
  // D4 override: assigned to FactPort (not wherever the old "§11 governance"
  // comment header implied) — no standalone governance table exists; this is
  // fact-scoped, same as getRecalledFactIds and getProvenanceCredit below.
  setCanonical(id: string, workspaceId: string, canonical: boolean): Promise<void>;
  /** §11 governance.propagate: fact IDs recalled in a session (for DAG seeding). */
  getRecalledFactIds(workspaceId: string, sessionId: string): Promise<string[]>;
  /**
   * §11 TD(λ): walk the provenance DAG (derived_from/part_of edges) backward from
   * `terminalIds`, returning each predecessor's decayed credit = lambda^depth.
   * Bounded by maxHops (spec line 1037, default 5). Cyclic-safe.
   */
  getProvenanceCredit(
    workspaceId: string,
    terminalIds: string[],
    lambda: number,
    maxHops: number
  ): Promise<Array<{ factId: string; credit: number }>>;
}

/**
 * SOC2/GDPR retention: hard delete, deletion-log audit trail, sensitivity-tier
 * soft purge, and actor/user DEK crypto-erasure.
 */
export interface RetentionPort {
  /**
   * Wave X — GDPR hard-delete: permanently removes the row from mnemo_fact.
   * MUST be called only after scope check ("memory:hard_delete").
   * Optional — guards with `?.` at call sites.
   *
   * Every call also closes the fact's open relations in the same transaction
   * (PRIM-13): an edge to a row that no longer exists was returned by traverse
   * as a dangling node.
   *
   * SEC-4: with `audit`, the same transaction also appends the
   * mnemo_deletion_log row and enqueues vector_delete + cache_bust, so the
   * physical delete can never commit without its trace. Callers that write
   * their own deletion log (cognitive/forget.ts) omit it.
   *
   * Resolves `false` when nothing was deleted (the row is mid-consolidation),
   * otherwise the deleted row's `createdAt` (0068: the deletion log keeps it so
   * federation can serve the deletion as a tombstone); adapters that predate
   * that resolve `true` or `void`.
   */
  hardDeleteFact?(
    id: string,
    workspaceId: string,
    audit?: { actorId: string; reason?: string }
  ): Promise<{ createdAt: Date } | boolean | void>;

  /**
   * Wave X — GDPR erasure audit: appends a row to mnemo_deletion_log.
   * Log is INSERT-only for app role (enforced by migration 0001).
   * Optional — guards with `?.` at call sites.
   */
  appendDeletionLog?(input: {
    workspaceId: string;
    deletedItemId: string;
    deletedItemType: string;
    deletionType: "soft" | "hard" | "gdpr_erasure" | "federation_tombstone" | "retention_purge";
    actorId: string;
    reason?: string;
    /** 0068 — a deleted fact's creation time; federation serves it as a tombstone only with it. */
    itemCreatedAt?: Date;
  }): Promise<void>;

  /**
   * SOC2 CF3 — bulk soft-close facts past their retention window for a given
   * sensitivity tier. Runs inside a single db.transaction with the workspace
   * GUC set; paginated at `limit` rows per call (default 500) to bound
   * transaction length. On dryRun=true counts rows without mutating any.
   *
   * Returns `eraseCandidateActorIds`: actors whose remaining active
   * confidential+restricted facts count reaches zero after this purge — safe
   * to call destroyActorDek on. Always empty for the internal tier (no DEK).
   *
   * Optional — callers guard with `?.`.
   */
  purgeFacts?(filter: PurgeFactsFilter): Promise<PurgeFactsResult>;

  /**
   * GDPR crypto-erasure — returns the base64-encoded encrypted DEK for an
   * active actor, or null if the DEK has been destroyed or never provisioned.
   * Already implemented in DrizzleStorageAdapter since Wave P/P1.2.
   */
  getActorDek?(workspaceId: string, actorId: string): Promise<string | null>;

  /**
   * GDPR crypto-erasure — destroys an actor's DEK (marks it 'destroyed' and
   * nulls the key material). Returns true if a live DEK was found and destroyed.
   * Already implemented in DrizzleStorageAdapter since Wave P/P1.2.
   */
  destroyActorDek?(workspaceId: string, actorId: string): Promise<boolean>;

  /**
   * GDPR crypto-erasure, person-scoped — destroys EVERY DEK belonging to a
   * platform user (mnemo_user.id), across every actor_id/API key they've
   * used. Returns the number of DEKs destroyed (0, 1, or more — a person
   * with multiple keys has multiple actor-keyed DEKs). This is what makes
   * erasure actually per-person instead of per-credential; destroyActorDek
   * alone only ever touches one credential's DEK. Optional — guard with `?.`.
   */
  destroyUserDeks?(workspaceId: string, userId: string): Promise<number>;
}

/** Consolidation merge apply/rollback/finalize lifecycle (memory consolidation pipeline). */
export interface ConsolidationPort {
  applyConsolidationMerge(
    input: ApplyConsolidationMergeInput
  ): Promise<ConsolidationMergeSnapshot | null>;
  rollbackConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    review: ReplayFailureReview;
  }): Promise<"rolled_back" | "conflict">;
  finalizeConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    applyReplayBoost: boolean;
  }): Promise<"finalized" | "conflict">;
  refreshConsolidationMergeLease(input: {
    snapshot: ConsolidationMergeSnapshot;
    leaseExpiresAt: Date;
  }): Promise<"refreshed" | "conflict">;
  inspectConsolidationMergeState(
    snapshot: ConsolidationMergeSnapshot
  ): Promise<"pending" | "restored" | "retained" | "divergent">;
  recoverExpiredConsolidationMerges(input: {
    workspaceId: string;
    expiredBefore: Date;
  }): Promise<number>;
}

// ── flatten-legacy-dual-core Slice 3c pt.1 (PR10) — active-learning review
// queue (Mnemosyne v1.3+, `mnemo_review_queue`). Distinct from the Wave Y
// §25.1 `enqueueReview`/`enqueueReviewItem` pair (DriftReviewPort below), which
// target a DIFFERENT physical table (`mnemo_review_item`, codebase-drift review).
// This one backs `GET/POST /review*` (routes/review.ts): a fact or
// decision queued for human triage, resolved with an optional atomic
// cascade to `status='forgotten'` on the linked fact.
export interface ActiveLearningReviewPort {
  listActiveLearningReview(filter: ActiveLearningReviewFilter): Promise<ActiveLearningReviewRow[]>;
  /** Cheap COUNT(*) of unresolved rows for the workspace. */
  countUnresolvedActiveLearningReview(workspaceId: string): Promise<number>;
  /**
   * Idempotent insert: exactly one of `factId`/`decisionId` must be supplied.
   * Returns the existing open row's id (inserted:false) when one already
   * targets the same source, so the two producers (extraction pipeline +
   * manual flag) never duplicate a row.
   */
  enqueueActiveLearningReview(
    input: EnqueueActiveLearningReviewInput
  ): Promise<EnqueueActiveLearningReviewResult>;
  /**
   * Atomically resolves the row and, for `resolution: 'forgotten'` on a
   * fact-sourced row, flips the linked fact's status to `'forgotten'` in the
   * SAME transaction. Idempotent: resolving an already-resolved row returns
   * `resolved: false` (the caller maps that to 404/409).
   */
  resolveActiveLearningReview(
    input: ResolveActiveLearningReviewInput
  ): Promise<ResolveActiveLearningReviewResult>;
}

/**
 * Wave Y §25.1 — codebase/config/infrastructure drift review queue
 * (`mnemo_review_item`). Enqueue a primitive for review, and query facts
 * that are candidates for drift verification.
 */
export interface DriftReviewPort {
  /**
   * §11 governance (demote path): enqueue a fact as an archive candidate for
   * human/automated review. OPTIONAL — callers must guard with `?.`.
   * The `mnemo_review_queue` table exists in the baseline migration.
   * Idempotent: no new row while one with the same primitive and reason is
   * still pending, so a sweep that re-flags every run files one review.
   */
  // NOTE (design D4): despite the doc comment above (inherited verbatim from
  // its original location) naming `mnemo_review_queue`, the production
  // DrizzleStorageAdapter delegates this method to `recall.enqueueReviewItem`,
  // which writes `mnemo_review_item` — the SAME table as enqueueReviewItem/
  // queryDriftCandidates below, not the ActiveLearningReviewPort table. The
  // adapter's executable behavior wins over its own doc comment (design D4);
  // this method is grouped here, not in ActiveLearningReviewPort.
  enqueueReview?(input: {
    workspaceId: string;
    primitiveKind: string;
    primitiveId: string;
    reason: string;
    priority?: number;
  }): Promise<void>;

  /** Enqueue a primitive for human/auto review (e.g. codebase drift). */
  enqueueReviewItem(input: {
    workspaceId: string;
    primitiveId: string;
    primitiveKind?: string;
    reason: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;

  /** Query facts that are codebase/config/infrastructure sourced (for drift verification). */
  queryDriftCandidates(workspaceId: string): Promise<
    Array<{
      id: string;
      statement: string;
      metadata: Record<string, unknown>;
      sensitivity: Sensitivity;
    }>
  >;
}

/**
 * §9 L3 — lookupQueryCache input. Matched exactly against `mnemo_query_cache`
 * (P59, design.md §3): the table has no HNSW index (dropped by migration
 * `0009`, deliberately not restored by `0010`), so a lookup is a bounded seq
 * scan over a freshness-windowed, `topK`-matched, workspace-shared candidate
 * set — see `FactRepository.lookupQueryCache` for the exact predicate set.
 */
export interface LookupQueryCacheInput {
  workspaceId: string;
  embedding: Float32Array;
  /** Minimum cosine similarity for a hit (core passes L3_COSINE = 0.95). */
  threshold: number;
  /** Requested result-set size; matched exactly against the stored entry. */
  topK: number;
  /** Entries older than this are not reusable (core passes L3_MAX_AGE_MS). */
  maxAgeMs: number;
}

/**
 * §9 L3 — insertQueryCache input (P59, design.md §3). Insert-only: the
 * physical table has no unique key, so there is no upsert semantics.
 */
export interface InsertQueryCacheInput {
  workspaceId: string;
  embedding: Float32Array;
  resultIds: string[];
  resultKinds: string[];
  topK: number;
}

/**
 * §9 L3 caching: semantic query-result cache (cosine>=0.95 shortcut) and
 * embedding LRU (avoid re-embedding identical text).
 */
export interface QueryCachePort {
  /**
   * §9 L3 — cosine>=threshold lookup against mnemo_query_cache; null on miss.
   * No ANN index exists on this column — see `LookupQueryCacheInput` above.
   */
  lookupQueryCache?(
    input: LookupQueryCacheInput
  ): Promise<{ resultIds: string[]; resultKinds: string[] } | null>;

  /**
   * §9 L3 — append one recall result set. Insert-only: the table has no
   * unique key to upsert against (P59, design.md D11).
   */
  insertQueryCache?(input: InsertQueryCacheInput): Promise<void>;

  /**
   * P68 — prune L3 rows older than `olderThanMs`, for one workspace.
   *
   * P59 chose Option A (insert-only, no eviction) deliberately: every eligible
   * recall appends a row and nothing removes it except replaceFact's whole-
   * workspace bust. Read cost stays bounded by the freshness window and the
   * 200-row cap on `idx_mnemo_qc_ws`, so the debt was storage, not latency —
   * and unbounded.
   *
   * Prunes on `created_at`, not `last_used_at`. Under today's insert-only
   * writes the two are identical, but P59 design.md D6 warns that a future
   * touch-on-hit would let a repeatedly-requested entry keep refreshing itself
   * and never expire. Anchoring the pruner to creation time means that change
   * cannot silently defeat eviction.
   *
   * Workspace-scoped rather than a global sweep so it runs inside the ordinary
   * RLS transaction, like every other maintenance pass (`perWorkspace` in the
   * cron registry).
   *
   * @returns how many rows were removed.
   */
  pruneQueryCache?(workspaceId: string, olderThanMs: number): Promise<number>;

  /**
   * §9 L3 embedding LRU — exact `(text-hash, model)` lookup; null on miss.
   *
   * `model` is part of the identity of a cache entry, not metadata about it.
   * The row is keyed `(workspace_id, text_hash)` — the same text hashes
   * identically no matter which model embedded it — so a lookup that ignores
   * `model` can hand back a vector from a different embedding space. Those
   * coordinates mean nothing in the current one, and because widths differ
   * across models (1024 Bedrock/bge-m3, 1536 OpenAI) the downstream cosine
   * query does not merely score badly, it raises `different halfvec
   * dimensions` and the recall fails. Same hazard `_embedding-width.ts`
   * documents for the search path.
   *
   * Optional for backward compatibility with adapters written before the
   * parameter existed; omitting it restores the old model-blind behaviour and
   * should be treated as a bug in the caller, not a supported mode.
   */
  getCachedEmbedding?(
    workspaceId: string,
    textHash: string,
    model?: string
  ): Promise<Float32Array | null>;

  /**
   * §9 L3 embedding LRU — insert or refresh an embedding record.
   *
   * A write for a `(workspace, text)` that is already cached under a DIFFERENT
   * model replaces the stored vector and model. It cannot be a no-op that only
   * bumps `hit_count`: the caller only reaches this path after a cache miss,
   * which under a model-aware read means the entry belongs to a model nobody
   * is using any more. Keeping the old vector would strand the entry forever —
   * permanently missed on read, never overwritten on write.
   */
  putCachedEmbedding?(input: {
    workspaceId: string;
    textHash: string;
    embedding: Float32Array;
    model: string;
  }): Promise<void>;
}

/** Decision CRUD and topic-key merge. */
export interface DecisionPort {
  /**
   * PRIM-18 — insert, unless an active, open decision with the same identity
   * (kind, title, body, owner, scopeRef, sensitivity — as the insert would
   * store them) exists; then return that one with `reused: true`. Lookup and
   * insert are atomic: identical concurrent calls yield one row. Optional: an
   * adapter without it keeps inserting.
   */
  createDecisionUnlessDuplicate?(
    input: CreateDecisionInput
  ): Promise<{ decision: MnemoDecision; reused: boolean }>;
  createDecision(input: CreateDecisionInput): Promise<MnemoDecision>;
  mergeDecisionByTopicKey(input: MergeDecisionByTopicKeyInput): Promise<MnemoDecision | null>;
  getDecision(id: string, workspaceId: string): Promise<MnemoDecision | null>;
  updateDecision(id: string, input: UpdateDecisionInput): Promise<MnemoDecision>;
  archiveDecision(id: string, workspaceId: string): Promise<void>;
  /** WP-6 / PRIM-18 — see {@link SupersedeDecisionInput}. */
  supersedeDecision(input: SupersedeDecisionInput): Promise<MnemoDecision>;
  queryDecisions(filter: DecisionFilter): Promise<PaginatedResult<MnemoDecision>>;
}

// ─── end segregate-storage-ports PR1 additions (Phase 1 group A, rows 1-8) ────

// ─── segregate-storage-ports — narrow domain sub-ports (PR2, Phase 1 group B) ──
//
// PR2 of the same stacked chain additively extracts Port Map rows 9-16 as named
// interfaces below. Every member's name, signature, optionality, and doc comment
// is copied VERBATIM from its original home in the flat `StorageAdapter`
// interface further down this file — nothing here is a behavior change. The
// flat `StorageAdapter` interface remains completely untouched in this PR (zero
// deletions); groups C-E (the remaining 22 domain ports) and the final
// `StorageAdapter` intersection alias land in later PRs in this chain (tasks
// 1.5-1.11). See design.md D3/D4 for placement rationale and the per-method
// override table.

/** Episodic memory: session/event narratives, tree reconstruction, similarity search, and compression. */
export interface EpisodePort {
  createEpisode(input: CreateEpisodeInput): Promise<MnemoEpisode>;
  getEpisode(id: string, workspaceId: string): Promise<MnemoEpisode | null>;
  updateEpisode(id: string, input: UpdateEpisodeInput): Promise<MnemoEpisode>;
  archiveEpisode(id: string, workspaceId: string): Promise<void>;
  queryEpisodes(filter: EpisodeFilter): Promise<PaginatedResult<MnemoEpisode>>;
  /**
   * Reconstruct an episode's full narrative by walking parentEpisodeId to the
   * root and folding deltaContent in depth order (root→leaf). Spec §16.
   */
  reconstructEpisode(id: string, workspaceId: string): Promise<MnemoEpisode>;
  /**
   * Spec §16 episode trees: return the matched episode's parent, siblings (same
   * parentEpisodeId) and direct children — the RELATED neighbourhood for recall
   * expansion. Workspace-scoped; excludes the episode itself. Capped at `limit`
   * (default 10). Optional for backward compatibility with adapters that don't
   * implement tree traversal.
   */
  getEpisodeTreeNeighbors?(
    episodeId: string,
    workspaceId: string,
    limit?: number
  ): Promise<MnemoEpisode[]>;
  /**
   * DELTAMEM §16 — HNSW cosine search over mnemo_episode.embedding, scoped to
   * `workspaceId`. Returns up to `limit` episodes whose embedding cosine
   * similarity to `embedding` is ≥ `minSim`, most-similar first. Rows with a
   * NULL embedding (not yet indexed) are excluded. Used at episode-creation time
   * to find the nearest existing episode to delta-encode against (parent link).
   *
   * `embedding` is a query vector of the embedder's dimension (1536). `minSim`
   * is a cosine similarity in [0,1]. Implementations without a vector index
   * (InMemory) may return an empty list.
   */
  findSimilarEpisodes(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEpisode[]>;
  /**
   * Persist an Experience-Compression result (spec §2): replace the root
   * episode's narrative with the compressed summary and stash retained leaf
   * deltas + provenance in metadata. Idempotent on re-run.
   */
  persistCompression(input: {
    workspaceId: string;
    rootEpisodeId: string;
    compressedNarrative: string;
    retainedDeltas: Array<{ episodeId: string; deltaContent: string }>;
  }): Promise<void>;
}

/**
 * Entity CRUD and similarity search (person/org/project/concept/place/other).
 *
 * D4 override: `findSimilarEntities` sits under the old "Episodes" comment
 * header in the flat interface below, but the `DrizzleStorageAdapter`
 * delegates it to `this.entities` — the adapter wins (explore.md's originally
 * flagged example of an imprecise comment-section boundary).
 */
export interface EntityPort {
  createEntity(input: CreateEntityInput): Promise<MnemoEntity>;
  getEntity(id: string, workspaceId: string): Promise<MnemoEntity | null>;
  updateEntity(id: string, input: UpdateEntityInput): Promise<MnemoEntity>;
  archiveEntity(id: string, workspaceId: string): Promise<void>;
  /** WP-6 / PRIM-2 — see {@link SupersedeEntityInput}. */
  supersedeEntity(input: SupersedeEntityInput): Promise<MnemoEntity>;
  queryEntities(filter: EntityFilter): Promise<PaginatedResult<MnemoEntity>>;
  /**
   * P16 — HNSW cosine search over mnemo_entity.embedding, scoped to
   * `workspaceId`. Returns up to `limit` entities whose embedding cosine
   * similarity to `embedding` is ≥ `minSim`, most-similar first. Rows with a
   * NULL embedding (not yet indexed) are excluded. Implementations without a
   * vector index (InMemory) may return an empty list.
   */
  findSimilarEntities(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEntity[]>;
}

/** Strategy CRUD (trigger→action heuristics). */
export interface StrategyPort {
  /**
   * PRIM-18 — see DecisionPort.createDecisionUnlessDuplicate (identity:
   * trigger, action, owner, scopeRef, sensitivity). Not for `supersedesId`.
   */
  createStrategyUnlessDuplicate?(
    input: CreateStrategyInput
  ): Promise<{ strategy: MnemoStrategy; reused: boolean }>;
  createStrategy(input: CreateStrategyInput): Promise<MnemoStrategy>;
  getStrategy(id: string, workspaceId: string): Promise<MnemoStrategy | null>;
  updateStrategy(id: string, input: UpdateStrategyInput): Promise<MnemoStrategy>;
  archiveStrategy(id: string, workspaceId: string): Promise<void>;
  queryStrategies(filter: StrategyFilter): Promise<PaginatedResult<MnemoStrategy>>;
}

/** Workflow CRUD (reusable multi-step process templates). */
export interface WorkflowPort {
  createWorkflow(input: CreateWorkflowInput): Promise<MnemoWorkflow>;
  getWorkflow(id: string, workspaceId: string): Promise<MnemoWorkflow | null>;
  updateWorkflow(id: string, input: UpdateWorkflowInput): Promise<MnemoWorkflow>;
  archiveWorkflow(id: string, workspaceId: string): Promise<void>;
  queryWorkflows(filter: WorkflowFilter): Promise<PaginatedResult<MnemoWorkflow>>;
}

/** Skill CRUD (prompt templates for repeatable tasks). */
export interface SkillPort {
  createSkill(input: CreateSkillInput): Promise<MnemoSkill>;
  getSkill(id: string, workspaceId: string): Promise<MnemoSkill | null>;
  updateSkill(id: string, input: UpdateSkillInput): Promise<MnemoSkill>;
  archiveSkill(id: string, workspaceId: string): Promise<void>;
  querySkills(filter: SkillFilter): Promise<PaginatedResult<MnemoSkill>>;
}

/**
 * Task CRUD, delegation, and lifecycle.
 *
 * D4 override: `listTasksForSession?` sits under the old "§11 governance"
 * comment header in the flat interface below, but it is a task read used by
 * the collapse pipeline's task-completion outcome signal (RDD-1) — the
 * adapter delegates it to `this.tasks`, so it belongs on `TaskPort`, not
 * wherever the old header implied.
 */
export interface TaskPort {
  createTask(input: CreateTaskInput): Promise<MnemoTask>;
  getTask(id: string, workspaceId: string): Promise<MnemoTask | null>;
  updateTask(id: string, input: UpdateTaskInput): Promise<MnemoTask>;
  archiveTask(id: string, workspaceId: string): Promise<void>;
  delegateTask(id: string, workspaceId: string, input: DelegateTaskInput): Promise<MnemoTask>;
  queryTasks(filter: TaskFilter): Promise<PaginatedResult<MnemoTask>>;
  /**
   * Return task id+status pairs linked to a session.
   * Used by the collapse pipeline to compute the task-completion outcome signal (RDD-1).
   * OPTIONAL — callers MUST guard with `?.`.
   */
  listTasksForSession?(
    workspaceId: string,
    sessionId: string
  ): Promise<Array<{ id: string; status: string }>>;
}

/** Immutable event log CRUD + sensitivity updates (no `updatedAt` by design). */
export interface EventPort {
  createEvent(input: CreateEventInput): Promise<MnemoEvent>;
  getEvent(id: string, workspaceId: string): Promise<MnemoEvent | null>;
  archiveEvent(id: string, workspaceId: string): Promise<void>;
  appendEventAnnotation(
    id: string,
    workspaceId: string,
    annotation: EventAnnotation
  ): Promise<MnemoEvent>;
  queryEvents(filter: EventFilter): Promise<PaginatedResult<MnemoEvent>>;
  /** P15: Raise the sensitivity of an event. Raise-only — calling code MUST verify
   *  sensitivityAtLeast(newSensitivity, existing.sensitivity) before calling this. */
  updateEventSensitivity(id: string, workspaceId: string, sensitivity: Sensitivity): Promise<void>;
}

/** Reasoning-chain CRUD, CoT cache search, usage tracking, and lifecycle status. */
export interface ReasoningPort {
  createReasoning(input: CreateReasoningInput): Promise<MnemoReasoning>;
  getReasoning(id: string, workspaceId: string): Promise<MnemoReasoning | null>;
  updateReasoning(id: string, input: UpdateReasoningInput): Promise<MnemoReasoning>;
  archiveReasoning(id: string, workspaceId: string): Promise<void>;
  queryReasoning(filter: ReasoningFilter): Promise<PaginatedResult<MnemoReasoning>>;

  /** Wave M1 — CoT cache search. Returns candidates ranked by cosine similarity.
   *  By default only servable rows (active + golden) are returned. */
  searchReasoning(input: {
    workspaceId: string;
    vector: number[];
    limit: number;
    includeAllStatuses?: boolean;
  }): Promise<
    Array<{
      id: string;
      cosine: number;
      worth: number;
      successCount: number;
      failureCount: number;
      status: MnemoReasoning["status"];
    }>
  >;

  /** Wave M1 — bump usage_count and last_used_at for a reasoning cache hit. */
  recordReasoningUse(id: string, workspaceId: string): Promise<void>;

  /** Wave M1 — transition lifecycle status (quarantined / golden / active). */
  setReasoningStatus(
    id: string,
    workspaceId: string,
    status: MnemoReasoning["status"]
  ): Promise<void>;
}

// ─── end segregate-storage-ports PR2 additions (Phase 1 group B, rows 9-16) ───

// ─── segregate-storage-ports — narrow domain sub-ports (PR3, Phase 1 group C) ──
//
// PR3 of the same stacked chain additively extracts Port Map rows 17-24 as named
// interfaces below. Every member's name, signature, optionality, and doc comment
// is copied VERBATIM from its original home in the flat `StorageAdapter`
// interface further down this file — nothing here is a behavior change. The
// flat `StorageAdapter` interface remains completely untouched in this PR (zero
// deletions); groups D-E (the remaining 14 domain ports) and the final
// `StorageAdapter` intersection alias land in later PRs in this chain (tasks
// 1.6-1.11). See design.md D3/D4 for placement rationale and the per-method
// override table.

/**
 * Agent self-model: profile CRUD, §14 procedural-memory trajectory scores, and
 * prompt-version lifecycle (Wave M2/Wave U).
 *
 * D4 override: `listScoredTrajectories?` sits under the old "§14 Procedural
 * memory" comment header in the flat interface below, but the
 * `DrizzleStorageAdapter` delegates it to `this.plugins` — grouped here with
 * the prompt-version methods per design D4's Port Map table (§14 agent
 * self-model), not split into its own port.
 */
export interface AgentPort {
  getAgentProfile(workspaceId: string, agentId: string): Promise<MnemoAgentProfile | null>;
  upsertAgentProfile(input: {
    workspaceId: string;
    agentId: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MnemoAgentProfile>;
  /**
   * Increment the sessionsSinceReflection counter in the agent profile's metadata.
   * Creates a profile row if one does not exist yet.
   * Returns the new counter value.
   */
  incrementSessionsSinceReflection(workspaceId: string, agentId: string): Promise<number>;

  /**
   * List the N most-recent scored trajectories for an agent.
   * Each trajectory is a session-level probe with a worth score (0–1).
   * OPTIONAL — callers guard with `?.`.
   */
  listScoredTrajectories?(
    workspaceId: string,
    agentId: string,
    limit: number
  ): Promise<
    Array<{ sessionId: string; score: number; promptVersionId: string | null; createdAt: Date }>
  >;

  /**
   * Insert a new prompt version row in status 'candidate'.
   * Returns the generated row id.
   * OPTIONAL — callers guard with `?.`.
   */
  createPromptVersion?(input: {
    workspaceId: string;
    agentId: string;
    promptText: string;
    diffFromPrevious: string;
    algorithm: string;
    trajectoriesUsed: number;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
    status: "candidate";
  }): Promise<{ id: string }>;

  /**
   * Return the most-recently created candidate (or active) prompt version
   * for the given (workspace, agent) pair, or null if none exists.
   * OPTIONAL — callers guard with `?.`.
   */
  getActivePromptVersion?(
    workspaceId: string,
    agentId: string
  ): Promise<{
    id: string;
    status: "candidate" | "testing" | "active" | "rolled_back";
    trajectoriesUsed: number | null;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
  } | null>;

  /**
   * Return the most-recently activated prompt version across ALL agents in a
   * workspace, or null if no activated versions exist. Used by the cognitive
   * health snapshot to compute proceduralEvolutionDelta without needing a
   * specific agentId.
   * OPTIONAL — callers guard with `?.`.
   */
  getLatestActivatedPromptVersion?(workspaceId: string): Promise<{
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
  } | null>;

  /**
   * List all prompt versions for (workspace, agent), newest first.
   * OPTIONAL — callers guard with `?.`.
   */
  listPromptVersions?(
    workspaceId: string,
    agentId: string
  ): Promise<
    Array<{
      id: string;
      promptText: string | null;
      diffFromPrevious: string | null;
      algorithm: string;
      status: string;
      trajectoriesUsed: number | null;
      avgScoreBefore: number | null;
      avgScoreAfter: number | null;
      activatedAt: Date | null;
      createdAt: Date;
    }>
  >;

  /**
   * Update the status of a prompt version to 'testing', 'active', or 'rolled_back'
   * and record the final avgScoreAfter.
   * OPTIONAL — callers guard with `?.`.
   */
  transitionPromptVersion?(
    workspaceId: string,
    promptVersionId: string,
    newStatus: "testing" | "active" | "rolled_back",
    avgScoreAfter: number
  ): Promise<void>;

  /**
   * §14 A/B scoring — returns the mean outcome score for all trajectories
   * associated with a specific prompt version within a workspace.
   * Returns null when there are no scored trajectories for the version.
   * OPTIONAL — callers guard with `?.`.
   */
  computeCandidateAbScore?(
    workspaceId: string,
    agentId: string,
    promptVersionId: string
  ): Promise<number | null>;
}

/** N-ary relations (hyperedges): CRUD, querying, and activation bumps. */
export interface HyperedgePort {
  createHyperedge(input: CreateHyperedgeInput): Promise<MnemoHyperedge>;
  /**
   * Closed (deleted) hyperedges read as `null` unless `opts.includeClosed`; so
   * does one with a member above `opts.maxSensitivity`.
   */
  getHyperedge(
    id: string,
    workspaceId: string,
    opts?: { includeClosed?: boolean; maxSensitivity?: Sensitivity }
  ): Promise<MnemoHyperedge | null>;
  updateHyperedge(id: string, input: UpdateHyperedgeInput): Promise<MnemoHyperedge>;
  archiveHyperedge(id: string, workspaceId: string): Promise<void>;
  queryHyperedges(filter: HyperedgeFilter): Promise<PaginatedResult<MnemoHyperedge>>;
  bumpHyperedgeActivation(id: string, workspaceId: string): Promise<void>;
}

/** Composition/inference rule engine: rule CRUD, built-in rule seeding, and the append-only inference log. */
export interface CompositionPort {
  createCompositionRule(input: CreateCompositionRuleInput): Promise<MnemoCompositionRule>;
  getCompositionRule(id: string, workspaceId: string): Promise<MnemoCompositionRule | null>;
  updateCompositionRule(
    id: string,
    workspaceId: string,
    input: UpdateCompositionRuleInput
  ): Promise<MnemoCompositionRule>;
  queryCompositionRules(
    filter: CompositionRuleFilter
  ): Promise<PaginatedResult<MnemoCompositionRule>>;
  bumpCompositionExecution(id: string, workspaceId: string): Promise<void>;
  /**
   * Idempotently seed the 7 built-in composition rule templates for a workspace.
   * Calls `mnemo_seed_builtin_rules(workspace_id)` which runs ON CONFLICT DO NOTHING
   * so repeated calls are safe. Called lazily on first write per workspace so every
   * fresh workspace gets the inference engine populated automatically.
   */
  ensureBuiltinCompositionRules(workspaceId: string): Promise<void>;

  // Inference log (Wave E — append-only)
  appendInference(input: AppendInferenceInput): Promise<MnemoInferenceLogEntry>;
  queryInferences(filter: InferenceLogFilter): Promise<PaginatedResult<MnemoInferenceLogEntry>>;

  // Materialise inference (Wave H — atomic: createFact + appendInference + bumpCompositionExecution)
  // Atomically: createFact + appendInference + bumpCompositionExecution + fact_hash upsert
  // in ONE transaction. Prevents orphaned facts (FINDING #4).
  materialiseInference(input: MaterialiseInferenceInput): Promise<{ id: string }>;
}

/** Binary relation CRUD, strength updates, atomic conflict resolution, and relation judgments. */
export interface RelationPort {
  createRelation(input: CreateRelationInput): Promise<MnemoRelation>;
  getRelations(filter: RelationFilter): Promise<MnemoRelation[]>;
  updateRelationStrength(id: string, delta: number): Promise<void>;
  /**
   * Physical `DELETE FROM mnemo_relation`. No bitemporal close, no audit entry,
   * no deletion-log row — the relation and its judgment provenance
   * (`markedByKind`, `reason`, `evidence`, `confidence`) are simply gone.
   *
   * Deliberately NOT the method behind `DELETE /relations/:id`. See
   * {@link closeRelation}: the exposed surface closes the interval, matching
   * `forget()`'s "closes validity — does NOT delete rows" contract that every
   * other primitive follows. Exposing this one would put an unauditable,
   * irreversible operation on the API for the only primitive that carries an
   * explicit human judgment.
   */
  deleteRelation(id: string, workspaceId: string): Promise<void>;

  /**
   * P111 — bitemporal close for a relation: sets `valid_to = now()` and leaves
   * the row, so the judgment trail survives and `validAt` queries still see it
   * as it was.
   *
   * `mnemo_relation` has carried `valid_to` since the baseline and
   * `getRelations` already filters on it (`validTo IS NULL OR validTo > validAt`);
   * nothing could ever set it, so a relation created by mistake — or by the
   * dangling-write path P74 describes — could not be retracted through any
   * surface at all.
   *
   * @returns true when a row was closed, false when the id matched nothing,
   *          the interval was already closed, or an endpoint is above
   *          `opts.maxSensitivity`, so the caller can 404 rather than report
   *          success for a no-op.
   */
  closeRelation(
    id: string,
    workspaceId: string,
    opts?: { maxSensitivity?: Sensitivity }
  ): Promise<boolean>;
  /** Atomic conflict resolution (B5) — see `ResolveConflictInput`'s doc comment. */
  resolveConflict(input: ResolveConflictInput): Promise<ResolveConflictResult>;
  /** flatten-legacy-dual-core D6.4 — see `ApplyRelationJudgmentInput`'s doc comment. */
  applyRelationJudgment(input: ApplyRelationJudgmentInput): Promise<MnemoRelation | null>;
}

/** Citations attached to memory primitives (flatten-legacy-dual-core PR9e, design.md D6.5). */
export interface CitationPort {
  /** List citations attached to a memory primitive, newest first. */
  listCitations(filter: CitationFilter): Promise<MnemoCitation[]>;
}

/**
 * Graph snapshot assembly and semantic-neighbor backfill — adapter-side only;
 * traversal/pathfinding live in `@mnemo-ai/core` looping `RelationPort.getRelations`
 * (design.md D6.5 "Graph — assembly-in-adapter, traversal-in-core").
 */
export interface GraphPort {
  /**
   * flatten-legacy-dual-core PR9f (design.md D6.5 "Graph — assembly-in-adapter,
   * traversal-in-core"). Adapter-side snapshot assembly — mirrors legacy
   * `buildGraphQuery` (`core/src/graph/query.ts`). Traversal/pathfinding
   * (`traverseGraph`/`findGraphPath`) are pure `@mnemo-ai/core` functions
   * looping this interface's `getRelations`, not adapter methods.
   */
  getGraphSnapshot(filter: GraphSnapshotFilter): Promise<GraphSnapshot>;

  /**
   * Each entity's mentions, counted the way `getGraphSnapshot` derives an entity
   * node's `mentionCount`: its active facts plus the non-synthetic episodes
   * related to it by an open, non-dismissed entity↔episode relation, each only when at or below
   * `maxSensitivity`. One entry per requested id (0 when there are none). The
   * stored `mention_count` column is never maintained, so it is not used.
   */
  countEntityMentions(input: {
    workspaceId: string;
    entityIds: string[];
    maxSensitivity?: Sensitivity;
  }): Promise<Record<string, number>>;

  /**
   * The ids, among `ids`, that resolve to a row of this workspace above
   * `maxSensitivity`, in any primitive table (an id field such as a fact's
   * `linkedMemoryIds` may name any kind). An id that resolves to no row is not
   * hidden. Routes use it to drop pointers to rows the caller cannot read, so a
   * response never names an id its ceiling hides.
   */
  findHiddenIds(input: {
    workspaceId: string;
    ids: string[];
    maxSensitivity: Sensitivity;
  }): Promise<string[]>;

  /**
   * How many unresolved conflicts GET /conflicts can list: open
   * `conflicts_with` relations whose two facts exist in this workspace, are
   * current (`validTo` unset) and, with `maxSensitivity`, are both at or below
   * it. One COUNT, so a caller never reads every pair to learn the total.
   */
  countOpenConflicts(input: { workspaceId: string; maxSensitivity?: Sensitivity }): Promise<number>;

  /**
   * flatten-legacy-dual-core PR9g (design.md D6.5 "Graph — assembly-in-adapter,
   * traversal-in-core"). Adapter-side set-based kNN backfill over the HNSW
   * index on `mnemo_fact.embedding` — a set-based `INSERT ... JOIN LATERAL`,
   * not portable to core (design.md's D6.5 table: "Snapshot assembly + kNN
   * backfill in core" was rejected for exactly this reason). Recomputes the
   * workspace's semantic-neighbor edges from scratch (delete + fresh
   * top-k insert) — idempotent, safe to call repeatedly. Returns the number
   * of edges written.
   *
   * `public.mnemo_semantic_neighbor`'s schema-location verdict (design.md
   * D6.5/D6.6): the table is created by the legacy core migration stream
   * (`core/migrations/0073_mnemo_semantic_neighbor.sql`, unqualified —
   * lands in `public`, not `mnemosyne`), not by any adapter-postgres
   * baseline migration. Adapter-postgres's baseline (0001) only
   * conditionally GRANTs DML on it `IF EXISTS`, matching the same
   * defensive pattern already used for `mnemo_extraction_job` (0016). This
   * method queries the table at its current, unmoved physical location
   * (`public.mnemo_semantic_neighbor`) — same assumption PR9f's read-only
   * `loadSemanticEdges` already made for `getGraphSnapshot`'s
   * `includeSemantic` overlay. Production always runs core's migrations
   * before adapter-postgres's (`docker/Dockerfile.migrate`), proven by
   * `fresh-install-migrate.integration.test.ts`'s "full prod migrate order"
   * block, so the table is guaranteed present by the time this method can
   * be called. Moving the table under v3's own ownership is out of this
   * PR's scope — deferred to Phase 7 (Slice 4, legacy retirement), when
   * core's migration stream stops running at all.
   */
  backfillSemanticNeighbors(input: {
    workspaceId: string;
    k?: number;
    threshold?: number;
    modelVersion?: string;
  }): Promise<number>;
}

/**
 * Bounded recall hydration for the cold-recall pipeline, the ACT-R activation
 * log, TD(λ) worth governance, and the FTS candidate arm of Tier-3 recall.
 *
 * Assembled from three originally separate sections of the flat interface
 * ("Bounded recall hydration", "Recall log (ACT-R activation — TASK-4001)",
 * "Worth governance (TD(λ))") — declared here in design.md's Port Map row 23
 * order, not the flat interface's physical line order. See design D3.
 */
export interface RecallPort {
  /** Records one recall request and its final hits; optional for adapters. */
  recordRecallObservation?(
    request: RecallRequestObservation,
    hits: RecallHitObservation[]
  ): Promise<void>;
  // Bounded recall hydration. Implementations use one RLS transaction per batch,
  // never one transaction per overfetched candidate.
  getRecallPrimitives(
    workspaceId: string,
    refs: RecallPrimitiveRef[]
  ): Promise<RecallPrimitiveRecord[]>;
  getRecallLogs(
    workspaceId: string,
    memoryIds: string[],
    limitPerMemory: number
  ): Promise<RecallLogRecord[]>;
  /**
   * With `maxSensitivity`, a relation whose endpoint, or a hyperedge whose
   * member, sits above the ceiling is left out (the same rule as GET /relations
   * and GET /hyperedges), so a hit's relation count names nothing hidden.
   */
  getRecallStructures(
    workspaceId: string,
    sourceIds: string[],
    hyperedgeLimitPerMember: number,
    maxSensitivity?: Sensitivity
  ): Promise<RecallStructures>;
  /**
   * WP-3 (AGENTSIM-4): the ids, among `ids`, that sit on either end of an
   * unresolved `conflicts_with` relation (`valid_to IS NULL`, the same
   * definition GET /conflicts lists). Recall marks those hits `contested`.
   * Optional: without it every hit reports no dispute. With `maxSensitivity`, a
   * conflict whose other end sits above the ceiling does not count (GET
   * /conflicts hides it too), so `contested` reveals nothing hidden.
   */
  getUnresolvedConflictIds?(
    workspaceId: string,
    ids: string[],
    maxSensitivity?: Sensitivity
  ): Promise<string[]>;

  /** FTS arm of hybrid Tier-3 recall: full-text match over text_lemmatized (migration 0047),
   *  workspace-scoped, returns up to `limit` PointerCandidate rows. Adapters without FTS return []. */
  ftsCandidates?(query: Omit<PointerCandidateQuery, "bands">): Promise<FtsCandidate[]>;

  /**
   * make-primitives-recallable (design.md D4/Interfaces, PR3 — Phase 5) —
   * non-fact recall candidates (currently `mnemo_decision` only, following
   * `RECALLABLE_KINDS`), workspace-scoped, driven by `query.kinds` (not a
   * post-filter). Runs the semantic (cosine, `minSimilarity`) arm when
   * `embedding` is supplied, the lexical (`ts_rank`,
   * `plainto_tsquery(mnemosyne.mnemo_fts)`) arm when `terms` is supplied, both when
   * both are supplied, neither (→ `[]`, no query issued) otherwise. Returns
   * up to `limit` candidates, highest score first. Optional — as of this PR
   * it is implemented but not yet called from `recall-cold.ts` (PR4 wires
   * it in); adapters that never implement it behave exactly like adapters
   * without `ftsCandidates?` today.
   */
  recallableCandidates?(query: PrimitiveCandidateQuery): Promise<PrimitiveCandidate[]>;
  /**
   * Items a federation sync brought into the workspace (`mnemo_federated_item`)
   * whose statement matches `terms` lexically: they carry no embedding. Only
   * live (not archived) rows of `workspaceId` at the tiers in `sensitivity`,
   * best match first. Adapters without federation storage omit it.
   */
  federatedRecallCandidates?(query: FederatedRecallQuery): Promise<FederatedRecallCandidate[]>;
  /** Fetch the most recent recall timestamps for a memory, newest first. */
  getRecallLog(
    workspaceId: string,
    memoryId: string,
    limit: number
  ): Promise<Array<{ id: string; recalledAt: string; recallScore: number }>>;
  /**
   * Return up to `limit` distinct query texts from mnemo_recall_log whose
   * fact_id matches any of `factIds`, ordered by recalled_at DESC.
   * Used by the §12 consolidation replay gate to prefer real historical
   * queries over LLM-generated synthetic ones. Returns [] when the log
   * is empty or no rows match.
   */
  getRecentQueriesForFacts(
    workspaceId: string,
    factIds: string[],
    limit: number
  ): Promise<string[]>;

  updateWorth(
    id: string,
    workspaceId: string,
    primitiveKind: PrimitiveKind,
    delta: WorthDelta
  ): Promise<void>;
  // NOTE (design D4): this is the TD(λ) worth update, distinct from
  // SessionPort.recordSessionRecall? (session metadata stamp, group A) and
  // from logRecall above (ACT-R activation log).
  recordRecall(entry: RecallLogEntry): Promise<void>;
  /**
   * Fetch predecessor recalls in the same session for TD(λ) backward propagation.
   * Returns facts recalled before `excludeFactId` in this session, most-recent first,
   * up to 20 entries. Each entry includes the stored tdCredit (λ^rank).
   */
  getTdPredecessors(
    workspaceId: string,
    sessionId: string,
    excludeFactId: string
  ): Promise<Array<{ factId: string; tdCredit: number; recalledAt: Date }>>;

  /**
   * recall-precision-report (harden-hooks-and-measure-precision, Requirement 5/6):
   * precision-at-k over data already persisted by `recordRecall` and collapse's
   * TD(λ) propagation (`propagateTdCredit`). Read-only — no write path, no
   * schema migration. See `RecallPrecisionReport` and design.md for the exact
   * derivation.
   */
  getRecallPrecision(workspaceId: string): Promise<RecallPrecisionReport>;

  /**
   * p50/p95 recall latency over `mnemo_recall_log` rows of the last `days` days
   * (one row per served memory; rows without `latency_ms` are excluded). Rounded
   * to integer ms; both null when there are no samples.
   */
  /**
   * APP-015 — the context economy of a workspace over `days`: how many recalls
   * recorded a served size, their average and p95 served characters, and the
   * size of every live plaintext fact (what injecting all of memory on every
   * turn would cost). Facts are sized only at or under `maxSensitivity`
   * (the caller's ceiling) and never above internal (encrypted tiers store
   * ciphertext). Optional: adapters without it report nothing.
   */
  getContextEconomy?(
    workspaceId: string,
    days: number,
    maxSensitivity: Sensitivity
  ): Promise<{
    recalls: number;
    servedCharsAvg: number | null;
    servedCharsP95: number | null;
    liveFacts: number;
    liveFactChars: number;
  }>;
  getRecallLatency(
    workspaceId: string,
    days: number
  ): Promise<{ p50Ms: number | null; p95Ms: number | null; samples: number }>;

  /**
   * Facts created per UTC day: exactly `days` entries ending today, zero-filled,
   * oldest first, `day` as YYYY-MM-DD. Lives here with the stats reads even
   * though it counts `mnemo_fact.created_at`.
   */
  getWritesPerDay(
    workspaceId: string,
    days: number
  ): Promise<Array<{ day: string; count: number }>>;

  /**
   * Recall calls per UTC day: exactly `days` entries ending today, zero-filled,
   * oldest first, plus the same figures over the whole window. See
   * {@link RecallMetricsWindow} for where each figure comes from.
   */
  getRecallMetrics(workspaceId: string, days: number): Promise<RecallMetrics>;

  /**
   * Counts of the live facts (`valid_to IS NULL`, `status = 'active'`) the caller
   * can read: rows above `maxSensitivity` are not counted. No ceiling counts all.
   */
  getFactStats(input: { workspaceId: string; maxSensitivity?: Sensitivity }): Promise<FactStats>;
}

/**
 * One window of recall activity.
 *
 * - `queries` counts recall calls: the `recall` entries of `mnemo_audit_log`,
 *   one per call whatever it returned. `mnemo_recall_log` cannot count them:
 *   it has one row per served fact and none at all for a call that served nothing.
 * - `zeroHitShare` is the share of those calls that returned nothing, over the
 *   calls whose audit detail is readable (a crypto-wrapped detail hides its
 *   `resultCount`); null when none is.
 * - `p50Ms` / `p95Ms` are percentiles of the recall log's `latency_ms` over its
 *   `hit_rank = 0` rows, one per call that served a fact; null with no samples.
 */
export interface RecallMetricsWindow {
  queries: number;
  zeroHitShare: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface RecallMetrics {
  /** `YYYY-MM-DD` UTC days, oldest first. */
  days: Array<RecallMetricsWindow & { day: string }>;
  totals: RecallMetricsWindow;
}

/**
 * Sessions and episodes over a window of UTC days ending today.
 *
 * - `days`: sessions started each day (`mnemo_session.started_at`), split by their
 *   current status; exactly `days` entries, zero-filled, oldest first.
 * - `totals.collapsed`: sessions of the window that were collapsed into memory
 *   (`collapsed_at` set); `avgTurns` is the mean `turn_count`, null with no session.
 * - `totals.episodes`: non-synthetic episodes that occurred in the window under the
 *   ceiling; `factsPerEpisode` is the mean of their linked facts the caller can read.
 * - `topics`: the five topics most of those episodes carry, largest first.
 */
export interface SessionStats {
  days: Array<{ day: string; active: number; collapsed: number; archived: number }>;
  totals: {
    sessions: number;
    collapsed: number;
    avgTurns: number | null;
    episodes: number;
    factsPerEpisode: number | null;
  };
  topics: Array<{ topic: string; count: number }>;
}

/** Live facts under the caller's ceiling, counted four ways. Zero groups are omitted. */
export interface FactStats {
  live: number;
  pinned: number;
  /** `hit_count = 0`: never served by a recall. */
  neverRecalled: number;
  /** The latest `created_at` among these same facts (ISO); null when there are none. */
  lastWriteAt: string | null;
  byKind: Array<{ kind: string; count: number }>;
  bySensitivity: Array<{ sensitivity: Sensitivity; count: number }>;
  byMemoryType: Array<{ memoryType: string; count: number }>;
}

/** Fact-hash and LSH-band indexes backing Tier-2 pointer recall (Wave E/Wave P). */
export interface FactIndexPort {
  // Fact hash (Wave E)
  lookupFactHash(workspaceId: string, statementHash: string): Promise<MnemoFactHash | null>;
  upsertFactHash(input: UpsertFactHashInput): Promise<MnemoFactHash>;

  // Fact LSH bands — Tier 2 pointer recall (Wave P)
  upsertFactLsh(input: UpsertFactLshInput): Promise<void>;
  pointerCandidates(query: PointerCandidateQuery): Promise<PointerCandidate[]>;
}

// ─── end segregate-storage-ports PR3 additions (Phase 1 group C, rows 17-24) ──

// ─── segregate-storage-ports — narrow domain sub-ports (PR4, Phase 1 group D) ──
//
// PR4 of the same stacked chain additively extracts Port Map rows 25-32 as named
// interfaces below. Every member's name, signature, optionality, and doc comment
// is copied VERBATIM from its original home in the flat `StorageAdapter`
// interface further down this file — nothing here is a behavior change. The
// flat `StorageAdapter` interface remains completely untouched in this PR (zero
// deletions); group E (the remaining 7 domain ports) and the final
// `StorageAdapter` intersection alias land in later PRs in this chain (tasks
// 1.7-1.11). No D4 overrides land in this group — design.md states the comment
// headers and adapter delegation already agree for every method here, so this
// is a straight copy, no reassignment needed. See design.md D3 for placement
// rationale.

/**
 * Engram neuro-dynamics (Wave Y, §25.2/§25.3): STDP co-recall weighting,
 * Beta-evidence decay, and homeostatic normalisation of hebbian weights.
 */
export interface NeuroDynamicsPort {
  /**
   * Decay Beta evidence (worth_alpha/worth_beta) for all facts of a given
   * decay class using exponential half-life. Entity class is a no-op (returns 0).
   * Returns the number of rows updated.
   */
  decayKind(workspaceId: string, decayClass: DecayClass, halfLifeDays: number): Promise<number>;

  /**
   * Record a co-recall event between two facts: computes STDP Δw from
   * the inter-spike interval (now − lastCoRecallAt) and updates
   * hebbian_weight, directionality, co_recall_count, last_co_recall_at.
   */
  recordCoRecallStdp(workspaceId: string, relationId: string, coRecalledAt: Date): Promise<void>;

  /**
   * Homeostatic weekly rescale: renormalise hebbian_weight for a workspace
   * via PERCENT_RANK() OVER (ORDER BY hebbian_weight). Returns rows updated.
   */
  normalizeHebbianWeights(workspaceId: string): Promise<number>;
}

/** Meta-cognition (Wave F): confidence/knowledge-gap introspection views over the workspace's memory. */
export interface MetacognitionPort {
  getConfidenceMap(workspaceId: string, opts?: { limit?: number }): Promise<ConfidenceMapRow[]>;
  getKnowledgeGaps(
    workspaceId: string,
    opts?: { limit?: number; minScore?: number }
  ): Promise<KnowledgeGapRow[]>;
  getMetacognitionTrends(workspaceId: string): Promise<MetacognitionTrends>;
  refreshMetacognitionViews(): Promise<void>;
}

/**
 * Anticipation (Wave G): sequential/periodic/conditional/co-occurrence
 * pattern queries feeding the anticipation feed.
 */
export interface AnticipationPort {
  getSequentialPatterns(args: {
    workspaceId: string;
    predecessorId?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<SequentialPatternRow[]>;

  getPeriodicPatterns(args: {
    workspaceId: string;
    dayOfWeek?: number;
    hourBucket?: number;
    limit?: number;
  }): Promise<PeriodicPatternRow[]>;

  refreshAnticipationViews(): Promise<void>;

  getConditionalPatterns(args: {
    workspaceId: string;
    queryKey?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<ConditionalPatternRow[]>;

  getCoOccurrencePatterns(args: {
    workspaceId: string;
    sourceId: string;
    minCoRecall?: number;
    limit?: number;
  }): Promise<CoOccurrencePatternRow[]>;
}

/** Append-only audit log (workspace governance / mnemo.audit.merkle integrity verification). */
export interface AuditPort {
  appendAuditEntry(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<void>;
  /**
   * Return the last `limit` audit log entries for a workspace, ordered by id ASC
   * (oldest first — required by verifyAuditChain() which expects forward order).
   * Used by the mnemo.audit.merkle cron job for integrity verification.
   */
  listAuditLog(workspaceId: string, limit: number): Promise<AuditLogEntry[]>;
  /**
   * What the given actors (audit actor ids, e.g. `user:<id>`) did in this workspace:
   * entries per UTC day and by action over the last `days` days, and each actor's
   * latest entry ever. See {@link AuditActivity}.
   */
  getAuditActivity(input: {
    workspaceId: string;
    days: number;
    actorIds: string[];
  }): Promise<AuditActivity>;
}

/**
 * Audit-log activity of a set of actors. `days`: exactly `days` UTC days ending
 * today, zero-filled, oldest first. `byAction`: the window's entries by action,
 * largest first. `lastAt`: each actor's latest entry ever (ISO), absent when none.
 */
export interface AuditActivity {
  days: Array<{ day: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
  lastAt: Record<string, string>;
}

/** Transactional outbox: durable side-effect queue drained by the outbox worker. */
export interface OutboxPort {
  appendOutbox(entry: Omit<OutboxEntry, "id" | "createdAt" | "attempts">): Promise<void>;
  claimOutbox(limit: number): Promise<OutboxEntry[]>;
  markOutboxProcessed(ids: string[]): Promise<void>;
  markOutboxFailed(id: string, error: string): Promise<void>;
  /** Move permanently exhausted outbox entries to a dead-letter state. Returns the count moved. */
  reapDeadLetters(maxAttempts: number): Promise<number>;
  /** Delete old processed outbox entries. Returns the count deleted. */
  purgeOutbox(olderThanMs: number): Promise<number>;
  /** Count outbox rows not yet delivered (processedAt IS NULL). For queue-depth telemetry. */
  countPendingOutbox(): Promise<number>;
}

/** Webhook endpoint registration and delivery tracking. */
export interface WebhookPort {
  createWebhookEndpoint(input: CreateWebhookEndpointInput): Promise<MnemoWebhookEndpoint>;
  getWebhookEndpoint(id: string, workspaceId: string): Promise<MnemoWebhookEndpoint | null>;
  listWebhookEndpoints(workspaceId: string): Promise<MnemoWebhookEndpoint[]>;
  updateWebhookEndpoint(
    id: string,
    workspaceId: string,
    input: UpdateWebhookEndpointInput
  ): Promise<MnemoWebhookEndpoint>;
  deleteWebhookEndpoint(id: string, workspaceId: string): Promise<void>;
  recordWebhookDelivery(entry: CreateWebhookDeliveryInput): Promise<void>;
  listWebhookDeliveries(
    webhookId: string,
    workspaceId: string,
    limit?: number
  ): Promise<MnemoWebhookDelivery[]>;
  /** Delivery-worker: returns pending deliveries due for their next attempt. */
  listPendingWebhookDeliveries(limit: number): Promise<MnemoWebhookDelivery[]>;
  /** Delivery-worker: update delivery row after an attempt. */
  updateWebhookDelivery(
    id: string,
    workspaceId: string,
    update: {
      status?: "pending" | "delivered" | "failed";
      responseStatus?: number;
      responseBody?: string;
      attempt?: number;
      deliveredAt?: Date;
      nextAttemptAt?: Date | null;
    }
  ): Promise<void>;
}

/** Prospective memory (reminders): time/semantic triggers surfaced back to the agent. */
export interface ReminderPort {
  createReminder(input: CreateReminderInput): Promise<MnemoReminder>;
  listDueReminderWorkspaceIds(): Promise<string[]>;
  getReminder(id: string, workspaceId: string): Promise<MnemoReminder | null>;
  listPendingReminders(workspaceId: string, asOf: Date): Promise<MnemoReminder[]>;
  dismissReminder(
    id: string,
    workspaceId: string,
    newStatus: "triggered" | "dismissed"
  ): Promise<void>;
  listReminders(
    workspaceId: string,
    status: "pending" | "triggered" | "dismissed" | "all",
    limit: number
  ): Promise<MnemoReminder[]>;
  /**
   * LIFECYCLE-6 — atomically CLAIM triggered reminders no recall has returned
   * yet, stamping `deliveredAt`, and return only the rows this call claimed:
   * the given `ids` (what this recall itself fired) plus up to `limit` of the
   * oldest other undelivered ones. Two concurrent recalls never claim the same
   * row, so a reminder is delivered once. The 30-second poller fires
   * time-only reminders with nobody to show them to; the next recall delivers
   * them through this. Optional: without it a poller-fired reminder reaches
   * agents only through events and webhooks.
   */
  claimUndeliveredReminders?(
    workspaceId: string,
    input: { ids: string[]; limit: number }
  ): Promise<MnemoReminder[]>;
}

/** §36 embedding-model migration (Wave AA): detect and re-embed stale rows after a model change. */
export interface EmbeddingMaintenancePort {
  /**
   * Return up to `limit` rows from `table` whose `embedding_stale = true`
   * or whose `embedding_model != currentModel`.
   * Table is one of: "fact" | "decision" | "skill" | "strategy" | "reasoning".
   */
  listStaleEmbeddings(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string,
    limit: number,
    /**
     * `plaintextOnly`: only `public`/`internal` rows, for an embedder that may
     * not receive confidential+ text (MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=none).
     */
    opts?: { plaintextOnly?: boolean }
  ): Promise<Array<{ id: string; text: string }>>;

  /**
   * The sensitivity tier of the row an embedding job would embed, or null when
   * the row or its table is unknown. The outbox worker reads it before
   * embedding text for an embedder that may not receive confidential+ text.
   */
  getEmbeddingSourceSensitivity?(
    table: EmbeddableTable,
    id: string,
    workspaceId: string
  ): Promise<string | null>;

  /**
   * Check if workspace has an ongoing embedding migration (stale embeddings exist).
   *
   * P111: takes `currentModel` because "stale" is only meaningful relative to the
   * model recall is about to embed with. Unlike {@link listStaleEmbeddings},
   * this requires an existing vector; an unembedded row needs backfill but
   * cannot make vector scores incomparable. The original one-argument signature
   * could only have consulted `embedding_stale`, a flag whose only writer
   * (`markEmbeddingsStale`) has never had a caller, so it would have answered
   * `false` forever even once implemented.
   *
   * Still optional on the port: `recall-cold` guards the call and degrades to
   * `false`. That guard is why an absent implementation went unnoticed for so
   * long, so it is required of the production adapter and stays optional only
   * for partial test doubles.
   */
  hasActiveEmbeddingMigration?(workspaceId: string, currentModel: string): Promise<boolean>;

  /**
   * Mark all rows in `table` for `workspaceId` as stale where
   * `embedding_model != currentModel`. Returns count of updated rows.
   */
  markEmbeddingsStale(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string
  ): Promise<number>;

  /**
   * Write a freshly computed embedding + stamp `embedding_model = model`
   * and `embedding_stale = false` for the given row.
   */
  updateEmbeddingVector(
    table: EmbeddableTable,
    id: string,
    workspaceId: string,
    vector: number[],
    model: string
  ): Promise<void>;
}

// ─── end segregate-storage-ports PR4 additions (Phase 1 group D, rows 25-32) ──

// ─── segregate-storage-ports — narrow domain sub-ports (PR5, Phase 1 group E) ──
//
// PR5 of the same stacked chain additively extracts Port Map rows 33-39 as named
// interfaces below — the final group. Every member's name, signature, optionality,
// and doc comment is copied VERBATIM from its original home in the flat
// `StorageAdapter` interface further down this file — nothing here is a behavior
// change. The flat `StorageAdapter` interface remains completely untouched in this
// PR (zero deletions); replacing it with the intersection alias, plus
// `ports-guard.ts`, land in a later PR in this chain (tasks 1.8-1.11). See
// design.md D3/D4 for placement rationale and the per-method override table. This
// PR completes all 39 named sub-ports.

/** Hot-tier ZSet snapshot persistence (§37, Wave AA). */
export interface HotTierPort {
  /**
   * Upsert hot-tier snapshot rows into mnemo_hot_tier_snapshot.
   * Uses ON CONFLICT DO UPDATE to overwrite stale scores.
   */
  upsertHotTierSnapshot(rows: HotTierSnapshotRow[]): Promise<void>;

  /**
   * Load hot-tier snapshot rows. When workspaceId is provided, scoped to
   * that workspace; otherwise returns all rows (used at boot to reload all).
   */
  loadHotTierSnapshots(workspaceId?: string): Promise<HotTierSnapshotRow[]>;
}

/**
 * Prometheus scrape-path aggregates + stale-task cron reads.
 *
 * D4 override: `listStaleTasks?`, `countStaleTasks?`, and `countTasksByStatus?`
 * sit under the old "Wave T4 — OutcomeSignal + stale-task cron" comment header
 * in the flat interface below, but the `DrizzleStorageAdapter` delegates all
 * three to `this.metering` — the Prometheus scrape path, not task lifecycle —
 * so they belong on `MetricsPort`, not `TaskPort`.
 */
export interface MetricsPort {
  /**
   * Return tasks that have been in a non-terminal status for longer than
   * `staleSinceMs` milliseconds. Used by the stale-task cron to auto-archive
   * tasks that are abandoned without being explicitly closed.
   *
   * Terminal statuses (completed, archived) are excluded — only active tasks
   * are returned. Optional because the cron gracefully skips if absent.
   *
   * @param workspaceId  - workspace to scan
   * @param staleSinceMs - how old the updatedAt must be (ms, default 7 days)
   * @param limit        - max rows to return per cron tick (default 100)
   */
  listStaleTasks?(
    workspaceId: string,
    staleSinceMs: number,
    limit: number
  ): Promise<Array<{ id: string; title: string; status: string; updatedAt: Date }>>;

  /**
   * Returns a per-(type,status) fact count for the snapshot gauge.
   * Aggregate across all workspaces; only called on Prometheus scrape (every ~15s).
   * Optional — callers guard with `?.()`.
   */
  countFactsByTypeStatus?(): Promise<Array<{ type: string; status: string; count: number }>>;

  /**
   * Returns fact counts bucketed by worth score.
   * Buckets: '0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'.
   */
  worthHistogram?(): Promise<Array<{ bucket: string; count: number }>>;

  /**
   * Returns the number of currently active sessions (status = 'active').
   */
  countActiveSessions?(): Promise<number>;

  /**
   * Returns task counts grouped by status.
   */
  countTasksByStatus?(): Promise<Array<{ status: string; count: number }>>;

  /**
   * Returns the count of stale tasks (reuses listStaleTasks logic).
   */
  countStaleTasks?(): Promise<number>;
}

/**
 * Workspace-level aggregates: vitals, audit feed, health snapshot, knowledge
 * distribution, and operational mode (learning/production graduation).
 *
 * D4 override: `getKnowledgeDistribution` sits under the old "Episodes" comment
 * header, and `getWorkspaceVitals`/`getAuditFeed` sit under the old "Facts"
 * comment header, in the flat interface below — but the `DrizzleStorageAdapter`
 * delegates all three to `this.episodes`/`this.facts` respectively only
 * incidentally; they are workspace-level aggregates (not per-primitive CRUD),
 * so design D4 assigns them to `WorkspacePort` instead.
 */
export interface WorkspacePort {
  /** Workspace vitals aggregate (fact counts, embedding backlog, scope breakdown). */
  getWorkspaceVitals(workspaceId: string): Promise<WorkspaceVitals>;
  /** Undo-log feed: UNION of forgotten facts + archived facts, newest first. */
  getAuditFeed(filter: AuditFeedFilter): Promise<AuditFeedEntry[]>;
  /**
   * The undo-log feed counted per UTC day over the last `days` days: user forgets
   * and system archives, each fact at or under `maxSensitivity`. See {@link AuditFeedStats}.
   */
  getAuditFeedStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<AuditFeedStats>;
  /**
   * Memory-drift snapshot (`mnemo_health`). `fresh: false` (default) reads the
   * latest persisted row, or `null` if none exist. `fresh: true` recomputes
   * now (querying `mnemo_fact`/`mnemo_decision`/`mnemo_relation`/
   * `mnemo_extraction_job`) and persists a new row before returning it.
   * flatten-legacy-dual-core Phase 9 — ports `@mnemo-ai/core`'s
   * `getHealthSnapshot` (Requirement 4).
   */
  getHealthSnapshot(input: GetHealthSnapshotInput): Promise<HealthSnapshot | null>;
  /**
   * The persisted snapshots of the last `days` UTC days, one per day (the day's
   * latest), as shares and rates only: see {@link HealthSnapshotDay}.
   */
  getHealthSnapshots(input: { workspaceId: string; days: number }): Promise<HealthSnapshotDay[]>;
  /**
   * Count active primitives per knowledge type for the UCE scheduler (spec §10).
   * Keys are the 10 RememberKind values; missing types may be omitted (treated as 0).
   */
  getKnowledgeDistribution(workspaceId: string): Promise<Partial<Record<RememberKind, number>>>;
  /**
   * Get the operational mode for a workspace (learning or production).
   * Returns null if no mode row exists yet (caller should treat as learning mode).
   *
   * RDD-5: extended with startedAt, factCount, entityCount for multi-criteria graduation.
   */
  getWorkspaceMode?(workspaceId: string): Promise<{
    mode: "learning" | "production";
    sessionCount: number;
    promoteAt: number | null;
    /** When the workspace entered learning mode (for daysElapsed graduation criterion). */
    startedAt?: Date;
    /** Cumulative fact count (for factCount >= 50 graduation criterion). */
    factCount?: number;
    /** Cumulative entity count (for entityCount >= 5 graduation criterion). */
    entityCount?: number;
  } | null>;

  /**
   * Upsert the workspace mode row. Used to:
   *   - promote a workspace from learning → production
   *   - increment sessionCount after each collapse
   */
  setWorkspaceMode?(
    workspaceId: string,
    patch: {
      mode?: "learning" | "production";
      sessionCount?: number;
      promoteAt?: number | null;
      factCount?: number;
      entityCount?: number;
    }
  ): Promise<void>;

  /**
   * Atomically increment fact_count and entity_count in mnemo_workspace_mode.
   * Called after each successful collapse to keep graduation criteria up to date.
   *
   * OPTIONAL — when absent the counters are not updated. Callers MUST guard with `?.`.
   */
  incrementWorkspaceModeCounters?(
    workspaceId: string,
    delta: {
      factCount?: number;
      entityCount?: number;
      sessionCount?: number;
    }
  ): Promise<void>;
}

/** Plugin state persistence — per-workspace, per-plugin JSON blob (§21, Wave U). */
export interface PluginStatePort {
  /**
   * Return the full state JSON blob for a plugin in a workspace.
   * Returns null when no row exists yet (plugin has not persisted state).
   * OPTIONAL — callers guard with `?.`.
   */
  getPluginState?(workspaceId: string, pluginId: string): Promise<Record<string, unknown> | null>;

  /**
   * Upsert the full state blob for a plugin in a workspace.
   * Uses ON CONFLICT (workspace_id, plugin_id) DO UPDATE.
   * OPTIONAL — callers guard with `?.`.
   */
  upsertPluginState?(
    workspaceId: string,
    pluginId: string,
    state: Record<string, unknown>
  ): Promise<void>;

  /**
   * Remove a single key from the plugin's state JSON.
   * No-op when the row or key does not exist.
   * OPTIONAL — callers guard with `?.`.
   */
  deletePluginStateKey?(workspaceId: string, pluginId: string, key: string): Promise<void>;
}

/** Billing/metering read paths: spend, meter events, and per-metric token/recall usage. */
export interface BillingPort {
  /**
   * Get the total spend (USD) for a workspace in the current calendar month.
   * Returns 0.0 when no spend rows exist.
   * Implemented as SUM(cost_usd) over mnemo_meter_event WHERE occurred_at >=
   * date_trunc('month', now()). OPTIONAL — callers guard with `?.`.
   */
  getWorkspaceMonthlySpendUsd?(workspaceId: string): Promise<number>;

  /**
   * Durably append a single billing meter event (F15, spec §35 lines 4203-4217).
   *
   * Idempotent: `idempotencyKey` is UNIQUE in mnemo_meter_event, so a retried or
   * cross-replica duplicate write is silently dropped (ON CONFLICT DO NOTHING).
   * Fire-and-forget callers MUST NOT let a rejection bubble onto a request path.
   *
   * The shape is declared structurally (not imported from @mnemo-ai/core) so the
   * types package stays at the bottom of the dependency graph. `metric` is the
   * core MeterMetric string; `quantity` maps to the `units` column; `costUsd`
   * maps to the `cost_usd` column.
   *
   * OPTIONAL — callers guard with `?.`.
   */
  appendMeterEvent?(event: {
    workspaceId: string;
    metric: string;
    quantity: number;
    occurredAt: Date;
    costUsd: number;
    idempotencyKey: string;
  }): Promise<void>;

  /**
   * Month-to-date usage counts per metric for a workspace, summed from the
   * durable mnemo_meter_event table (units grouped by operation, occurred_at >=
   * date_trunc('month', now())). Keys are MeterMetric strings; missing metrics
   * are absent (caller defaults to 0). Used by aggregation + GET /usage so
   * usage survives restart. OPTIONAL — callers guard with `?.`.
   */
  getMonthToDateUsageFromDb?(workspaceId: string): Promise<Record<string, number>>;

  /**
   * Get the total number of recall operations for a workspace in the current
   * calendar month. Returns 0 when no recall rows exist.
   * Used by the cognitive health snapshot (GET /health/cognitive).
   * OPTIONAL — callers guard with `?.`.
   */
  getWorkspaceMonthlyRecallCount?(workspaceId: string): Promise<number>;

  /**
   * Get the total LLM tokens consumed by a workspace since `since`.
   * Returns 0 when no token-usage rows exist.
   * Used by the cost dashboard (GET /cost).
   * OPTIONAL — callers guard with `?.`.
   */
  getWorkspaceLLMTokenUsage?(workspaceId: string, since: Date): Promise<number>;

  /**
   * Get the total embedding tokens consumed by a workspace since `since`.
   * Returns 0 when no embedding-usage rows exist.
   * Used by the cost dashboard (GET /cost).
   * OPTIONAL — callers guard with `?.`.
   */
  getWorkspaceEmbeddingTokenUsage?(workspaceId: string, since: Date): Promise<number>;
}

/** Adapter lifecycle: health probe, graceful close, and workspace enumeration. */
export interface LifecyclePort {
  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
  listWorkspaceIds(): Promise<string[]>;
}

/** The set of optional capabilities an adapter implementation supports. */
export interface CapabilitiesPort {
  readonly capabilities: StorageCapabilities;
}

// ─── end segregate-storage-ports PR5 additions (Phase 1 group E, rows 33-39) ──
// All 39 named sub-ports now exist. The intersection alias (task 1.8) and
// `ports-guard.ts` (task 1.9) land in the next PR in this chain.

/**
 * Primary persistence port — the single contract that core depends on for all durable storage.
 *
 * Implemented by: `@mnemo-ai/adapter-postgres` (DrizzleStorageAdapter) and
 * InMemoryStorageAdapter (test utility in `@mnemo-ai/types/src/testing/`).
 *
 * Contract invariants ALL implementations MUST uphold (enforced by StorageAdapterContract.ts):
 * - getFact(id, workspaceIdA) returns null when the fact belongs to workspaceIdB (RLS isolation)
 * - Sensitivity defaults to "internal" when not explicitly set
 * - Decimal confidence values must not be truncated (store as NUMERIC/REAL, not INTEGER)
 * - Outbox entries are observable immediately after createFact (transactional outbox)
 * - healthCheck() always returns a value (never throws)
 *
 * How to implement: extend InMemoryStorageAdapter or write from scratch, then run
 * `runStorageAdapterContractTests(makeAdapter)` from packages/types/src/testing/StorageAdapterContract.ts.
 */
export type StorageAdapter = SessionPort &
  Partial<HarnessIngestionPort> &
  Partial<ManagedSessionLifecyclePort> &
  Partial<ManagedCollapsePort> &
  Partial<ManagedSessionWorkerPort> &
  FactPort &
  RetentionPort &
  ConsolidationPort &
  ActiveLearningReviewPort &
  DriftReviewPort &
  QueryCachePort &
  DecisionPort &
  EpisodePort &
  EntityPort &
  StrategyPort &
  WorkflowPort &
  SkillPort &
  TaskPort &
  EventPort &
  ReasoningPort &
  AgentPort &
  HyperedgePort &
  CompositionPort &
  RelationPort &
  CitationPort &
  GraphPort &
  RecallPort &
  FactIndexPort &
  NeuroDynamicsPort &
  MetacognitionPort &
  AnticipationPort &
  AuditPort &
  OutboxPort &
  WebhookPort &
  ReminderPort &
  EmbeddingMaintenancePort &
  HotTierPort &
  MetricsPort &
  WorkspacePort &
  PluginStatePort &
  BillingPort &
  LifecyclePort &
  CapabilitiesPort;

/** The primitive tables that carry embedding / embedding_model / embedding_stale columns. */
export type EmbeddableTable =
  | "fact"
  | "decision"
  | "skill"
  | "strategy"
  | "reasoning"
  | "episode"
  | "entity"
  // P65 / migration 0033 — workflow gained its embedding column. Until then it
  // was in the "no embedding column, cannot be vector-indexed" bucket, and the
  // OutboxWorker marked its vector_upsert entries processed after skipping them.
  | "workflow"
  // P65 / migration 0034 — same story for these two. `hyperedge` is now the
  // only primitive left without an embedding column.
  | "task"
  | "event";

/** One hit from StorageAdapter.findSimilarEpisodes (DELTAMEM §16). */
export interface SimilarEpisode {
  id: string;
  /** Cosine similarity to the query vector, in [0,1]. Higher = more similar. */
  cosine: number;
  depth: number;
}

/** One hit from StorageAdapter.findSimilarEntities (P16). */
export interface SimilarEntity {
  id: string;
  /** Cosine similarity to the query vector, in [0,1]. Higher = more similar. */
  cosine: number;
}

/** One row in mnemo_hot_tier_snapshot (§37 Wave AA). */
export interface HotTierSnapshotRow {
  workspaceId: string;
  cacheKey: string;
  score: number;
  payload: Record<string, unknown>;
}

// ─── CacheAdapter ─────────────────────────────────────────────────────────────

export interface CacheSetOpts {
  ttlMs?: number;
  ifNotExists?: boolean;
}

export interface CacheCapabilities {
  sortedSets: boolean;
  pubSub: boolean;
  patterns: boolean;
  atomic: boolean;
  /** Generic Hash field ops (hSet/hGet/hGetAll/hDel). Redis: true; in-process fallback: true. */
  hashes: boolean;
}

/**
 * Optional caching port — speeds up hot recall paths and holds ephemeral session state.
 *
 * Implemented by: `@mnemo-ai/adapter-redis` (RedisCacheAdapter) and
 * InMemoryCacheAdapter (test utility).
 *
 * Required methods (all implementations): get, set, delete, deletePattern, healthCheck, close.
 * Optional methods (Redis-only, gated by capabilities flags):
 *   - sortedSets (zadd, zrangeByScore, zincrby): used by recall-hot.ts for score-ranked recall cache
 *   - pubSub (publish, subscribe): used by federation fanout (stub — not yet wired)
 *
 * Core does NOT depend on CacheAdapter being present — the MnemoWorkspace context
 * marks it optional. Without a cache adapter, recall always cold-path fetches from storage.
 * With one, hot-path results are cached under `recall:{workspaceId}:{queryHash}`.
 *
 * TTL contract: callers specify ttlMs per set(); the adapter must honour it within ±1s.
 * Serialization: values are JSON-serialized by the adapter; callers may pass any JSON-safe value.
 */
export interface CacheAdapter {
  readonly id: string;
  readonly capabilities: CacheCapabilities;

  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: CacheSetOpts): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Idempotently promote a fact into the workspace hot tier on behalf of one
   * managed collapse effect, trimming the tier to `maxSize`.
   *
   * Optional: an adapter without it simply performs no promotion. `effectId`
   * is the dedup key, so a redelivered effect promotes exactly once.
   */
  applyManagedHotPromotion?(input: {
    workspaceId: string;
    factId: string;
    effectId: string;
    maxSize: number;
  }): Promise<void>;
  deletePattern(pattern: string): Promise<number>;

  // Sorted sets — optional (Redis only)
  zadd?(key: string, score: number, member: string): Promise<void>;
  zrangeByScore?(key: string, min: number, max: number, limit?: number): Promise<string[]>;
  zincrby?(key: string, increment: number, member: string): Promise<number>;
  /** Remove members from a sorted set — needed for correct LRU-by-activation eviction. */
  zrem?(key: string, ...members: string[]): Promise<number>;

  /**
   * Atomic counter: INCR the key then (re)set its TTL to ttlSeconds, returning
   * the new value. Used by L0 working memory for rate-limit counters and bloom
   * primitives. Optional — present on Redis; the in-process WorkingMemory fallback
   * implements an equivalent. TTL is mandatory (no PERSIST).
   */
  incrWithTtl?(key: string, ttlSeconds: number): Promise<number>;

  // Pub/Sub — optional (Redis only)
  publish?(channel: string, message: string): Promise<void>;
  subscribe?(channel: string, handler: (message: string) => void): Promise<void>;

  // Lists — optional (Redis only); §35 WS replay ring buffer.
  lpush?(key: string, value: string): Promise<number>;
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
  ltrim?(key: string, start: number, stop: number): Promise<void>;
  lpushCapped?(key: string, value: string, max: number, ttlSeconds: number): Promise<void>;

  // Hashes — optional (gated by capabilities.hashes).
  /** Set a single field on a hash and (re)set the hash key's TTL to ttlSeconds. */
  hSetWithTtl?(key: string, field: string, value: string, ttlSeconds: number): Promise<void>;
  /** Read one field; null when the field or key is absent. */
  hGet?(key: string, field: string): Promise<string | null>;
  /** Read every field as a plain object; {} when the key is absent. */
  hGetAll?(key: string): Promise<Record<string, string>>;
  /** Delete one or more fields; returns the number of fields removed. */
  hDel?(key: string, ...fields: string[]): Promise<number>;

  healthCheck(): Promise<HealthStatus>;
  info?(): Promise<CacheInfo>;
  close(): Promise<void>;
}

export interface CacheInfo {
  usedMemoryBytes: number | null;
  connectedClients: number | null;
}

// ─── VectorAdapter ────────────────────────────────────────────────────────────

export interface VectorSearchInput {
  workspaceId: string;
  vector: Float32Array;
  limit: number;
  minSimilarity?: number;
  filter?: Record<string, unknown>;
}

export interface VectorSearchHit {
  id: string;
  score: number;
  primitiveKind?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorFilter {
  workspaceId?: string;
  primitiveKind?: string;
  ids?: string[];
}

/**
 * Approximate-nearest-neighbour search port for semantic recall (stage 2 of recall pipeline).
 *
 * Implemented by: `@mnemo-ai/adapter-vector` (pgvector via DrizzleStorageAdapter)
 * and InMemoryVectorAdapter (cosine brute-force for tests, not production).
 *
 * The `dimensions` property MUST match the embedding model in use (1536 for text-embedding-3-small,
 * 3072 for text-embedding-3-large). Mismatch causes a hard error at upsert time.
 *
 * HNSW index params (production only): m=16, ef_construction=64, halfvec(1536).
 * See packages/adapter-postgres/migrations/v3/0005_vector_indexes.sql.
 *
 * Workspace isolation is enforced by including workspaceId in VectorSearchInput.filter —
 * NEVER search without it. The adapter itself does not enforce RLS (unlike StorageAdapter).
 *
 * search() returns hits ordered by score descending. Callers filter by minSimilarity themselves
 * since the threshold is tunable per-query. Typical minimum: 0.7 for semantic recall.
 */
export interface VectorAdapter {
  readonly id: string;
  readonly dimensions: number;

  search(input: VectorSearchInput): Promise<VectorSearchHit[]>;
  upsert(id: string, vector: Float32Array, metadata?: Record<string, unknown>): Promise<void>;
  delete(id: string, workspaceId: string): Promise<void>;
  deleteByFilter(filter: VectorFilter): Promise<number>;

  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
}

// ─── EmbedAdapter ─────────────────────────────────────────────────────────────

/**
 * Text embedding port — converts strings to dense vectors for semantic similarity.
 *
 * Implemented by: `@mnemo-ai/llm-providers` (OpenAIEmbedAdapter, CohereEmbedAdapter)
 * and InMemoryEmbedAdapter (deterministic mock that returns unit vectors by hash).
 *
 * embed(texts) batches multiple strings into a single API call where possible.
 * embedSingle is a convenience wrapper that calls embed([text])[0].
 *
 * The `model` property is the canonical model identifier (e.g. "text-embedding-3-small").
 * It is stored alongside each primitive's embedding so stale embeddings can be detected
 * and re-generated when the model changes (embeddingStale flag on primitives).
 *
 * Never pass empty strings — most providers return a zero vector or error.
 * Text should be pre-processed (stripped of markdown/HTML) before embedding.
 */
export interface EmbedAdapter {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;

  /**
   * Whether these vectors carry real semantic meaning.
   *
   * `false` marks a stand-in that returns well-formed, unit-length vectors with
   * no relationship to meaning — today that is the `MNEMO_EMBED_STUB=true`
   * hash embedder (SHA-256 expanded to 1536 floats). Absent/`true` means a real
   * provider.
   *
   * It exists because P115: the RecMem gate in session collapse compared stub
   * cosines against a 0.6 threshold and, when they fell short, DISCARDED the
   * collapse and closed the session. Two sessions on the same topic scored 0.58
   * and 0.50 — and the more repetitive one scored LOWER. A hash was deciding
   * whether a session became memory, and nothing in the type system connected
   * "these vectors are fake" to "do not let a semantic gate act on them".
   *
   * Contract for consumers: a component that makes an IRREVERSIBLE or
   * lossy decision from vector similarity MUST check this and stand down when
   * it is `false`. Ranking and ordering may still use the vectors — a bad
   * ordering is recoverable, a discarded session is not.
   */
  readonly semantic?: boolean;

  /**
   * The operator runs this embedder on its own machine or private network, so
   * confidential and restricted text sent to it does not leave the deployment.
   * Absent/`false` = external (SECURITY.md §7, MNEMO_SENSITIVE_TEXT_TO_PROVIDERS).
   */
  readonly local?: boolean;

  embed(texts: string[]): Promise<Float32Array[]>;
  embedSingle(text: string): Promise<Float32Array>;

  /** Optional input_type-aware embed for document indexing (e.g. Voyage/Cohere). */
  embedDocument?(texts: string[]): Promise<Float32Array[]>;
  /** Optional input_type-aware embed for search queries (e.g. Voyage/Cohere). */
  embedQuery?(text: string): Promise<Float32Array>;

  healthCheck(): Promise<HealthStatus>;
}

// ─── LLMAdapter ───────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Which engine job a completion serves. A host that routes completions per task
 * (the server's MNEMO_LLM_<TASK>_* variables) picks the provider from it; a
 * single provider ignores it. Unset means "default".
 *
 * - judge: a verdict over given material (conflict classification, rerank, reminder conditions)
 * - summary: condensing a session or document into facts (collapse, capture, compression)
 * - prefilter: shaping a query before retrieval (HyDE, anticipation queries)
 * - default: everything else
 */
export type LLMTask = "judge" | "summary" | "prefilter" | "default";

export interface LLMInput {
  system?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Hint to the LLM adapter to use this specific model (e.g. "haiku" for cheap tier). */
  model?: string;
  /** The job this completion serves, for per-task provider routing. */
  task?: LLMTask;
}

export interface LLMOutput {
  content: string;
  tokensUsed: { input: number; output: number };
  model: string;
  finishReason: "stop" | "length" | "tool_use";
  /** Vendor identity ("openai", "anthropic", ...) when surfaced by the provider. */
  provider?: string;
  /** Vendor-estimated USD cost for this completion; undefined when the model is not priced. */
  costUSD?: number;
}

// Duck-typed schema (structurally matches zod, valibot, etc.)
export interface SchemaLike<T> {
  parse: (data: unknown) => T;
}

/**
 * LLM inference port — drives extraction, consolidation, and CUP migration.
 *
 * Implemented by: `@mnemo-ai/llm-providers` (ClaudeAdapter, OpenAIAdapter, GeminiAdapter).
 * Routing across providers is handled by LLMRouter (packages/core/src/v3/llm/router.ts)
 * which wraps multiple LLMAdapters with per-task provider selection + BudgetGuard.
 *
 * generate(): unstructured text generation. Used for CUP migration narration and
 * session collapse summarization.
 *
 * generateStructured<T>(input, schema): returns a validated T by asking the LLM to
 * produce a JSON object that matches the schema. The schema argument is duck-typed
 * (SchemaLike<T>) — works with zod, valibot, or any object with a `.parse()` method.
 * Used for extraction (fact/decision/entity parsing) and consolidation classification.
 *
 * Callers must handle token budget: maxTokens in LLMInput sets output ceiling.
 * The tokensUsed in LLMOutput is authoritative for cost tracking (BudgetGuard reads it).
 *
 * Implementation note: do NOT store LLMAdapter instances in workspace context directly —
 * always go through LLMRouter to enable provider switching and cost limits.
 */
export interface LLMAdapter {
  readonly id: string;
  readonly model: string;
  /**
   * The tasks this adapter answers from a provider the operator runs on its own
   * machine or private network: confidential and restricted text sent for them
   * does not leave the deployment. Absent = every task is external
   * (SECURITY.md §7, MNEMO_SENSITIVE_TEXT_TO_PROVIDERS).
   */
  readonly localTasks?: readonly LLMTask[];

  generate(input: LLMInput): Promise<LLMOutput>;
  generateStructured<T>(input: LLMInput, schema: SchemaLike<T>): Promise<T>;

  healthCheck(): Promise<HealthStatus>;
}

// ─── QueueAdapter ─────────────────────────────────────────────────────────────

export interface EnqueueOpts {
  priority?: number;
  retryLimit?: number;
  retryDelay?: number;
  startAfter?: Date;
  singletonKey?: string;
}

export type JobHandler<T = unknown> = (data: T) => Promise<void>;

/**
 * Background job port — schedules async work (embedding refresh, consolidation, webhook delivery).
 *
 * Implemented by: `@mnemo-ai/adapter-postgres` (PgBossQueueAdapter using pg-boss in
 * the same Postgres database as storage, so jobs are durable) and InMemoryQueueAdapter
 * (immediate synchronous execution for tests — no actual deferral).
 *
 * enqueue(): one-shot job. Returns jobId for status tracking.
 *   - singletonKey: prevents duplicate jobs (used for workspace-scoped consolidation runs).
 *   - startAfter: future-scheduled execution (used for TTL-expiry reminders).
 *   - retryLimit + retryDelay: exponential backoff on handler errors.
 *
 * schedule(): recurring cron job. Idempotent — calling twice with same jobName+cron is a no-op.
 *   Used to schedule nightly consolidation and embedding staleness scans.
 *
 * process(): registers the handler for a job type. Must be called at server startup before
 * jobs start processing. Handlers are async and must not throw — errors go to pg-boss
 * dead-letter queue and are retried per retryLimit.
 *
 * Shutdown: always call close() on graceful shutdown to let in-flight jobs complete.
 */
export interface QueueAdapter {
  readonly id: string;

  enqueue(jobName: string, data: unknown, opts?: EnqueueOpts): Promise<string>;
  schedule(jobName: string, cron: string, data?: unknown): Promise<void>;
  process<T = unknown>(jobName: string, handler: JobHandler<T>): Promise<void>;

  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
}

// ─── OutboxAdapter ────────────────────────────────────────────────────────────

export interface OutboxStats {
  pending: number;
  failed: number;
  oldestPendingMs: number;
}

/**
 * Transactional outbox port — guarantees at-least-once event delivery without 2-phase commit.
 *
 * Implemented by: `@mnemo-ai/adapter-postgres` (DrizzleOutboxAdapter writing to mnemo_outbox
 * in the same transaction as the fact/decision write). There is no InMemory implementation —
 * OutboxAdapter is always paired with a real database transaction.
 *
 * Pattern: within a storage write transaction, call append() so the outbox entry is committed
 * atomically with the fact. A background poller (OutboxRelay in packages/core) calls
 * claimBatch() → delivers events → markProcessed(). On failure, markFailed() increments
 * the attempt counter; the poller retries until MAX_ATTEMPTS (see outbox.ts).
 *
 * append(): must be called INSIDE the same DB transaction as the primary write.
 *   Passing the entry outside a transaction breaks the atomicity guarantee.
 *
 * claimBatch(): claims and locks entries for processing (SELECT … FOR UPDATE SKIP LOCKED).
 *   Returns at most `limit` entries. Only pending entries with attempts < MAX are returned.
 *
 * Security: the mnemo_app_role has INSERT-only on mnemo_outbox (UPDATE and DELETE revoked).
 *   Processed/failed entries are marked by a privileged relay role, not the app role.
 */
export interface OutboxAdapter {
  append(entry: Omit<OutboxEntry, "id" | "createdAt" | "attempts">): Promise<void>;
  claimBatch(limit: number): Promise<OutboxEntry[]>;
  markProcessed(ids: string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  getStats(): Promise<OutboxStats>;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export interface LogContext {
  workspaceId?: string;
  agentId?: string;
  traceId?: string;
  spanId?: string;
  operation?: string;
  durationMs?: number;
  error?: { type: string; message: string; stack?: string; code?: string };
  cost?: { model: string; tokensIn: number; tokensOut: number; costUsd: number };
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

export interface SpanOpts {
  parent?: Span;
  attributes?: Record<string, string | number | boolean>;
}

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

export interface Telemetry {
  startSpan(name: string, opts?: SpanOpts): Span;
  counter(name: string, value?: number, attrs?: Record<string, string>): void;
  histogram(name: string, value: number, attrs?: Record<string, string>): void;
  gauge(name: string, value: number, attrs?: Record<string, string>): void;
  shutdown(): Promise<void>;
}

// ─── RBAC policy stores (§19) ─────────────────────────────────────────────────

import type { AgentMemoryAccess, ApprovalTrigger, SpecScope } from "./security.js";

export type AccessPolicyRecord = AgentMemoryAccess & { namespaces?: string[] };

export interface AccessPolicyStore {
  getPolicy(workspaceId: string, agentId: string): Promise<AccessPolicyRecord | null>;
  putPolicy(policy: AccessPolicyRecord): Promise<void>;
  listPolicies(workspaceId: string): Promise<AccessPolicyRecord[]>;
  /** Returns false when the agent had no policy in this workspace. */
  deletePolicy(workspaceId: string, agentId: string): Promise<boolean>;
}

export interface ApprovalRequestInput {
  workspaceId: string;
  requestedBy: string;
  trigger: ApprovalTrigger;
  resource: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
}

export interface ApprovalRequest extends ApprovalRequestInput {
  id: string;
  /** `consumed`: an approved request that has been carried out (APP-007). */
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  resolvedBy?: string;
  resolvedAt?: Date;
  createdAt: Date;
}

/**
 * How long a raised approval request waits for a human decision, and how long
 * an approval stays usable once granted (counted from the decision, not from
 * the request). Final review I6 of the 2026-11-22 audit.
 */
export const APPROVAL_PENDING_TTL_MS = 24 * 60 * 60_000;
export const APPROVAL_USE_TTL_MS = 60 * 60_000;

export interface ApprovalStore {
  create(input: ApprovalRequestInput): Promise<ApprovalRequest>;
  get(workspaceId: string, id: string): Promise<ApprovalRequest | null>;
  /**
   * Moves a pending, unexpired request to `status`. Resolves false when it was
   * no longer pending or had expired, so two resolvers cannot both win.
   */
  resolve(
    workspaceId: string,
    id: string,
    status: "approved" | "denied",
    resolvedBy: string
  ): Promise<boolean | void>;
  /**
   * APP-007 — spend an approved request on the request it was granted for:
   * atomically, only while approved and unexpired, only by the user who asked
   * for it, only for the same method and path. True when this call spent it.
   */
  consume(
    workspaceId: string,
    id: string,
    by: { requestedBy: string; method: string; path: string }
  ): Promise<boolean>;
}

// ─── WP8 (F10) — SOC2 break-glass two-person approval ─────────────────────────

export interface BreakGlassRequestInput {
  workspaceId: string;
  /** Admin A — the requester. */
  requestedBy: string;
  /** Free-text incident justification (audited). */
  reason: string;
  /** §6 scopes the grant covers (e.g. ["memory:export"]). */
  requestedScopes: SpecScope[];
  /** Grant validity ceiling (server-set; typically now + 15m). */
  expiresAt: Date;
}

export interface BreakGlassRequestRecord extends BreakGlassRequestInput {
  id: string;
  status: "pending" | "approved" | "denied" | "expired" | "used";
  /** Admin B — the approver. Set on approve(); MUST differ from requestedBy. */
  approvedBy?: string;
  approvedAt?: Date;
  usedAt?: Date;
  createdAt: Date;
}

export interface BreakGlassStore {
  /** Admin A files a pending request. */
  request(input: BreakGlassRequestInput): Promise<BreakGlassRequestRecord>;
  /**
   * Admin B approves. MUST throw if approverId === the request's requestedBy
   * (two-person / dual-control rule — a requester cannot self-approve).
   */
  approve(workspaceId: string, id: string, approverId: string): Promise<void>;
  /** Single fetch by id (audit + status checks). */
  get(workspaceId: string, id: string): Promise<BreakGlassRequestRecord | null>;
  /**
   * The active grant for a requester: status='approved', not expired, not yet
   * used. Returns null when none — the gate then 403s (or 202s on pending).
   */
  getActiveApproved(
    workspaceId: string,
    requestedBy: string
  ): Promise<BreakGlassRequestRecord | null>;
  /** Consume a grant (single-use): flips status→'used' and stamps usedAt. */
  markUsed(workspaceId: string, id: string): Promise<void>;
}

// ─── Wave X — Session token store (device binding + refresh-token rotation) ──

export interface SessionTokenRecord {
  id: string;
  workspaceId: string;
  actorId: string;
  /** SHA-256 hash of the plaintext refresh token. */
  tokenHash: string;
  /** SHA-256 of userAgent + acceptLanguage + ipNetwork. */
  deviceFingerprint: string;
  /** Set to the time of first use; null while still valid for first rotation. */
  usedAt: Date | null;
  /** Null = active family. Non-null = family revoked at this time. */
  familyRevokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface SessionTokenStore {
  /** Store a new refresh token hash for a given actor. */
  create(
    input: Omit<SessionTokenRecord, "id" | "usedAt" | "familyRevokedAt" | "createdAt">
  ): Promise<SessionTokenRecord>;
  /** Look up a token by its SHA-256 hash (exact match, workspace-scoped). */
  findByHash(workspaceId: string, tokenHash: string): Promise<SessionTokenRecord | null>;
  /** Mark a token as used (sets usedAt = now). */
  markUsed(id: string, workspaceId: string): Promise<void>;
  /** Revoke the entire family rooted at the given token id. */
  revokeFamily(rootId: string, workspaceId: string): Promise<void>;
  /** Delete all expired tokens for housekeeping. */
  purgeExpired(workspaceId: string): Promise<number>;
}

// ─── Idempotency port ──────────────────────────────────────────────────────

export type BeginResult =
  | { state: "new" }
  | { state: "replay"; responseCode: number; responseBody: string }
  | { state: "in_flight" }
  | { state: "mismatch" };

/**
 * Stripe-pattern recovery points for multi-phase mutating operations
 * (spec §Idempotency / RDD9, lines 3954-3964). A long op records its phase as
 * it advances so a crashed-then-retried request can skip completed phases.
 *   started         → key claimed, no work done yet (INSERT default)
 *   session_locked  → Phase 1 done: local bookkeeping committed (session marked collapsing)
 *   llm_called      → Phase 2 done: external LLM summarisation succeeded
 *   facts_persisted → Phase 3 done: knowledge units written to PG
 *   completed       → Phase 4 done: response persisted; future calls replay
 */
export const RECOVERY_POINTS = [
  "started",
  "session_locked",
  "llm_called",
  "facts_persisted",
  "completed",
] as const;
export type RecoveryPoint = (typeof RECOVERY_POINTS)[number];

export interface IdempotencyStore {
  /** Atomically claim the key. MUST run under SERIALIZABLE so concurrent dupes collide. */
  begin(workspaceId: string, key: string, requestHash: string): Promise<BeginResult>;
  /** Persist the final response for future replays. Sets recovery_point='completed'. */
  complete(
    workspaceId: string,
    key: string,
    responseCode: number,
    responseBody: string
  ): Promise<void>;
  /**
   * Advance the recovery point for an in-flight key (idempotent: re-recording the
   * same phase is a no-op). Used by multi-phase ops (session collapse) to mark
   * progress so a retry can skip completed phases. No-op if the key row is absent.
   */
  recordPhase(workspaceId: string, key: string, phase: RecoveryPoint): Promise<void>;
  /** Read the current recovery point, or null if the key is unknown. */
  getRecoveryPoint(workspaceId: string, key: string): Promise<RecoveryPoint | null>;
}

/** Atomic, lease-fenced managed extraction persistence. */
export interface ManagedCollapsePort {
  commitManagedCollapse(input: {
    operationId: string;
    workspaceId: string;
    sessionId: string;
    generation: number;
    leaseOwner: string;
    plan: import("./managed-collapse.js").ManagedCollapsePlan;
  }): Promise<import("./harness.js").ManagedCollapseCommitResult>;
}

export interface ManagedSessionWorkerPort {
  isHarnessIngestionEnabled(input: { workspaceId: string }): Promise<boolean>;
  disableHarnessIngestion(input: {
    workspaceId: string;
  }): Promise<{ ingestionEnabled: false; fenceEpoch: number }>;
  heartbeatManagedCollapseLease(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<boolean>;
  claimManagedCollapseEffects(input: {
    workspaceId: string;
    leaseOwner: string;
    limit: number;
    leaseMs: number;
  }): Promise<import("./managed-collapse.js").ManagedEffectClaim[]>;
  completeManagedCollapseEffect(input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
  }): Promise<boolean>;
  retryManagedCollapseEffect(input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
    error: string;
    baseRetryMs: number;
    maxRetryMs: number;
  }): Promise<boolean>;
  runManagedCollapseEffect(
    input: { workspaceId: string; id: string; leaseOwner: string },
    apply: (ports: { storage: StorageAdapter; outbox: OutboxAdapter }) => Promise<void>
  ): Promise<boolean>;
}
