// Recall and search types — API_SPECIFICATION.md §3, COGNITIVE_ALGORITHMS.md §5
// TASK-2004 deliverable. These are the consumer-facing query/result types.

import type { PrimitiveKind } from "./primitives.js";
import type { RelationVerb } from "./relations.js";
import type { Sensitivity } from "./common.js";
import type { DerivedInference } from "./compositionality.js";
import type { ActorType } from "./provenance.js";

// ─── Provenance ───────────────────────────────────────────────────────────────

// Provenance describes the epistemological origin of a memory.
// Maps to the `attribution` column in mnemo_fact plus federation sources.
export type Provenance =
  | "user_stated"
  | "user_belief"
  | "objective_fact"
  | "inferred"
  | "extracted" // Automatic extraction from conversation
  | "federation_received" // Arrived via cross-instance sync (always trust-capped at score 20)
  | "consolidation"; // Created by sleep-cycle consolidation worker

// ─── RecallQuery ──────────────────────────────────────────────────────────────

export interface RecallFilter {
  kinds?: PrimitiveKind[];
  tags?: string[];
  validAfter?: Date;
  validBefore?: Date;
  minWorth?: number;
  minConfidence?: number;
  sensitivity?: Sensitivity[];
  provenance?: Provenance[];
  entityId?: string;
  sessionId?: string;
  scope?: "global" | "conversation";
  /** Optional entity/project reference — filters to facts scoped to this entity id. */
  scopeRef?: string;
  /**
   * P135: other spellings of the project `scopeRef` names (its canonical name
   * and aliases). A row matches when its scope_ref is `scopeRef` or any of
   * these. Filled by the core from the workspace's `project` entities, never
   * by callers; ignored without `scopeRef`.
   */
  scopeRefAliases?: string[];
  /** P11 — when provided, restrict recall to facts attributed to this actor. */
  actorId?: string;
  /**
   * WP-3 (RECALL-6): exact ownership label ("user:<id>", "tenant:<id>",
   * "workspace:<id>"). Applied before ranking and pagination, so a personal-only
   * recall cannot be crowded out by workspace memories. A row with no
   * ownership label (legacy) never matches.
   */
  scopeOwner?: string;
}

/** Synthetic delivery is observable but must never train the organic corpus. */
export interface RecallEffectsContext {
  trafficOrigin: import("./session.js").TrafficOrigin;
  applyOrganicEffects: boolean;
}

