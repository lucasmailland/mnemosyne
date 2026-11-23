// packages/core/src/index.ts
//
// Public API barrel for @mnemo-ai/core.
// Multi-tenant cognitive memory architecture for AI agents.
// See docs/specs/2026-05-24-mnemosyne-design.md (mirrored under the
// new monorepo's docs/ tree).

export { WorkingMemory } from "./session/working-memory.js";
export type { WorkingMemoryMetrics } from "./session/working-memory.js";
export {
  SessionBuffer,
  SESSION_TTL_SECONDS,
  MAX_BUFFERED_TURNS,
  sessTurnsKey,
  sessScratchKey,
  sessActiveKey,
} from "./session/session-buffer.js";
export type { SessionScratchStore } from "./session/session-buffer.js";
export { preinjectAnticipation, ANTICIPATION_SLOT } from "./session/anticipation-preinject.js";
export type { CollapsePolicy } from "./session/collapse.js";
export { resolveCollapsePolicy, DEFAULT_COLLAPSE_POLICY } from "./session/collapse-policy.js";
export {
  explicitSignal,
  taskCompletionSignal,
  heuristicSignal,
  computeOutcome,
} from "./cognitive/outcome-signal.js";
export type { OutcomeSignal } from "./cognitive/outcome-signal.js";
export { sensitivityAllowed, RECALL_RRF_K } from "./cognitive/recall-cold.js";
// WP-3 — recall relevance: the calibrated "nothing relevant" floors and the
// typed strict-semantic failure (CHAOS-5) the HTTP layer maps to a 503.
export {
  DEFAULT_RELEVANCE_FLOORS,
  defaultRelevanceFloor,
  normalizeEmbedModel,
  SemanticSearchUnavailableError,
  isSemanticSearchUnavailableError,
} from "./cognitive/recall-relevance.js";

// p60-corecall-stdp-convergence — `recordCoRecall` is the SOLE co-recall STDP
// writer (a server-side duplicate pass has been deleted). Exported so hosts
// and cross-layer regression tests can invoke the real function instead of
// re-implementing its pairing/cap/ordering policy.
export { recordCoRecall, CO_RECALL_TOP_K } from "./cognitive/co-recall.js";
// p60-corecall-stdp-convergence PR2 — co-recall tail-measurement hook (D3),
// same host-wiring pattern as OnHotTierEvict/OnCacheError.
export type { OnCoRecallTail, CoRecallTailReport } from "./cognitive/context.js";

// topicKey-suggest-and-hit-freshness slice (b) — pure, deterministic
// `topicKey` derivation. Consumed by `POST /topic-key/suggest` and the
// `memory_suggest_topic_key` MCP tool (proxy only, no local computation).
export {
  suggestTopicKey,
  CANONICAL_TOPIC_KEY,
  TOPIC_KEY_STOPWORDS,
  type SuggestTopicKeyInput,
  type TopicKeySuggestion,
} from "./cognitive/topic-key.js";

// topicKey-suggest-and-hit-freshness slice (c) — pure, deterministic
// per-hit staleness bucketing (valid-time). Stamped by recall-cold.ts's
// `buildResponse()`; exported here for tests and direct consumers.
export { hitFreshness, HIT_FRESHNESS_DAYS } from "./cognitive/freshness.js";
// P135 — scopeRef ↔ project entities (writes canonicalize, reads match every spelling).
export { resolveProjectScopeRef, withProjectScope } from "./cognitive/project-scope.js";
export type { ProjectScopeResolution } from "./cognitive/project-scope.js";

// make-primitives-recallable (PR1, design.md D1) — the shared, port-only
// write-path indexing helper `remember()` uses for kinds not already
// enqueued in-transaction by their own repository (see RECALLABLE_KINDS in
// @mnemo-ai/types). Exported for tests and direct consumers.
export {
  projectPrimitiveText,
  enqueuePrimitiveIndex,
  type EnqueuePrimitiveIndexParams,
} from "./cognitive/indexing.js";