export interface RecallQuery {
  effects?: RecallEffectsContext;
  workspaceId: string;
  text: string;
  embedding?: Float32Array; // Pre-computed; if absent, server calls EmbedAdapter
  filter?: RecallFilter;
  limit?: number; // Default: 10
  offset?: number;
  includeArchived?: boolean;
  materialiseInferences?: boolean; // When true, derived inferences are inserted into mnemo_fact
  conversationId?: string;
  /** Bitemporal time-travel recall timestamp. */
  asOf?: Date;
  /**
   * Also return items a federation sync pulled into the workspace, as hits with
   * `origin: "federation:<peer>"`. Only a surface that marks such a hit for its
   * caller sets it (POST /recall, and memory_recall through it); the others
   * would hand foreign content over as if it were local.
   */
  includeFederated?: boolean;
  /** When true, bypasses the worth serving gate (spec §11). Default: gate is ON. */
  includeLowWorth?: boolean;
  /**
   * Approximate remaining token budget (spec §17 CALMem ladder).
   * Controls which recall tiers are attempted:
   *   <500   → skip (return empty)
   *   <2000  → Tier 1 (hot) only, cap 3 hits
   *   <8000  → Tier 1+2 (hot+pointer), cap 5 hits
   *   ≥8000  → full hot→pointer→cold pipeline
   *   absent → full pipeline (backward compatible)
   */
  tokenBudget?: number;
  /** Opt-in LLM rerank of cold-recall hits (RecMem-gated). Default: off. */
  rerank?: boolean;
  /** Min recurrence signal among candidates to spend an LLM rerank call (spec §1/§2). Default 0.6. */
  recurrenceThreshold?: number;
  /** HyDE pre-step (arXiv:2212.10496): LLM writes a hypothetical answer doc; its
   * embedding is averaged with the query embedding before HNSW search. Default: off.
   * Degrades gracefully when ctx.llm is absent. Zero diff when false.
   */
  hyde?: boolean;
  /** B5.1 Explicit search mode: "lexical" | "semantic" | "hybrid" | "auto" (default: "auto"). */
  mode?: "lexical" | "semantic" | "hybrid" | "auto";
  /**
   * Opt-in raw cosine floor (0–1), applied to the semantic evidence of EVERY
   * candidate kind before ranking: facts, decisions and the other recallable
   * kinds, and entities. A candidate the semantic arm scored below it is
   * dropped even when the lexical arm also matched it. Hybrid's lexical-only
   * candidates (no cosine measured) remain eligible. Ignored by `lexical` mode,
   * which measures no cosine.
   */
  minSimilarity?: number;
  /**
   * WP-3 (RECALL-3): the cosine at or above which a hit counts as relevant for
   * `RecallResponse.nothingRelevant`. When some hit clears it, hits with a
   * measured cosine under it are dropped (APP-020); when none does, every hit
   * is still served and `nothingRelevant` is true. Cosine
   * scales are model-specific, so the server sets it from
   * `MNEMO_RECALL_RELEVANCE_FLOOR`; absent, core uses its calibrated default
   * for the embedding model (`defaultRelevanceFloor`), and for a model with no
   * calibration `nothingRelevant` only reports an empty result.
   */
  relevanceFloor?: number;
  /** Hybrid vector weight [0, 1] (0 = FTS-only, 1 = vector-only, 0.5 = blend). Deprecated in favor of mode. */
  vectorWeight?: number;
  /**
   * Hybrid FTS arm: after HNSW search, also query text_lemmatized (idx_fact_fts
   * from migration 0047) and merge unique candidates at minSimilarity baseline.
   * Default: off. Zero diff when false.
   */
  hybridFts?: boolean;
  /**
   * §36 — true when the workspace's embeddings are mid-migration to a new model.
   * When set, recall-cold leans on FTS (0.7) over vector (0.3). Derived at the
   * orchestrator/transport layer from detectStale(...).total > 0. Default
   * (undefined/false): normal weights (fts 0.4 / vector 0.6).
   */
  embeddingMigrationActive?: boolean;
  /**
   * P128 (internal) — "the embedder already failed for this request; do not
   * try again".
   *
   * Set only by `recallWithCaches` when its own `embedSingle` throws, so the
   * lexical fallback inside `recallCold` runs without paying the provider
   * timeout a SECOND time. Without it the delegation cost two failures back to
   * back — measured at 5.1s against a 5s circuit breaker, which turned a
   * working fallback into a 500 anyway.
   *
   * Not part of the public query surface: callers describe what they want,
   * not what already broke.
   */
  embedderUnavailable?: boolean;
  /**
   * Opt-in: when true the response's `debug.trace` lists the pipeline stages
   * that ran, with candidate counts and timings. Absent/false adds no timing work.
   */
  debug?: boolean;
}

/**
 * One pipeline stage of a traced recall (`debug: true`).
 *
 * The list is in canonical stage order, but `ms` is the time since the
 * previous stage in EXECUTION order (e.g. `cache` runs before `hot_tier`).
 * The hot tier times itself with `Date.now()` (whole ms); every other stage
 * uses `performance.now()`.
 * Under multi-level recall only the answering level's trace is returned.
 * A tier miss reports 0 candidates; `embed` always reports 1/1.
 * `lexical` and `nonfact_candidates` (hybrid cold path) report as
 * `candidatesOut` the candidates they ADDED, not the size of the set after them.
 *
 * Counts are null for every stage before `eligibility` unless the caller's
 * sensitivity ceiling admits every tier: those stages count candidates the
 * ceiling has not filtered yet. For such callers `eligibility` reports the
 * candidates that passed it as both `candidatesIn` and `candidatesOut`.
 */
export interface RecallTraceStage {
  name: string;
  candidatesIn: number | null;
  candidatesOut: number | null;
  ms: number;
}

// ─── RecallHit (CaMeL-style structured recall — NEW-02) ──────────────────────
//
// Security labels (sensitivity, injectionScore, contested) are SEPARATE
// fields — never interpolated inline into `content`. This prevents
// prompt injection from a crafted fact escalating its own trust level.

export interface RelationSummary {
  id: string;
  targetId: string;
  targetKind: PrimitiveKind;
  verb: RelationVerb;
  weight: number;
}

export interface RecallHit {
  id: string;
  primitive: PrimitiveKind;
  content: string; // The text of the recalled item

  /**
   * The ranking key, highest first. Not a probability and not comparable across
   * modes: in `semantic`/`auto` it is the cosine nudged by bounded priors
   * (worth ±5%, recent-recall activation ≤ +2%, injection demotion); in
   * `hybrid` it is a reciprocal-rank fusion of the semantic and lexical ranks;
   * in `lexical` it is the FTS rank. Use `similarity` to judge relevance.
   */
  score: number;
  /**
   * Raw cosine between the query and this memory's embedding, for every hit the
   * semantic arm measured — facts, decisions, other recallable kinds and
   * entities. Absent when none was measured: lexical-only hits, `lexical`
   * mode, and hot-tier hits (served on term coverage, without a vector pass).
   */
  similarity?: number;

  // Security labels (structured, never inline in content)
  sensitivity: Sensitivity;
  injectionScore: number; // 0–1; high = likely prompt injection
  provenance: Provenance;
  origin: "local" | `federation:${string}` | `plugin:${string}`;
  contested: boolean; // True if a contradicting fact exists

  // Bitemporal window
  validFrom: Date;
  validTo: Date | null;

  // Graph context
  tags: string[];
  relations: RelationSummary[];

  // Populated by recall-cold.ts viewFact — enables engine fact_kind matching (Wave H)
  worth?: number; // TD(λ) posterior; undefined until viewFact populates it
  worthLowerBound?: number; // Wilson-score 95% CI lower bound; undefined for non-facts
  factKind?: string; // fact sub-kind; undefined for non-fact primitives

  /**
   * Hyperedges this memory belongs to, as HINTS: `coMembers` names related
   * memories the caller may fetch. They are never added to `hits` — WP-3
   * (RECALL-2) removed that expansion, which injected co-members at the
   * trigger's score with no relevance check of their own.
   */
  hyperedges?: Array<{
    id: string;
    coMembers: string[]; // memberIds minus this memory's id
    label?: string;
    worth?: number;
  }>;

  // RecMem gate input (spec §1/§2, MEMORY_IMPROVEMENT.md:140, :1374).
  // Populated by recall-cold.ts ONLY when query.rerank===true, so the
  // recurrence signal (recmem.ts recurrenceSignal) can be computed over the
  // served set. Undefined on every other path — never leaked to the wire
  // (server mappers drop it). Number[] (not Float32Array) to keep the type
  // structural-cloneable and JSON-debuggable.
  embedding?: number[];