// flatten-legacy-dual-core Phase 7: `createCore` (the legacy `CoreContract`/
// `CoreLike` factory, `./factory.ts`) is DELETED together with `factory.ts`/
// `factory-types.ts`/`factory-mappers.ts` — @mnemo-ai/server's HTTP routes
// have been off `deps.core` since PR18 (design.md D4, tasks.md Phase 6/7).
// `createApiKeyLookup`/`assertSafeDbRole` are NOT part of that deletion —
// they are the auth-bootstrap primitives (`api-key-lookup.ts`, one of the
// two permanent, documented infra-importing exceptions alongside `tx.ts` —
// CLAUDE.md "RLS mechanics") that `factory.ts` used to merely re-export.
export {
  createApiKeyLookup,
  assertSafeDbRole,
  type CoreApiKeyLookup,
  type CreateApiKeyLookupOptions,
  type ApiKeyLookupResult,
} from "./api-key-lookup";

// v2.0 — DB surface. Re-exported so a consumer can do
//   import { schema, setDb, type DbClient } from "@mnemo-ai/core";
// without also reaching for the `/db` subpath. The subpath export
// stays available for callers that only need the schema (e.g.
// migration tooling) and want to avoid pulling the rest of the
// library tree into their bundle.
export { schema, setDb, getDb, type DbClient, type Tx as DbTx } from "./db";

// Transaction wrapper — sets `app.workspace_id` GUC + downgrades to
// app_user role so RLS+FORCE Pattern A actually enforces. Host crons
// and agent-runtime callers use this to wrap any tenant-scoped DB
// access (see ADR-0010 for the role-downgrade rationale).
//
// v1.6 — `MnemoTxOptions` lets callers opt into per-actor isolation
// (sets `app.actor_id` + flips `app.enforce_actor_isolation`). The
// plain `withMnemoTx(workspaceId, fn)` form is preserved for every
// legacy caller via overload.
export {
  withMnemoTx,
  withMnemoTenantTx,
  type Tx,
  type MnemoTxOptions,
  type MnemoTenantTxOptions,
} from "./tx";

// Memory Protocol v1 — frozen system-prompt artifact injected by the host
// agent runtime so every agent knows how/when to use mnemosyne_* tools.
// Bumping MEMORY_PROTOCOL_VERSION invalidates extractions tagged with the
// prior version (see §13 of the design spec).
//
// v1.6 — `MEMORY_PROTOCOL_V1` now aliases the v1.2 string (entity
// awareness + per-user privacy paragraphs appended). Explicit
// `MEMORY_PROTOCOL_V2` exported for callers that want the unambiguous
// name; `MEMORY_PROTOCOL_V1_1` keeps the verbatim v1.1 text for replay
// jobs.
export {
  MEMORY_PROTOCOL_V1,
  MEMORY_PROTOCOL_V2,
  MEMORY_PROTOCOL_V1_1,
  MEMORY_PROTOCOL_VERSION,
  MEMORY_PROTOCOL_V1_LEGACY,
  // v1.1 #28 — anti-pattern guidance for memory tool usage; separate
  // from the version-locked protocol so iteration doesn't invalidate
  // extraction metadata.
  MEMORY_RECALL_GUIDANCE,
} from "./protocol/v1";

// PII detection / redaction — regex-only layer (§5.4 of the design spec).
// NER + LLM layers are optional add-ons (Phase 5.2 / 5.3).
export { detectPII, type PIIDetectionResult } from "./pii/detect";
export { redactPII, redactPIIWithCategories, type RedactPIIResult } from "./pii/redact";
export { PII_PATTERNS, PII_SEVERITY, type PIICategory } from "./pii/patterns";

// Wave X — Active Security Detection.
export {
  scoreInjection,
  DEFAULT_INJECTION_THRESHOLD,
  type InjectionScore,
  scoreAnomaly,
  DEFAULT_ANOMALY_THRESHOLD,
  type AnomalyInput,
  wrapCacheValue,
  unwrapCacheValue,
  CachePoisoningError,
  type TaggedCacheValue,
  ipInCidr,
  ipToBig,
  deviceFingerprint,
  hashToken,
  decideRefresh,
  workspaceAclUsername,
  workspaceAclRule,
  detectKeyAnomaly,
  type KeyAnomalyInput,
  type KeyAnomalyResult,
  type KeyAnomalyReason,
  generateTotp,
  generateTotpSecret,
  verifyTotp,
  addEmbeddingNoise,
  type EmbeddingNoiseConfig,
  type EmbeddingNoiseMode,
} from "./security/index.js";

// Context-poisoning detector — pre-embedding ingest gate.
export {
  scanForPoisoning,
  MAX_FACT_BYTES,
  MIN_POISON_SEVERITY,
  ENTROPY_THRESHOLD,
  ENTROPY_MIN_LENGTH,
  POISONING_PATTERNS,
  POISONING_SEVERITY,
  type PoisoningFinding,
  type PoisoningScanResult,
  type PoisoningCategory,
} from "./poisoning";
export { PoisoningRejectedError } from "./poisoning";
// SEC-2: the write-time gate remember() runs, for every other write path.
export { applyIngestSafety, piiMetadata, type IngestSafetyResult } from "./ingest-safety.js";

// flatten-legacy-dual-core Phase 8: `saveFactWithCandidates`
// (conflict/fact-candidate.ts) and `saveFactWithAutoResolve`'s `SaveResult`
// (conflict/auto-resolve.ts) are DELETED — confirmed orphaned (zero callers
// via @mnemo-ai/core's public surface; the v3 write path's conflict handling
// runs through cognitive/remember.ts's own pipeline). `decideAutoResolution`
// (the drizzle-free, pure decision core both files wrapped) survives —
// see design.md D5 / apply-progress.md PR20.
export { decideAutoResolution } from "./conflict/decide.js";
export type { AutoResolveAction, ConflictFactView } from "./conflict/decide.js";

// §39 Operational Modes — Graceful Degradation. Pure-code resolver from a
// capability snapshot (has LLM / has embed) to one of A / B / C, plus a
// health-aware resolver that combines configured capabilities with live
// provider health for graceful degradation under outage (v1.1).
export {
  resolveModeFromCapabilities,
  resolveConfiguredMode,
  resolveActiveMode,
  type MnemoMode,
  type CapabilitySnapshot,
  type ActiveModeResult,
  type ResolveActiveModeInput,
  type PartialAvailability,
  type DegradationReason,
} from "./modes/detect";

// Provider health tracker (in-memory rolling-window). Feeds
// `resolveActiveMode`. See packages/mnemosyne/src/modes/health.ts for
// the window policy + HMR-safe stash details.
export {
  recordProviderResult,
  getProviderHealth,
  resetProviderHealth,
  type ProviderKind,
  type ProviderHealth,
  type ProviderHealthSample,
} from "./modes/health";

// flatten-legacy-dual-core Phase 8: `./recall/search` (v1.1/v2 hybrid
// recall over `mnemo_fact` — `searchMnemo`/co-location boost/multi-term
// boost/etc.) is DELETED — confirmed orphaned: zero callers anywhere in
// the repo outside this barrel. The v3 7-stage hybrid recall pipeline
// (`@mnemo-ai/core/cognitive`'s `recallCold`/`recallHot`) is the live
// implementation — see `docs/architecture/COGNITIVE_ALGORITHMS.md`.
// Breaking change to @mnemo-ai/core's public export surface — see
// CHANGELOG.

// v1.1 — Per-stage recall telemetry callback contract. Host wires
// `SearchMnemoInput.onMetric` to its `recordMetric` infrastructure
// (Sentry distributions, OTel, Prometheus push). Stages are
// enumerable so dashboards can pre-declare panels — see
// `RecallStage` for the locked set of strings.
export {
  previewStatement,
  RECALL_SAMPLE_PREVIEW_MAX,
  type OnRecallMetricFn,
  type RecallMetricEvent,
  type RecallSample,
  type RecallStage,
} from "./recall/telemetry";

// v2 — trust ladder for `mnemo_relation.provenance`. Extends v1.1 #11
// without a schema migration (the column was always free text).
// Surfaced for host UI / Inspector / admin tools that want to
// classify edge trust at the boundary.
export {
  classifyTrustRung,
  trustDecay,
  TRUST_LADDER_DECAY,
  type TrustLadderRung,
} from "./recall/trust-ladder";

// v2 — per-stage adaptive cap proposal (spec §7). Pure-function
// library; NOT wired into `runSearchPipeline` yet — calibration is
// gated on 4 weeks of v1.1 telemetry. Surfaced so dashboards and
// tests can reason about the proposed numbers.
export {
  STAGE_CAP_BY_TIER,
  factCountTier,
  drawerGrepCapForFactCount,
  firstStageCapForFactCount,
} from "./recall/stage-caps";
export type { TieredFactCountBucket } from "./recall/cap-tiers";

// v1.1 query preparation: paraphrase + HyDE to fix the query-fact
// embedding mismatch (questions vs. statements live in different
// vector-space regions). Both transforms are LLM-backed and opt-in.
export {
  prepareQuery,
  type LlmCallFn,
  type QueryPrepInput,
  type PreparedQuery,
} from "./recall/query-prep";