  // Scope fields — populated from the underlying fact when available.
  scope?: "global" | "conversation";
  scopeRef?: string;
  /**
   * Multi-tenant ownership label. Format: "workspace:<id>" | "user:<id>" | "tenant:<id>".
   * Absent on legacy facts created before scope_owner was introduced.
   * Used by multi-level recall to filter hits to their expected ownership tier.
   */
  scopeOwner?: string;
  /**
   * P11 — the actor credential that created this memory. Despite the old
   * comment here, this is NOT reliably a userId — it can be an API key's own
   * id, a namespaced ActorRef (`key:<id>`, `system:<component>`), or a
   * legacy unnamespaced string. Use `userId` below for the platform account,
   * when the caller needs that specifically. Null for rows created before
   * P11 was deployed (pre-attribution era).
   */
  actorId?: string | null;
  /** The platform account (mnemo_user.id) behind this memory's creation, when one exists. */
  userId?: string | null;
  actorType?: ActorType;
  /** B5.5 Lexical score (FTS rank signal). */
  lexicalScore?: number;
  /** B5.5 Vector score (HNSW cosine similarity signal). */
  vectorScore?: number;
  /**
   * topicKey-suggest-and-hit-freshness slice (c) — bucketed staleness of
   * this hit's `validFrom` (bitemporal valid-time axis), computed relative
   * to "now" at recall time: "current" (<7d) | "recent" (<30d) |
   * "aging" (<90d) | "stale" (>=90d).
   *
   * NOT the same concept as `memory_introspect`'s `SelfModel.confidenceMap[].freshness`
   * (metacognition.ts) — that one is an entity-level aggregate bucketing
   * `max(created_at)` (transaction-time) across a group of facts, sourced
   * from the `mv_confidence_map` materialized view. This field is a
   * per-hit bucket of a single primitive's own valid-time. The two use the
   * same 7/30/90-day thresholds by design (see
   * `packages/core/src/cognitive/freshness.ts`) but answer different
   * questions and must not be conflated.
   *
   * Optional so federation/consolidation `RecallHit` constructions that
   * don't go through `buildResponse()` keep compiling unchanged.
   */
  hitFreshness?: HitFreshness;
  /** WP-3 (AGENTSIM-4): the memory's topicKey, when it has one — reuse it to supersede. */
  topicKey?: string;
  /** WP-3 (AGENTSIM-4): what the fact is about (facts only). */
  subject?: string;
  /** WP-3 (AGENTSIM-4): lifecycle and dispute state — see {@link RecallHitStatus}. */
  status?: RecallHitStatus;
}

/**
 * WP-3 (AGENTSIM-4) — per-hit state, so an old value and the current one no
 * longer look the same:
 *   - `superseded`: the row is closed (`validTo` set) — superseded, replaced
 *     or forgotten. Only reachable with `includeArchived`.
 *   - `contested`: open, but on either end of an unresolved `conflicts_with`
 *     relation (what GET /conflicts lists and memory_judge resolves).
 *   - `active`: open and undisputed.
 */
export type RecallHitStatus = "active" | "superseded" | "contested";

/**
 * topicKey-suggest-and-hit-freshness slice (c) — per-hit staleness bucket.
 * See `RecallHit.hitFreshness` for the valid-time vs. transaction-time
 * naming-collision note against `SelfModel.confidenceMap[].freshness`.
 */
export type HitFreshness = "current" | "recent" | "aging" | "stale";

// ─── RecallResponse (API-level wrapper) ───────────────────────────────────────

export interface RecallResponse {
  hits: RecallHit[];
  total: number;
  query: {
    text: string;
    limit: number;
    offset: number;
  };
  latencyMs: number;
  fromHotTier: boolean; // True if result served from Redis ACT-R hot tier
  inferences?: DerivedInference[]; // Wave H: derived from composition rules, cold-path only
  /**
   * Search mode used to produce these hits.
   * "vector" — normal HNSW semantic search (embed adapter available).
   * "fts"    — full-text search fallback via text_lemmatized (no embed adapter configured).
   *            Results are ranked by ts_rank rather than cosine similarity.
   * Absent when the response came from the hot tier (fromHotTier: true).
   */
  searchMode?: "vector" | "fts" | "lexical" | "semantic" | "hybrid" | "auto";
  /**
   * WP-3 (RECALL-3 / AGENTSIM-15): true when recall found nothing that clears
   * the relevance floor — the hits, if any, are only the least-bad matches.
   * Computed over every eligible candidate before pagination, so an empty
   * offset page does not set it. Without a known floor (no
   * `relevanceFloor` and no calibrated default for the model, or a lexical
   * search, which has no cosine) it is true only when there are no hits.
   * Optional on the type for producers outside recall; recall always sets it.
   */
  nothingRelevant?: boolean;
  /** B5.10 Debug metadata for search execution tracing. */
  debug?: {
    modeRequested: string;
    modeUsed: string;
    spaceId?: string;
    tiersConsulted: string[];
    cacheHit: boolean;
    fallback: boolean;
    fusionApplied?: boolean;
    lexicalCandidateCount?: number;
    ftsFailed?: boolean;
    /** WP-3: the relevance floor `nothingRelevant` was judged against, when one applied. */
    relevanceFloor?: number;
    /** V-1: an LLM rerank was requested but failed or timed out; the hits are in first-stage order. */
    rerankDegraded?: boolean;
    /** Per-stage trace, present only when the query set `debug: true`. */
    trace?: RecallTraceStage[];
  };
}