// v1.1 cross-encoder reranking. `noopRerank` is the safe identity
// default; `makeCohereRerank` is a turn-key adapter for hosts with a
// Cohere key. Charter §25: model is overridable per-call.
export {
  noopRerank,
  makeCohereRerank,
  makeLocalLexicalRerank,
  type RerankFn,
  type RerankInput,
  type CohereRerankOptions,
} from "./recall/rerank";

// v2.1 — opt-in trust decay multiplier for rerank (AGT borrow).
export {
  effectiveTrust,
  DECAY_HALF_LIFE_DAYS,
  runRerank,
  type EffectiveTrustInput,
  type RerankableHit,
  type RunRerankInput,
} from "./recall/trust-decay";

// v1.1 compact rendering — groups facts by kind and condenses
// statements into k:v notation for prompt-budget-aware injection.
export { renderFactsCompact, type CompactRenderOptions } from "./recall/render";

// flatten-legacy-dual-core Phase 9 (task 9.3): `./primitives/fact-async`
// (v1.1 cost optimization — `createFactAsync`/`EMBED_FACT_JOB_NAME`) is
// DELETED — confirmed orphaned: re-exported here but zero callers anywhere
// in the repo outside this barrel, and its only internal dependency
// (`createFact`) was itself dead and deleted together with
// `primitives/fact.ts`'s CRUD surface. Breaking change to @mnemo-ai/core's
// public export surface — see CHANGELOG.

// Host adapter contracts (queue callback, etc.). Keep mnemosyne pure —
// the host supplies the concrete enqueue implementation.
//
// v1.4 — `Attribution` is the theory-of-mind discriminator surfaced
// on every fact (`MnemoFact.attribution`) and accepted by
// `searchMnemo({ attributionFilter })`. See migration 0035 +
// `src/types.ts` for the cognitive vocabulary.
export type { EnqueueFn, Attribution } from "./types";

// v1.1 Layer 2 trigger classifier — pure heuristic, no LLM/DB call.
// The agent runtime consults this on EVERY turn before deciding to
// perform a dynamic recall search; the goal is to skip recall on
// ~50% of turns that don't need it ("ok", "thanks") while staying
// generous on anything that looks like it references past context.
export {
  shouldTriggerRecall,
  type ShouldTriggerRecallInput,
  type TriggerDecision,
} from "./recall/triggering";

// flatten-legacy-dual-core Phase 7: `./summary` (Layer 1 distilled user
// profile — `getOrComputeSummary`/`distillFacts`/etc.) is DELETED —
// confirmed orphaned: re-exported here but invoked by zero of the
// registered cron jobs in `server/src/cron/jobs.ts` and zero routes. This
// is a breaking change to @mnemo-ai/core's public export surface (no
// in-repo caller; proposal.md Priority Decision #2 — no external contract
// obligates keeping it). See CHANGELOG.

// flatten-legacy-dual-core Phase 9 (task 9.1, Requirement 4): `./health`
// (v1.2 memory drift detection — `getHealthSnapshot`/`computeHealthSnapshot`/
// `persistHealthSnapshot`) is DELETED. Ported to the v3 `StorageAdapter` port
// (`getHealthSnapshot` on `@mnemo-ai/types`, implemented by
// `@mnemo-ai/adapter-postgres`'s `HealthRepository`) — `routes/admin.ts`,
// `routes/governance.ts`, and the `mnemo.health.snapshot` cron now call
// `deps.storage.getHealthSnapshot(...)` instead of importing this module
// directly. Breaking change to @mnemo-ai/core's public export surface — see
// CHANGELOG.

// flatten-legacy-dual-core Phase 7: `./janitor` (Mnemosyne v1.2 semantic
// dedup + inactive-pruning) is DELETED — confirmed orphaned, same standard
// as `./summary` above: re-exported here but invoked by zero cron jobs and
// zero routes. `UnionFind` (the one genuinely-reused internal helper) was
// extracted to `./consolidation/union-find.ts` before deletion so
// `consolidation/cluster.ts`'s dependency on it survives unchanged. Breaking
// change to @mnemo-ai/core's public export surface — see CHANGELOG.

// flatten-legacy-dual-core Phase 8: `./review` (v1.3 active-learning review
// queue + auto-pin rules — `enqueueReview`/`listReview`/`resolveReview`/
// `decideAutoPin`/etc.) is DELETED — confirmed orphaned: re-exported here
// but zero callers anywhere in the repo outside this barrel.
// `packages/server/src/routes/review.ts` already serves the SAME physical
// `mnemo_review_queue` table through @mnemo-ai/types's `StorageAdapter`
// port (`@mnemo-ai/adapter-postgres`'s own repository) — this legacy
// module was a fully redundant duplicate implementation, the same
// dual-model pattern this whole change retires elsewhere. Breaking change
// to @mnemo-ai/core's public export surface — see CHANGELOG.

// Mnemosyne v1.4 — "The Cognitive Leap".
//
// `MemoryType` separates facts the way human cognition does:
//   • semantic    — durable factual knowledge ('Lucas prefers TS').
//   • episodic    — events tied to a specific moment, linked to
//                   `mnemo_episode`.
//   • procedural  — how-to ('when X happens, do Y').
//   • working     — current conversation only; ephemeral.
//
// flatten-legacy-dual-core Phase 8: `createEpisode`/`getEpisode`/
// `listEpisodes`/`linkFactToEpisode` (episode/{store,query,index}.ts) are
// DELETED — confirmed orphaned (zero callers anywhere outside this barrel;
// the v3 episode primitive is served by `@mnemo-ai/core/cognitive` +
// `@mnemo-ai/adapter-postgres`'s own repository). `episode/synthetic.ts`'s
// synthetic-episode-id helpers survive and are re-exported directly:
// `primitives/fact.ts`'s `createFact` still calls `deriveSyntheticEpisodeId`
// to satisfy migration 0051's `episode_id` NOT NULL invariant. Breaking
// change to @mnemo-ai/core's public export surface — see CHANGELOG.
export {
  syntheticEpisodeIdForMessageTurn,
  syntheticEpisodeIdForDocument,
  syntheticEpisodeIdForDay,
  deriveSyntheticEpisodeId,
  type DeriveSyntheticEpisodeIdInput,
} from "./episode/synthetic";

// flatten-legacy-dual-core Phase 8: `./policy` (v1.4 per-agent memory
// policy — `DEFAULT_AGENT_MEMORY_POLICY`/`applyPolicyToRecall`/etc.) is
// DELETED — confirmed orphaned: re-exported here but zero callers anywhere
// in the repo outside this barrel. Breaking change to @mnemo-ai/core's
// public export surface — see CHANGELOG.

// flatten-legacy-dual-core Phase 8: `./recall/unified` (v1.4 unified KB +
// Memory recall — `recallUnified`) is DELETED — confirmed orphaned: zero
// callers anywhere in the repo outside this barrel, and it depended on the
// now-also-deleted `./recall/search`. Breaking change to @mnemo-ai/core's
// public export surface — see CHANGELOG.

// flatten-legacy-dual-core Phase 8: `./consolidation` (v1.4 REM-style
// clustering — `findConsolidationClusters`/`consolidateCluster`/
// `clusterCrossWorkspace`/etc.) is DELETED — confirmed orphaned: zero
// callers anywhere in the repo outside this barrel (the live
// `@mnemo-ai/consolidation` package is entirely separate infrastructure —
// gate + replay validator + scheduler, never imported this module).
// Breaking change to @mnemo-ai/core's public export surface — see
// CHANGELOG.

// Mnemosyne v1.6 "True 10/10" — additive type exports.
//
// `EmbeddingTier` is the discriminator that pre-classifies a fact so the
// batch worker can group pending facts and issue one API call per
// (workspace, tier). flatten-legacy-dual-core Phase 9 (task 9.3): sourced
// from `./primitives/fact-types` now — the types-only split of the deleted
// `./primitives/fact` (its dead CRUD functions, including the
// `CreateFactInput`/`CreateFactAsyncInput` this comment used to reference,
// were removed; see CHANGELOG).
export type { EmbeddingTier } from "./primitives/fact-types";

// flatten-legacy-dual-core Phase 8: `./entity` (v1.6 G2 entity primitive —
// `createEntity`/`getEntity`/`updateEntity`/`findOrCreate`/unresolved-mention
// queue/etc.) is DELETED — confirmed orphaned: re-exported here but zero
// callers anywhere in the repo outside this barrel. The v3 entity primitive
// (`POST /entities` et al.) is served entirely by
// `@mnemo-ai/adapter-postgres`'s own `EntityRepository` via the
// `StorageAdapter` port — this legacy module was a fully redundant
// duplicate implementation over the same `mnemo_entity` table, the same
// dual-model pattern this whole change retires elsewhere. Breaking change
// to @mnemo-ai/core's public export surface — see CHANGELOG.