// ─── Remember input (consumer-facing — wraps CreateFactInput etc.) ────────────

export type RememberKind = PrimitiveKind;

export interface RememberRequest {
  workspaceId: string;
  kind: RememberKind;
  /**
   * Type-specific subtype (PRIMITIVE_SUBTYPES). Only meaningful for
   * kind="fact" (preference|trait|event|relationship|skill|concern|
   * architecture|bugfix|config|discovery|policy|process|other),
   * kind="decision" (decision|architecture|policy|process|bugfix|learning|
   * discovery|config), and kind="entity" (person|organization|project|
   * concept|place|other) — ignored for every other kind. Unrecognized or
   * omitted values fall back to that kind's default subtype ("other" for
   * fact/entity, "decision" for decision).
   */
  subtype?: string;
  content: string; // Mapped to statement/body/narrative per kind
  subject?: string; // For facts
  /**
   * AGENTSIM-7 — kind="decision" only: the decision's title. Omitted → the
   * first sentence of `content` (capped at 120 characters). `content` is
   * always stored whole as the body; `subject`, which a decision has no
   * column for, is kept in its metadata.
   */
  title?: string;
  confidence?: number;
  conversationId?: string;
  agentId?: string;
  topicKey?: string; // Optional idempotency key — upsert facts on match (spec §25.4)
  sensitivity?: Sensitivity;
  provenance?: Provenance;
  tags?: string[];
  /**
   * The session this write happened during. Correlation only — no FK, on
   * purpose: it arrives unvalidated from the caller, and an FK would turn a
   * stale id into a LOST WRITE (DATA_MODEL.md §4.9).
   *
   * Supplying it is what makes the fact reachable by `linkSessionFactsToEpisode`
   * at collapse time, which back-fills `episodeId` — the canonical link — for
   * every fact written during the session. So a caller that passes `sessionId`
   * and nothing else still ends up with real origin context, without having to
   * know an episode id that does not exist yet.
   */
  sessionId?: string;
  /**
   * The episode this fact belongs to — the CANONICAL origin link, the only
   * fact→context edge with referential integrity, and the one
   * `preferSourceEpisode` reads on every cold recall (DATA_MODEL.md §4.9).
   *
   * Rarely needed directly: the normal path is to pass `sessionId` and let the
   * collapse fill this in. Use it to attach a fact to an episode that ALREADY
   * exists — a post-hoc correction, a backfill, an import.
   *
   * `mnemo_fact.episode_id` DOES have an FK, so an id that names no episode
   * would abort the insert and lose the write. `remember()` therefore verifies
   * the episode first and, when it does not exist, drops the link and keeps the
   * fact (P109). A missing link is recoverable — the collapse can still fill it
   * from `sessionId`. A lost write is not.
   */
  episodeId?: string;
  /**
   * kind="fact" only: when the fact became true in the world (valid time).
   * Omitted → the write instant. Never after it: the server refuses a future one.
   */
  validFrom?: Date;
  metadata?: Record<string, unknown>;
  /** Scope of the fact — default "global". Use "personal" (input-only shorthand) to store in the user's personal workspace. */
  scope?: "global" | "conversation" | "personal";
  /** Optional entity/project ref — pairs with scope to namespace facts (e.g. 'mnemosyne', 'project:abc'). */
  scopeRef?: string;
  /**
   * Ownership level for multi-tenant routing.
   * "workspace:<id>" | "user:<id>" | "tenant:<id>"
   * Default: "workspace:<workspaceId>".
   * Use "user:<userId>" for personal preferences, "tenant:<tenantId>" for company-wide facts.
   */
  scopeOwner?: string;
  /**
   * Host-side pre-computed embedding. When supplied, the cognitive engine
   * skips its own embed pass and stores this vector directly — the server
   * never needs its own LLM credentials for the write path. Must be the
   * same model/dimensionality as the workspace's recall embedding
   * (default: OpenAI text-embedding-3-small, 1536 dims).
   */
  precomputedEmbedding?: Float32Array;
}