// A1 — Heuristic extraction pre-filter. Pure code, zero cost. Wired
// into extract-job to skip ~80% of LLM extraction calls on turns with
// no durable-fact signal (greetings, smalltalk, pure ACKs). Saves the
// majority of the per-turn extraction spend on noisy workspaces.
// See packages/mnemosyne/src/extraction/prefilter.ts for the rule set.
export {
  shouldExtract,
  shouldExtractBackfill,
  type PrefilterMessage,
  type PrefilterResult,
} from "./extraction/prefilter";

// v1.1 #29 — LongMemEval benchmark harness (metrics + fixtures).
// Imported by the benchmark spec and by host-side evaluation scripts.
export {
  evaluateQuestion,
  computeCategoryMetrics,
  aggregateResults,
  formatBenchmarkReport,
  BENCHMARK_QUESTIONS,
  getFixture,
  fixturesByCategory,
  type GroundTruth,
  type EvalHit,
  type QuestionResult,
  type BenchmarkResult,
  type CategoryMetrics,
  type BenchmarkQuestion,
  type BenchmarkFact,
} from "./benchmark";

// flatten-legacy-dual-core Phase 9 (task 9.3): `./index/pointer` (v1.1 #1+2
// pointer index + drawer-grep — `extractPointerTerms`/`upsertPointerTerms`/
// `lookupPointer`/`rebuildPointerIndex`) is DELETED — confirmed orphaned:
// re-exported here but zero callers anywhere in the repo outside this
// barrel (`upsertPointerTerms`'s only caller was the also-deleted
// `primitives/fact.ts`'s `createFact`). The v3 recall pipeline has its own,
// separate, already-pure pointer-term extraction
// (`packages/core/src/cognitive/recall-pointer.ts`), unaffected. Breaking
// change to @mnemo-ai/core's public export surface — see CHANGELOG.

// Decision BOM — explainable recall record (AGT borrow).
export {
  composeBOM,
  completenessScore,
  REQUIRED_BOM_FIELDS,
  type DecisionBOM,
  type ComposeBOMInput,
  type BOMAuditSlice,
  type BOMTraceSlice,
  type BOMPolicySlice,
  type BOMTrustSlice,
  type BOMIdentitySlice,
  type BOMOutcomeSlice,
} from "./bom";

// ─────────────────────────────────────────────────────────────────────────────
// v1.6 — storage adapter layer (foundation for v2.0 multi-backend support).
//
// These exports are the NEW, FORWARD path for consumers who want to use
// Mnemosyne with a non-Drizzle backend (Prisma, raw `pg`, edge runtimes).
// The legacy direct exports (`withMnemoTx`, `searchMnemo`, …) continue to
// work unchanged.
//
// See packages/mnemosyne/src/storage/types.ts for the interface contract
// and packages/mnemosyne/README.md "Using Mnemosyne in another product"
// for the three integration paths.
// ─────────────────────────────────────────────────────────────────────────────

export {
  MnemoCapabilityError,
  type MnemoStorage,
  type MnemoFactRecord,
  type VectorSearchInput,
  type VectorSearchHit,
  type FtsSearchInput,
  type FtsSearchHit,
} from "./storage/types";

// flatten-legacy-dual-core Phase 8: `createDrizzleStorage`
// (storage/drizzle.ts) is DELETED — confirmed orphaned: zero callers
// anywhere in the repo outside this barrel. `storage/client.ts`'s
// `createMnemoClient` never referenced it either (verified by inspection).
// Breaking change to @mnemo-ai/core's public export surface — see
// CHANGELOG.

export {
  createMnemoClient,
  type MnemoClient,
  type MnemoClientOptions,
  type RecallInput,
  type RecallHit as ClientRecallHit,
} from "./storage/client";

// Prospective memory evaluator — time-based and semantic reminder triggers.
// Background pollers and the recall pipeline both call evaluatePendingReminders;
// ReminderEvalContext carries the injected StorageAdapter so the evaluator
// itself never touches the DB directly (hexagonal invariant).
export {
  evaluatePendingReminders,
  type ReminderEvalContext,
  type ReminderLlmPort,
  type TriggeredReminder,
} from "./reminders/evaluator";