/** One of the 3 verdict actions §33's deterministic resolver can produce for a contradicting fact. */
export type ConflictVerdictAction = "supersede" | "reject" | "review";

export interface RememberConflictCandidate {
  /** The EXISTING contradicting fact's id — never the newly written fact. */
  id: string;
  subject: string;
  statement: string;
  action: ConflictVerdictAction;
  /**
   * The pending `conflicts_with` relation id. THIS is the judgmentId passed to
   * `memory_judge action="resolve"` / `POST /conflicts/:id/resolve`. Present only
   * for "reject" | "review". Absent for "supersede" (already auto-resolved).
   */
  relationId?: string;
}

export interface RememberConflict {
  /** true iff at least one emitted candidate has action !== "supersede". */
  judgmentRequired: boolean;
  candidates: RememberConflictCandidate[];
}

/**
 * P122 — the subset of a written fact row that `POST /remember` reports back
 * instead of reconstructing. ISO strings, because that is the wire form and
 * converting once at the source beats converting at each consumer.
 */
export interface StoredWriteFacts {
  validFrom: string;
  /** `null` means the interval is open, i.e. the fact is currently valid. */
  validTo: string | null;
  createdAt: string;
  pinned: boolean;
  confidence: number | null;
  sensitivity: string;
}

export interface RememberResponse {
  id: string;
  kind: RememberKind;
  /**
   * Always false since P74. The surprise gate used to divert low-prediction-error
   * writes into a "staging queue" that had no table, no consumer and no promotion
   * step, returning a fabricated id for a row that was never written. Retained so
   * the wire shape is unchanged; there is no longer a code path that sets it true.
   */
  staged: boolean;
  actorId?: string; // Resolved actorId written to DB (P11 attribution)
  /**
   * CORE-6 / make-primitives-recallable (design.md D1/D2): whether `kind` is
   * indexed on write at all — i.e. `RECALLABLE_KINDS.includes(kind)`
   * (`@mnemo-ai/types`, `indexing.ts`). This is NOT a claim that the
   * embedding is already applied at the moment `remember()` returns: only
   * `kind:"fact"` writes its embedding synchronously
   * (`cognitive/remember.ts` Step 6a). Every other recallable kind (e.g.
   * `decision`) still relies on the async outbox worker draining its
   * `vector_upsert` entry — real, but bounded, latency before it is
   * semantically searchable. Callers that need "searchable right now" (an
   * immediate recall in the same request) should still only rely on that
   * guarantee for `kind:"fact"`. Kinds NOT in `RECALLABLE_KINDS` are never
   * indexed at all — `vectorSearchable: false` for those is permanent, not
   * a timing window.
   */
  vectorSearchable: boolean;
  /** Omitted entirely when no contradiction was detected (not null, not {}). */
  conflict?: RememberConflict;
  /**
   * P121 — the text that was ACTUALLY STORED, which is not always the text the
   * caller sent.
   *
   * `remember()` redacts PII before embedding and before insert (CORE-1), so a
   * statement containing a phone number is stored with `[REDACTED-phone]` in
   * its place. Until this field existed the caller had no way to learn that:
   * `POST /remember` rebuilt its response from the REQUEST, so it echoed the
   * original text back while the row held something else. An agent that wrote
   * a fact and recalled it two turns later got different text than it wrote,
   * with no signal that a transformation had happened — which reads as the
   * memory being wrong rather than as a redaction working correctly.
   *
   * Present on every write. Equal to the input when nothing was redacted.
   */
  storedContent: string;
  /**
   * P122 — the row's own values for the fields `POST /remember` used to
   * FABRICATE.
   *
   * The route builds its 201 body as a literal rather than projecting what was
   * written, and five of those fields were computed locally: `validFrom` and
   * `createdAt` from `new Date()` at response time, `pinned: false`,
   * `confidence: null`, and `sensitivity` from a constant. None of them was
   * wrong on the day it was written — they were claims that happened to match,
   * exactly as `statement` matched until PII redaction pulled the two apart
   * (P121). A response that is ASSEMBLED instead of REPORTED starts correct and
   * diverges silently; that is the shape, not the individual field.
   *
   * Absent when the write produced no fact row — the non-fact kinds
   * (`decision`, `episode`, `entity`, …) go through their own repositories and
   * the route has no fact to report. Absent means "not known here", never
   * "empty": callers must fall back rather than treat it as a zero value.
   */
  stored?: StoredWriteFacts;
  /**
   * P121 — PII categories redacted out of `storedContent`, in the order the
   * detector reports them. Omitted entirely when nothing was redacted, so its
   * presence is itself the signal; an empty array would make every caller
   * check length instead of existence.
   */
  redactedCategories?: string[];
  /**
   * CHAOS-5 — present (true) only when the embedder was unavailable: the row
   * was stored and its embedding queued for the outbox worker, so it is
   * findable by full-text search now and by semantic search once embedded.
   * Write-time conflict detection, which needs the vector, did not run.
   */
  embeddingDeferred?: boolean;
  /**
   * P135: how the request's `scopeRef` met the workspace's `project` entities.
   * `canonicalized` — it named a project (by name or alias, ignoring case) and
   * the canonical name was stored instead. `suggestion` — it named no project
   * but resembles one; it was stored as sent. Absent when neither applies.
   */
  scopeRefResolution?: {
    canonicalized?: { received: string; storedAs: string; entityId: string };
    suggestion?: { received: string; project: string; entityId: string };
  };
}

// ─── Recall observation (common port contract) ──────────────────────────────

export type RecallTrafficOrigin = "production" | "test" | "synthetic" | "unknown";
export type RecallObservationStatus = "ok" | "empty" | "error";

/** Request-level context supplied by the caller of recall. */
export interface RecallObservationContext {
  requestId: string;
  /** Authenticated actor (verified by auth). */
  verifiedActor?: { type: ActorType; id: string };
  /** Caller/tool/route as declared by the client; not verified. */
  declaredCaller?: string;
  trafficOrigin: RecallTrafficOrigin;
  /** Versions; "unknown" when not supplied. */
  clientVersion: string;
  pluginVersion: string;
  serverVersion: string;
}

export interface RecallRequestObservation extends RecallObservationContext {
  workspaceId: string;
  /** Validated session id, or null with the reason it was not accepted. */
  sessionId: string | null;
  sessionNullReason?: string;
  requestedFilters: { mode?: string; kinds?: PrimitiveKind[]; filter?: RecallFilter };
  effectiveFilters: { mode?: string; kinds?: PrimitiveKind[]; filter?: RecallFilter };
  tiers: string[];
  cacheHit: boolean;
  resultCount: number;
  /**
   * APP-015 — characters of memory content this recall served to the caller
   * (after projection and ceiling filtering): the context it put in front of
   * a model. Absent on observations recorded before it existed.
   */
  servedChars?: number;
  nothingRelevant: boolean;
  status: RecallObservationStatus;
  error?: string;
  /** Hash of the query text; raw text is never recorded in the request row. */
  queryHash: string;
  /**
   * Raw query text, written ONLY onto organic fact hit rows (`query_text`), the
   * column the legacy writer always filled: consolidation replay and
   * conditional anticipation learn from it. Never stored as request metadata.
   */
  queryText?: string;
  totalDurationMs: number;
  phaseDurationsMs: {
    embedding?: number;
    lexical?: number;
    semantic?: number;
    rerank?: number;
    cache?: number;
    [phase: string]: number | undefined;
  };
}

export interface RecallHitObservation {
  workspaceId: string;
  requestId: string;
  primitiveKind: PrimitiveKind;
  /** Text id (may be prefixed, e.g. `mepi_…`); never cast to UUID. */
  memoryId: string;
  /** Global zero-based rank in the final hits array. */
  rank: number;
  score: number;
  similarity?: number;
  tier?: string;
  /** TD(λ) credit for organic fact hits (0.7^rank); absent/0 otherwise. */
  tdCredit?: number;
}