// Memory Graph — framework-agnostic CLIENT-SAFE primitives (canvas
// drawing, types, layout, colors — zero DB).
//
// flatten-legacy-dual-core Phase 8: the SERVER-ONLY half
// (`buildGraphData`/`buildGraphQuery`, `./graph/server`, the
// `./graph/{query,relation,semantic-neighbors,traverse}.ts` legacy
// assembly it depended on) is DELETED — confirmed orphaned: zero
// callers anywhere in the repo, including the `@mnemo-ai/core/graph/server`
// public subpath (removed from `package.json#exports` and
// `tsup.config.ts` in the same commit). The v3 graph surface
// (`GET /graph`, `/graph/traverse`, `/graph/path`) is served by
// `@mnemo-ai/core/cognitive`'s pure-core BFS (design.md D6.5) +
// `@mnemo-ai/adapter-postgres`'s `getGraphSnapshot`/
// `backfillSemanticNeighbors`. Breaking change to @mnemo-ai/core's public
// export surface — see CHANGELOG.
export {
  drawNode,
  drawEdge,
  nodeRadius,
  defaultForceConfig,
  ENTITY_KIND_COLOR,
  EDGE_STYLES,
  NODE_RADIUS_MIN,
  NODE_RADIUS_MAX,
  type GraphNode,
  type GraphEdge,
  type GraphResponse,
  type GraphQueryOptions,
  type GraphNodeKind,
  type GraphEntityKind,
  type NodeDrawOptions,
  type EdgeDrawOptions,
  type ForceConfig,
} from "./graph";

// §19 RBAC decision engine — pure, zero I/O
export { evaluateAccess } from "./cognitive/rbac-engine.js";
export type { AccessPolicy, AccessRequest, AccessDecision } from "./cognitive/rbac-engine.js";

// §6 Service-to-service federation JWT (EdDSA)
export { signServiceJwt, verifyServiceJwt, InMemoryJtiStore } from "./cognitive/service-jwt.js";
export type {
  ServiceJwtClaims,
  SignOptions,
  VerifyOptions,
  VerifyResult,
  JtiStore,
} from "./cognitive/service-jwt.js";

// §4 Internal event bus (spec §4 — pure in-process, hexagonally clean)
// EventBus uses MnemoEvent (bus envelope) — distinct from domain event entities in primitives.
export { createEventBus, channelMatches } from "./events/bus.js";
export type { EventBus, EventListener } from "./events/bus.js";

// §14 Procedural memory — metaprompt prompt-evolution engine
export { runProceduralOptimization, decideProceduralTransition } from "./cognitive/procedural.js";
export type {
  ProceduralOptimizationConfig,
  ProceduralOptimizationResult,
  ProceduralTransitionResult,
} from "./cognitive/procedural.js";

// §34.8 Queue Backpressure & Job Shedding (pure — no adapter imports)
export { JOB_PRIORITY, priorityOf, decideShed, isPaused } from "./resilience/queue-shedding.js";
export type { Priority, ShedState } from "./resilience/queue-shedding.js";

// §35 Monotonic per-workspace event IDs + WS replay buffer keys
export { EventIdGenerator, parseEventId, wsBufferKey } from "./resilience/event-id.js";
export type { ParsedEventId } from "./resilience/event-id.js";

// §36 Embedding-model migration engine (pure — no adapter imports)
export { detectStale, migrateWorkspace, EMBEDDABLE_TABLES } from "./resilience/embedMigration.js";
export type {
  EmbedMigrationStorage,
  EmbedMigrationEmbed,
  DetectStaleResult,
  MigrateWorkspaceResult,
  MigrateWorkspaceOpts,
} from "./resilience/embedMigration.js";

// §25.2 Neuro-dynamics — kind-differentiated decay half-lives (Record<DecayClass, number>).
// Distinct from DECAY_HALF_LIFE_DAYS (a single number from ./recall/trust-decay): this is
// the per-decay-class map consumed by host crons (e.g. server's reasoning-decay job).
export { DECAY_HALF_LIVES } from "./cognitive/neuro-dynamics.js";

// RDD-5: Learning-mode cold-start graduation helper (used by server cron).
export { runGraduationTick } from "./cognitive/graduation.js";
export type { GraduationTickResult } from "./cognitive/graduation.js";

export {
  prepareManagedCollapse,
  type PrepareManagedCollapseInput,
} from "./session/managed-collapse.js";
