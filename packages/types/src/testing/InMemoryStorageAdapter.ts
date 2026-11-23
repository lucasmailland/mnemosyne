// InMemoryStorageAdapter — in-memory implementation of StorageAdapter for unit tests.
// TASK-15002, TESTING_STRATEGY.md §3.
//
// Allows @mnemo-ai/core unit tests to run without a database (<1s total).
// This is a TESTING UTILITY — not for production use.
// RLS is NOT enforced (all workspaces share the same maps).
// Outbox is captured in memory and can be inspected by tests.

import type { RecallHitObservation, RecallRequestObservation } from "../recall.js";
import type {
  StorageAdapter,
  StorageCapabilities,
  RecallMetrics,
  FactStats,
  SessionStats,
  AuditActivity,
  HealthSnapshotDay,
  AuditFeedStats,
  CreateSessionInput,
  CreateFactInput,
  UpdateFactInput,
  MergeFactByTopicKeyInput,
  MergeDecisionByTopicKeyInput,
  ReplaceFactInput,
  FindLiveFactByStatementInput,
  ReplaceFactResult,
  FactFilter,
  FactPageFilter,
  FactPage,
  FindContradictingFactsInput,
  ContradictingFact,
  CreateDecisionInput,
  UpdateDecisionInput,
  DecisionFilter,
  CreateEpisodeInput,
  UpdateEpisodeInput,
  EpisodeFilter,
  SimilarEpisode,
  SimilarEntity,
  CreateEntityInput,
  UpdateEntityInput,
  EntityFilter,
  SupersedeEntityInput,
  SupersedeDecisionInput,
  CreateStrategyInput,
  UpdateStrategyInput,
  StrategyFilter,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowFilter,
  CreateSkillInput,
  UpdateSkillInput,
  SkillFilter,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  CreateEventInput,
  EventFilter,
  CreateReasoningInput,
  UpdateReasoningInput,
  ReasoningFilter,
  CreateHyperedgeInput,
  UpdateHyperedgeInput,
  HyperedgeFilter,
  CreateRelationInput,
  RelationFilter,
  ApplyRelationJudgmentInput,
  ResolveConflictInput,
  ResolveConflictResult,
  RecallLogEntry,
  RecallPrecisionReport,
  CreateCompositionRuleInput,
  UpdateCompositionRuleInput,
  CompositionRuleFilter,
  AppendInferenceInput,
  InferenceLogFilter,
  UpsertFactHashInput,
  MaterialiseInferenceInput,
  UpsertFactLshInput,
  PointerCandidateQuery,
  PointerCandidate,
  FtsCandidate,
  PrimitiveCandidate,
  PrimitiveCandidateQuery,
  RecallPrimitiveRef,
  RecallPrimitiveRecord,
  RecallLogRecord,
  RecallStructures,
  PurgeFactsFilter,
  PurgeFactsResult,
  ApplyConsolidationMergeInput,
  ConsolidationMergeSnapshot,
  ReplayFailureReview,
  WorkspaceVitals,
  AuditFeedFilter,
  AuditFeedEntry,
  GetHealthSnapshotInput,
  HealthSnapshot,
  ActiveLearningReviewFilter,
  ActiveLearningReviewRow,
  EnqueueActiveLearningReviewInput,
  EnqueueActiveLearningReviewResult,
  ResolveActiveLearningReviewInput,
  ResolveActiveLearningReviewResult,
  LookupQueryCacheInput,
  InsertQueryCacheInput,
  HarnessIngestionPort,
  ManagedSessionLifecyclePort,
} from "../ports.js";
import type { HarnessEvent, HarnessEventAck, ManagedSessionProvenance } from "../harness.js";
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
  PrimitiveKind,
} from "../primitives.js";
import type {
  ManagedArchiveReason,
  ManagedCollapseRetry,
  ManagedLifecycleQuiesceResult,
  ManagedSessionClaim,
  MnemoSession,
  SessionTurn,
} from "../session.js";
import type {
  MnemoRelation,
  MnemoCitation,
  CitationFilter,
  GraphSnapshotFilter,
  GraphSnapshot,
  GraphNode,
  GraphEdge,
} from "../relations.js";
import { assembleGraphSnapshot } from "../graph-assembly.js";
import type { AuditLogEntry } from "../audit.js";
import type { OutboxEntry } from "../outbox.js";
import type { PaginatedResult, WorthDelta, HealthStatus, Sensitivity } from "../common.js";
import { createInMemoryStorageState, resetInMemoryStorageState } from "./in-memory/state.js";
import type { InMemoryStorageState } from "./in-memory/state.js";
import * as sessions from "./in-memory/sessions.js";
import * as facts from "./in-memory/facts.js";
import * as consolidation from "./in-memory/consolidation.js";
import * as workspace from "./in-memory/workspace.js";
import * as decisions from "./in-memory/decisions.js";
import * as episodes from "./in-memory/episodes.js";
import * as entities from "./in-memory/entities.js";
import * as strategies from "./in-memory/strategies.js";
import * as workflows from "./in-memory/workflows.js";
import * as skills from "./in-memory/skills.js";
import * as tasks from "./in-memory/tasks.js";
import * as events from "./in-memory/events.js";
import * as reasoning from "./in-memory/reasoning.js";
import * as agent from "./in-memory/agent.js";
import * as hyperedges from "./in-memory/hyperedges.js";
import * as composition from "./in-memory/composition.js";
import * as relations from "./in-memory/relations.js";
import * as graph from "./in-memory/graph.js";
import * as recall from "./in-memory/recall.js";
import * as factIndex from "./in-memory/fact-index.js";
import * as metacognition from "./in-memory/metacognition.js";
import * as anticipation from "./in-memory/anticipation.js";
import * as neuroDynamics from "./in-memory/neuro-dynamics.js";
import * as activeLearning from "./in-memory/active-learning.js";
import * as audit from "./in-memory/audit.js";
import * as outbox from "./in-memory/outbox.js";
import * as webhooks from "./in-memory/webhooks.js";
import * as reminders from "./in-memory/reminders.js";
import * as queryCache from "./in-memory/query-cache.js";
import * as metrics from "./in-memory/metrics.js";
import * as embeddingMaintenance from "./in-memory/embedding-maintenance.js";
import * as lifecycle from "./in-memory/lifecycle.js";
import * as harness from "./in-memory/harness.js";
import { atomicManaged, commitManagedCollapse } from "./in-memory/managed-collapse.js";

// ─── InMemoryStorageAdapter ───────────────────────────────────────────────────

export class InMemoryStorageAdapter
  implements StorageAdapter, HarnessIngestionPort, ManagedSessionLifecyclePort
{
  readonly capabilities: StorageCapabilities = {
    vectorSearch: false,
    ftsSearch: false,
    bitemporal: false,
    graphExpansion: false,
    transactions: true,
    rls: false,
  };

  private state = createInMemoryStorageState();

  ingestHarnessEvent(input: {
    workspaceId: string;
    provenance: ManagedSessionProvenance;
    event: HarnessEvent;
    receivedAt: Date;
  }): Promise<HarnessEventAck> {
    return harness.ingestHarnessEvent(this.state, input);
  }

  commitManagedCollapse(
    input: Parameters<import("../ports.js").ManagedCollapsePort["commitManagedCollapse"]>[0]
  ) {
    return atomicManaged(this.state, async (snapshot) => {
      const isolated = new InMemoryStorageAdapter();
      isolated.state = snapshot;
      return commitManagedCollapse(snapshot, isolated, input);
    });
  }

  inspectHarnessState(workspaceId: string) {
    return Promise.resolve(harness.inspectHarnessState(this.state, workspaceId));
  }

  setHarnessSessionLifecycle(
    workspaceId: string,
    input: {
      generation: number;
      status: "active" | "collapse_pending" | "collapsed" | "archived";
      leased?: boolean;
      closeKind?: "authoritative" | "provisional" | null;
      closeGraceDeadline?: Date | null;
      terminalMaxEnqueueSequence?: number | null;
      terminalMessageSetDigest?: string | null;
    }
  ): Promise<void> {
    harness.setHarnessSessionLifecycle(this.state, workspaceId, input);
    return Promise.resolve();
  }

  seedHarnessManagedTurn(
    workspaceId: string,
    input: {
      generation: number;
      sourceMessageId: string;
      role: "user" | "assistant";
      content: string;
      contentHash: string;
    }
  ): Promise<void> {
    harness.seedHarnessManagedTurn(this.state, workspaceId, input);
    return Promise.resolve();
  }

  // decompose-inmemory-storage-adapter D5 — pre-existing public inspection
  // surface, now read-through onto `state`. These 6 accessors are the only
  // survivors of B0's 35 temporary pass-through accessors (design.md
  // Interfaces/Contracts).
  get outbox(): OutboxEntry[] {
    return this.state.outbox;
  }
  get auditLog(): AuditLogEntry[] {
    return this.state.auditLog;
  }
  get recallLog(): RecallLogEntry[] {
    return this.state.recallLog;
  }
  /** P111 — mnemo_review_item rows; see the state field's note. */
  get reviewItems(): InMemoryStorageState["reviewItems"] {
    return this.state.reviewItems;
  }
  get consolidationReviews() {
    return this.state.consolidationReviews;
  }
  // flatten-legacy-dual-core Slice 3c pt.1 (PR10) — active-learning review queue.
  get activeLearningReviewQueue(): ActiveLearningReviewRow[] {
    return this.state.activeLearningReviewQueue;
  }

  /** @internal — legacy reach-in seam; sole consumer consolidation-merge.test.ts:429/449/467. */
  private get facts(): Map<string, MnemoFact> {
    return this.state.facts;
  }

  /** @internal — legacy reach-in seam; sole consumer entities-link-user.test.ts:65 (found during B14, not by design.md's original D5 inventory). */
  private get entities(): Map<string, MnemoEntity> {
    return this.state.entities;
  }

  // ── Session ──────────────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput): Promise<MnemoSession> {
    return sessions.createSession(this.state, input);
  }

  appendTurn(sessionId: string, turn: Omit<SessionTurn, "id" | "createdAt">): Promise<number> {
    return sessions.appendTurn(this.state, sessionId, turn);
  }

  listTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> {
    return sessions.listTurns(this.state, sessionId, workspaceId);
  }

  listManagedCollapseTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> {
    return sessions.listManagedCollapseTurns(this.state, sessionId, workspaceId);
  }

  claimManagedSessions(input: {
    workspaceId: string;
    leaseOwner: string;
    limit: number;
    inactivityMs: number;
    provisionalGraceMs: number;
    leaseMs: number;
  }): Promise<ManagedSessionClaim[]> {
    return sessions.claimManagedSessions(this.state, input);
  }

  markManagedCollapseRetry(input: {
    workspaceId: string;
    sessionId: string;
    leaseOwner: string;
    error: string;
    baseRetryMs: number;
    maxRetryMs: number;
  }): Promise<ManagedCollapseRetry | null> {
    return sessions.markManagedCollapseRetry(this.state, input);
  }

  finalizeManagedArchive(input: {
    workspaceId: string;
    sessionId: string;
    leaseOwner: string;
    operationId: string;
    reason: ManagedArchiveReason;
  }): Promise<boolean> {
    return sessions.finalizeManagedArchive(this.state, input);
  }

  releaseExpiredManagedLeases(input: { workspaceId: string }): Promise<number> {
    return sessions.releaseExpiredManagedLeases(this.state, input);
  }

  retryLegacyManagedArchive(input: { workspaceId: string; sessionId: string }): Promise<boolean> {
    return sessions.retryLegacyManagedArchive(this.state, input);
  }

  quiesceManagedLifecycle(input: { workspaceId: string }): Promise<ManagedLifecycleQuiesceResult> {
    return sessions.quiesceManagedLifecycle(this.state, input);
  }

  purgeManagedTurns(input: {
    workspaceId: string;
    terminalBefore: Date;
    limit: number;
  }): Promise<number> {
    return sessions.purgeManagedTurns(this.state, input);
  }

  closeSession(id: string, workspaceId: string): Promise<void> {
    return sessions.closeSession(this.state, id, workspaceId);
  }

  /**
   * LIFECYCLE-7/8 parity with the Postgres adapter: `apply` writes into a
   * snapshot that replaces the live state only when it returns, so a throw
   * leaves nothing behind; commits are serialised like the row lock.
   */
  commitSessionCollapse<T>(
    input: {
      workspaceId: string;
      sessionId: string;
      expectedTurnCount?: number;
      terminalStatus?: "collapsed" | "archived";
      archiveReason?: string;
      topicLocks?: { facts: string[]; decisions: string[] };
    },
    apply: (storage: StorageAdapter) => Promise<T>
  ): Promise<{ committed: true; value: T } | { committed: false; status: string | null }> {
    return atomicManaged(this.state, async (snapshot) => {
      const session = snapshot.sessions.get(input.sessionId);
      const managed = [...snapshot.harnessSessions.values()].some(
        (candidate) =>
          candidate.id === input.sessionId && candidate.workspaceId === input.workspaceId
      );
      if (
        !session ||
        session.workspaceId !== input.workspaceId ||
        managed ||
        session.status === "collapsed"
      ) {
        return {
          committed: false as const,
          status: session && session.workspaceId === input.workspaceId ? session.status : null,
        };
      }
      if (input.expectedTurnCount !== undefined && session.turnCount !== input.expectedTurnCount) {
        throw Object.assign(
          new Error("Session changed during collapse; retry the current snapshot"),
          { code: "SESSION_SNAPSHOT_CHANGED" }
        );
      }
      const isolated = new InMemoryStorageAdapter();
      isolated.state = snapshot;
      const value = await apply(isolated);
      (session as MnemoSession & { status: string }).status = input.terminalStatus ?? "collapsed";
      if (input.terminalStatus === "archived" && input.archiveReason) {
        session.metadata = { ...(session.metadata ?? {}), archiveReason: input.archiveReason };
      }
      return { committed: true as const, value };
    });
  }

  archiveSession(id: string, workspaceId: string, reason?: string): Promise<void> {
    return sessions.archiveSession(this.state, id, workspaceId, reason);
  }

  getSession(id: string, workspaceId: string): Promise<MnemoSession | null> {
    return sessions.getSession(this.state, id, workspaceId);
  }

  listSessions(workspaceId: string): Promise<MnemoSession[]> {
    return sessions.listSessions(this.state, workspaceId);
  }

  recordSessionOutcome(
    sessionId: string,
    workspaceId: string,
    rating: "success" | "failure" | "neutral"
  ): Promise<boolean> {
    return sessions.recordSessionOutcome(this.state, sessionId, workspaceId, rating);
  }

  recordSessionRecall(sessionId: string, workspaceId: string): Promise<void> {
    return sessions.recordSessionRecall(this.state, sessionId, workspaceId);
  }

  pinSessionTurn(input: {
    sessionId: string;
    workspaceId: string;
    turnId?: string;
    turnIndex?: number;
    pinned: boolean;
  }): Promise<boolean> {
    return sessions.pinSessionTurn(this.state, input);
  }

  replaceSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
    scratch: Record<string, unknown>;
  }): Promise<boolean> {
    return sessions.replaceSessionScratch(this.state, input);
  }

  getSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<Record<string, unknown> | null> {
    return sessions.getSessionScratch(this.state, input);
  }

  // ── Facts ────────────────────────────────────────────────────────────────────

  createFact(input: CreateFactInput): Promise<MnemoFact> {
    return facts.createFact(this.state, input);
  }

  findFactByImportedId(workspaceId: string, importedId: string): Promise<MnemoFact | null> {
    return facts.findFactByImportedId(this.state, workspaceId, importedId);
  }

  getFact(id: string, workspaceId: string): Promise<MnemoFact | null> {
    return facts.getFact(this.state, id, workspaceId);
  }

  updateFact(id: string, workspaceId: string, input: UpdateFactInput): Promise<MnemoFact | null> {
    return facts.updateFact(this.state, id, workspaceId, input);
  }

  mergeFactByTopicKey(input: MergeFactByTopicKeyInput): Promise<MnemoFact | null> {
    return facts.mergeFactByTopicKey(this.state, input);
  }

  replaceFact(input: ReplaceFactInput): Promise<ReplaceFactResult | null> {
    return facts.replaceFact(this.state, input);
  }

  archiveFact(id: string, workspaceId: string): Promise<boolean> {
    return facts.archiveFact(this.state, id, workspaceId);
  }
  findLiveFactByStatement(input: FindLiveFactByStatementInput): Promise<MnemoFact | null> {
    return facts.findLiveFactByStatement(this.state, input);
  }

  linkSessionFactsToEpisode(
    workspaceId: string,
    sessionId: string,
    episodeId: string
  ): Promise<number> {
    return facts.linkSessionFactsToEpisode(this.state, workspaceId, sessionId, episodeId);
  }

  queryFacts(filter: FactFilter): Promise<PaginatedResult<MnemoFact>> {
    return facts.queryFacts(this.state, filter);
  }

  // ─── flatten-legacy-dual-core PR9b (D6.3) — keyset fact list + hard purge ──

  queryFactsPage(filter: FactPageFilter): Promise<FactPage> {
    return facts.queryFactsPage(this.state, filter);
  }

  purgeForgottenFacts(workspaceId: string, actorId?: string): Promise<number> {
    return facts.purgeForgottenFacts(this.state, workspaceId, actorId);
  }

  getWorkspaceVitals(workspaceId: string): Promise<WorkspaceVitals> {
    return workspace.getWorkspaceVitals(this.state, workspaceId);
  }

  // In-memory has no separate `mnemo_fact_archive` concept (archiveFact just
  // flips status in place — see above), so the audit feed here is built
  // entirely from forgotten facts, all reported as actorKind "user" /
  // revertible true. Real archive-sourced entries only exist against Postgres
  // (StorageAdapterContract/Tier B cover that shape).
  getAuditFeed(filter: AuditFeedFilter): Promise<AuditFeedEntry[]> {
    return workspace.getAuditFeed(this.state, filter);
  }

  getHealthSnapshot(input: GetHealthSnapshotInput): Promise<HealthSnapshot | null> {
    return workspace.getHealthSnapshot(this.state, input);
  }

  getHealthSnapshots(input: { workspaceId: string; days: number }): Promise<HealthSnapshotDay[]> {
    return workspace.getHealthSnapshots(this.state, input);
  }

  getAuditFeedStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<AuditFeedStats> {
    return workspace.getAuditFeedStats(this.state, input);
  }

  applyConsolidationMerge(
    input: ApplyConsolidationMergeInput
  ): Promise<ConsolidationMergeSnapshot | null> {
    return consolidation.applyConsolidationMerge(this.state, input);
  }

  rollbackConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    review: ReplayFailureReview;
  }): Promise<"rolled_back" | "conflict"> {
    return consolidation.rollbackConsolidationMerge(this.state, input);
  }

  finalizeConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    applyReplayBoost: boolean;
  }): Promise<"finalized" | "conflict"> {
    return consolidation.finalizeConsolidationMerge(this.state, input);
  }

  refreshConsolidationMergeLease(input: {
    snapshot: ConsolidationMergeSnapshot;
    leaseExpiresAt: Date;
  }): Promise<"refreshed" | "conflict"> {
    return consolidation.refreshConsolidationMergeLease(this.state, input);
  }

  inspectConsolidationMergeState(
    snapshot: ConsolidationMergeSnapshot
  ): Promise<"pending" | "restored" | "retained" | "divergent"> {
    return consolidation.inspectConsolidationMergeState(this.state, snapshot);
  }

  recoverExpiredConsolidationMerges(input: {
    workspaceId: string;
    expiredBefore: Date;
  }): Promise<number> {
    return consolidation.recoverExpiredConsolidationMerges(this.state, input);
  }

  findContradictingFacts(
    workspaceId: string,
    input: FindContradictingFactsInput
  ): Promise<ContradictingFact[]> {
    return facts.findContradictingFacts(this.state, workspaceId, input);
  }

  // ── SOC2 CF3 — Retention purge ────────────────────────────────────────────────

  purgeFacts(filter: PurgeFactsFilter): Promise<PurgeFactsResult> {
    return facts.purgeFacts(this.state, filter);
  }

  // ── Decisions ────────────────────────────────────────────────────────────────

  createDecisionUnlessDuplicate(
    input: CreateDecisionInput
  ): Promise<{ decision: MnemoDecision; reused: boolean }> {
    return decisions.createDecisionUnlessDuplicate(this.state, input);
  }

  createDecision(input: CreateDecisionInput): Promise<MnemoDecision> {
    return decisions.createDecision(this.state, input);
  }

  mergeDecisionByTopicKey(input: MergeDecisionByTopicKeyInput): Promise<MnemoDecision | null> {
    return decisions.mergeDecisionByTopicKey(this.state, input);
  }

  getDecision(id: string, workspaceId: string): Promise<MnemoDecision | null> {
    return decisions.getDecision(this.state, id, workspaceId);
  }

  updateDecision(id: string, input: UpdateDecisionInput): Promise<MnemoDecision> {
    return decisions.updateDecision(this.state, id, input);
  }

  archiveDecision(id: string, workspaceId: string): Promise<void> {
    return decisions.archiveDecision(this.state, id, workspaceId);
  }

  supersedeDecision(input: SupersedeDecisionInput): Promise<MnemoDecision> {
    return decisions.supersedeDecision(this.state, input);
  }

  queryDecisions(filter: DecisionFilter): Promise<PaginatedResult<MnemoDecision>> {
    return decisions.queryDecisions(this.state, filter);
  }

  // ── Episodes ─────────────────────────────────────────────────────────────────

  createEpisode(input: CreateEpisodeInput): Promise<MnemoEpisode> {
    return episodes.createEpisode(this.state, input);
  }

  getEpisode(id: string, workspaceId: string): Promise<MnemoEpisode | null> {
    return episodes.getEpisode(this.state, id, workspaceId);
  }

  updateEpisode(id: string, input: UpdateEpisodeInput): Promise<MnemoEpisode> {
    return episodes.updateEpisode(this.state, id, input);
  }

  archiveEpisode(id: string, workspaceId: string): Promise<void> {
    return episodes.archiveEpisode(this.state, id, workspaceId);
  }

  queryEpisodes(filter: EpisodeFilter): Promise<PaginatedResult<MnemoEpisode>> {
    return episodes.queryEpisodes(this.state, filter);
  }

  getEpisodeTreeNeighbors(
    episodeId: string,
    workspaceId: string,
    limit = 10
  ): Promise<MnemoEpisode[]> {
    return episodes.getEpisodeTreeNeighbors(this.state, episodeId, workspaceId, limit);
  }

  persistCompression(input: {
    workspaceId: string;
    rootEpisodeId: string;
    compressedNarrative: string;
    retainedDeltas: Array<{ episodeId: string; deltaContent: string }>;
  }): Promise<void> {
    return episodes.persistCompression(this.state, input);
  }

  getKnowledgeDistribution(
    workspaceId: string
  ): Promise<Partial<Record<import("../recall.js").RememberKind, number>>> {
    return workspace.getKnowledgeDistribution(this.state, workspaceId);
  }

  reconstructEpisode(id: string, workspaceId: string): Promise<MnemoEpisode> {
    return episodes.reconstructEpisode(this.state, id, workspaceId);
  }

  // DELTAMEM §16 — cosine search over stored episode embeddings (set via
  // setEmbedding(episodeId, vec)). Returns workspace-scoped episodes with
  // cosine ≥ minSim, most-similar first. Episodes without a stored embedding
  // are excluded (mirrors the SQL `embedding IS NOT NULL` predicate).
  findSimilarEpisodes(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEpisode[]> {
    return episodes.findSimilarEpisodes(this.state, workspaceId, embedding, limit, minSim);
  }

  // ── Entities ─────────────────────────────────────────────────────────────────

  createEntity(input: CreateEntityInput): Promise<MnemoEntity> {
    return entities.createEntity(this.state, input);
  }

  getEntity(id: string, workspaceId: string): Promise<MnemoEntity | null> {
    return entities.getEntity(this.state, id, workspaceId);
  }

  updateEntity(id: string, input: UpdateEntityInput): Promise<MnemoEntity> {
    return entities.updateEntity(this.state, id, input);
  }

  archiveEntity(id: string, workspaceId: string): Promise<void> {
    return entities.archiveEntity(this.state, id, workspaceId);
  }

  supersedeEntity(input: SupersedeEntityInput): Promise<MnemoEntity> {
    return entities.supersedeEntity(this.state, input);
  }

  queryEntities(filter: EntityFilter): Promise<PaginatedResult<MnemoEntity>> {
    return entities.queryEntities(this.state, filter);
  }

  // P16 — stub: InMemoryStorageAdapter has no vector index for entities.
  findSimilarEntities(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEntity[]> {
    return entities.findSimilarEntities(this.state, workspaceId, embedding, limit, minSim);
  }

  // ── Strategies ────────────────────────────────────────────────────────────────

  createStrategyUnlessDuplicate(
    input: CreateStrategyInput
  ): Promise<{ strategy: MnemoStrategy; reused: boolean }> {
    return strategies.createStrategyUnlessDuplicate(this.state, input);
  }

  createStrategy(input: CreateStrategyInput): Promise<MnemoStrategy> {
    return strategies.createStrategy(this.state, input);
  }

  getStrategy(id: string, workspaceId: string): Promise<MnemoStrategy | null> {
    return strategies.getStrategy(this.state, id, workspaceId);
  }

  updateStrategy(id: string, input: UpdateStrategyInput): Promise<MnemoStrategy> {
    return strategies.updateStrategy(this.state, id, input);
  }

  archiveStrategy(id: string, workspaceId: string): Promise<void> {
    return strategies.archiveStrategy(this.state, id, workspaceId);
  }

  queryStrategies(filter: StrategyFilter): Promise<PaginatedResult<MnemoStrategy>> {
    return strategies.queryStrategies(this.state, filter);
  }

  // ── Workflows ─────────────────────────────────────────────────────────────────

  createWorkflow(input: CreateWorkflowInput): Promise<MnemoWorkflow> {
    return workflows.createWorkflow(this.state, input);
  }

  getWorkflow(id: string, workspaceId: string): Promise<MnemoWorkflow | null> {
    return workflows.getWorkflow(this.state, id, workspaceId);
  }

  updateWorkflow(id: string, input: UpdateWorkflowInput): Promise<MnemoWorkflow> {
    return workflows.updateWorkflow(this.state, id, input);
  }

  archiveWorkflow(id: string, workspaceId: string): Promise<void> {
    return workflows.archiveWorkflow(this.state, id, workspaceId);
  }

  queryWorkflows(filter: WorkflowFilter): Promise<PaginatedResult<MnemoWorkflow>> {
    return workflows.queryWorkflows(this.state, filter);
  }

  // ── Skills ────────────────────────────────────────────────────────────────────

  createSkill(input: CreateSkillInput): Promise<MnemoSkill> {
    return skills.createSkill(this.state, input);
  }

  getSkill(id: string, workspaceId: string): Promise<MnemoSkill | null> {
    return skills.getSkill(this.state, id, workspaceId);
  }

  updateSkill(id: string, input: UpdateSkillInput): Promise<MnemoSkill> {
    return skills.updateSkill(this.state, id, input);
  }

  archiveSkill(id: string, workspaceId: string): Promise<void> {
    return skills.archiveSkill(this.state, id, workspaceId);
  }

  querySkills(filter: SkillFilter): Promise<PaginatedResult<MnemoSkill>> {
    return skills.querySkills(this.state, filter);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Promise<MnemoTask> {
    return tasks.createTask(this.state, input);
  }

  getTask(id: string, workspaceId: string): Promise<MnemoTask | null> {
    return tasks.getTask(this.state, id, workspaceId);
  }

  updateTask(id: string, input: UpdateTaskInput): Promise<MnemoTask> {
    return tasks.updateTask(this.state, id, input);
  }

  archiveTask(id: string, workspaceId: string): Promise<void> {
    return tasks.archiveTask(this.state, id, workspaceId);
  }

  listTasksForSession(
    workspaceId: string,
    sessionId: string
  ): Promise<Array<{ id: string; status: string }>> {
    return tasks.listTasksForSession(this.state, workspaceId, sessionId);
  }

  listStaleTasks(
    workspaceId: string,
    staleSinceMs: number,
    limit: number
  ): Promise<Array<{ id: string; title: string; status: string; updatedAt: Date }>> {
    return metrics.listStaleTasks(this.state, workspaceId, staleSinceMs, limit);
  }

  // ── §3.5 snapshot count methods ───────────────────────────────────────────────

  countFactsByTypeStatus(): Promise<Array<{ type: string; status: string; count: number }>> {
    return metrics.countFactsByTypeStatus(this.state);
  }

  worthHistogram(): Promise<Array<{ bucket: string; count: number }>> {
    return metrics.worthHistogram(this.state);
  }

  countActiveSessions(): Promise<number> {
    return metrics.countActiveSessions(this.state);
  }

  countTasksByStatus(): Promise<Array<{ status: string; count: number }>> {
    return metrics.countTasksByStatus(this.state);
  }

  countStaleTasks(): Promise<number> {
    return metrics.countStaleTasks(this.state);
  }

  listScoredTrajectories(
    workspaceId: string,
    agentId: string,
    limit: number
  ): Promise<
    Array<{ sessionId: string; score: number; promptVersionId: string | null; createdAt: Date }>
  > {
    return agent.listScoredTrajectories(this.state, workspaceId, agentId, limit);
  }

  computeCandidateAbScore(
    workspaceId: string,
    agentId: string,
    promptVersionId: string
  ): Promise<number | null> {
    return agent.computeCandidateAbScore(this.state, workspaceId, agentId, promptVersionId);
  }

  delegateTask(
    id: string,
    workspaceId: string,
    input: { assignedTo: string; delegatedBy: string }
  ): Promise<MnemoTask> {
    return tasks.delegateTask(this.state, id, workspaceId, input);
  }

  queryTasks(filter: TaskFilter): Promise<PaginatedResult<MnemoTask>> {
    return tasks.queryTasks(this.state, filter);
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  createEvent(input: CreateEventInput): Promise<MnemoEvent> {
    return events.createEvent(this.state, input);
  }

  getEvent(id: string, workspaceId: string): Promise<MnemoEvent | null> {
    return events.getEvent(this.state, id, workspaceId);
  }

  archiveEvent(id: string, workspaceId: string): Promise<void> {
    return events.archiveEvent(this.state, id, workspaceId);
  }

  appendEventAnnotation(
    id: string,
    workspaceId: string,
    annotation: { author: string; content: string; at: Date }
  ): Promise<MnemoEvent> {
    return events.appendEventAnnotation(this.state, id, workspaceId, annotation);
  }

  queryEvents(filter: EventFilter): Promise<PaginatedResult<MnemoEvent>> {
    return events.queryEvents(this.state, filter);
  }

  updateEventSensitivity(
    id: string,
    workspaceId: string,
    sensitivity: MnemoEvent["sensitivity"]
  ): Promise<void> {
    return events.updateEventSensitivity(this.state, id, workspaceId, sensitivity);
  }

  // ── Reasoning ─────────────────────────────────────────────────────────────────

  createReasoning(input: CreateReasoningInput): Promise<MnemoReasoning> {
    return reasoning.createReasoning(this.state, input);
  }

  getReasoning(id: string, workspaceId: string): Promise<MnemoReasoning | null> {
    return reasoning.getReasoning(this.state, id, workspaceId);
  }

  updateReasoning(id: string, input: UpdateReasoningInput): Promise<MnemoReasoning> {
    return reasoning.updateReasoning(this.state, id, input);
  }

  archiveReasoning(id: string, workspaceId: string): Promise<void> {
    return reasoning.archiveReasoning(this.state, id, workspaceId);
  }

  queryReasoning(filter: ReasoningFilter): Promise<PaginatedResult<MnemoReasoning>> {
    return reasoning.queryReasoning(this.state, filter);
  }

  // Wave M1 — CoT cache adapter methods (spec §8)

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
  > {
    return reasoning.searchReasoning(this.state, input);
  }

  recordReasoningUse(id: string, workspaceId: string): Promise<void> {
    return reasoning.recordReasoningUse(this.state, id, workspaceId);
  }

  setReasoningStatus(
    id: string,
    workspaceId: string,
    status: MnemoReasoning["status"]
  ): Promise<void> {
    return reasoning.setReasoningStatus(this.state, id, workspaceId, status);
  }

  // ── Agent profile (Wave M2 — spec §13 self-editing memory) ───────────────────

  getAgentProfile(workspaceId: string, agentId: string): Promise<MnemoAgentProfile | null> {
    return agent.getAgentProfile(this.state, workspaceId, agentId);
  }

  upsertAgentProfile(input: {
    workspaceId: string;
    agentId: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MnemoAgentProfile> {
    return agent.upsertAgentProfile(this.state, input);
  }

  incrementSessionsSinceReflection(workspaceId: string, agentId: string): Promise<number> {
    return agent.incrementSessionsSinceReflection(this.state, workspaceId, agentId);
  }

  // ── Hyperedges (Wave D) ───────────────────────────────────────────────────────

  createHyperedge(input: CreateHyperedgeInput): Promise<MnemoHyperedge> {
    return hyperedges.createHyperedge(this.state, input);
  }

  getHyperedge(
    id: string,
    workspaceId: string,
    opts?: { includeClosed?: boolean; maxSensitivity?: Sensitivity }
  ): Promise<MnemoHyperedge | null> {
    return hyperedges.getHyperedge(this.state, id, workspaceId, opts);
  }

  updateHyperedge(id: string, input: UpdateHyperedgeInput): Promise<MnemoHyperedge> {
    return hyperedges.updateHyperedge(this.state, id, input);
  }

  archiveHyperedge(id: string, workspaceId: string): Promise<void> {
    return hyperedges.archiveHyperedge(this.state, id, workspaceId);
  }

  queryHyperedges(filter: HyperedgeFilter): Promise<PaginatedResult<MnemoHyperedge>> {
    return hyperedges.queryHyperedges(this.state, filter);
  }

  bumpHyperedgeActivation(id: string, workspaceId: string): Promise<void> {
    return hyperedges.bumpHyperedgeActivation(this.state, id, workspaceId);
  }

  // ── Composition rules (Wave E) ────────────────────────────────────────────────

  createCompositionRule(input: CreateCompositionRuleInput): Promise<MnemoCompositionRule> {
    return composition.createCompositionRule(this.state, input);
  }

  getCompositionRule(id: string, workspaceId: string): Promise<MnemoCompositionRule | null> {
    return composition.getCompositionRule(this.state, id, workspaceId);
  }

  updateCompositionRule(
    id: string,
    workspaceId: string,
    input: UpdateCompositionRuleInput
  ): Promise<MnemoCompositionRule> {
    return composition.updateCompositionRule(this.state, id, workspaceId, input);
  }

  queryCompositionRules(
    filter: CompositionRuleFilter
  ): Promise<PaginatedResult<MnemoCompositionRule>> {
    return composition.queryCompositionRules(this.state, filter);
  }

  bumpCompositionExecution(id: string, workspaceId: string): Promise<void> {
    return composition.bumpCompositionExecution(this.state, id, workspaceId);
  }

  ensureBuiltinCompositionRules(_workspaceId: string): Promise<void> {
    return composition.ensureBuiltinCompositionRules(this.state, _workspaceId);
  }

  appendInference(input: AppendInferenceInput): Promise<MnemoInferenceLogEntry> {
    return composition.appendInference(this.state, input);
  }

  materialiseInference(input: MaterialiseInferenceInput): Promise<{ id: string }> {
    return composition.materialiseInference(this.state, input);
  }

  queryInferences(filter: InferenceLogFilter): Promise<PaginatedResult<MnemoInferenceLogEntry>> {
    return composition.queryInferences(this.state, filter);
  }

  lookupFactHash(workspaceId: string, statementHash: string): Promise<MnemoFactHash | null> {
    return factIndex.lookupFactHash(this.state, workspaceId, statementHash);
  }

  upsertFactHash(input: UpsertFactHashInput): Promise<MnemoFactHash> {
    return factIndex.upsertFactHash(this.state, input);
  }

  /** Test-only helper: store a pre-computed embedding to be returned by pointerCandidates. */
  setEmbedding(id: string, vec: number[]): void {
    factIndex.setEmbedding(this.state, id, vec);
  }

  /**
   * Test-only helper (flatten-legacy-dual-core PR9g): directly set a fact's
   * `embedding` column — `createFact` never writes it synchronously (it
   * enqueues a `vector_upsert` outbox entry instead, mirroring
   * `FactRepository`'s real async-embed contract), so tests exercising
   * `backfillSemanticNeighbors`'s kNN over `MnemoFact.embedding` need a way
   * to seed it deterministically without draining the outbox.
   */
  setFactEmbedding(id: string, vec: ArrayLike<number>): void {
    factIndex.setFactEmbedding(this.state, id, vec);
  }

  upsertFactLsh(input: UpsertFactLshInput): Promise<void> {
    return factIndex.upsertFactLsh(this.state, input);
  }

  getRecallPrimitives(
    workspaceId: string,
    refs: RecallPrimitiveRef[]
  ): Promise<RecallPrimitiveRecord[]> {
    return recall.getRecallPrimitives(this.state, workspaceId, refs);
  }

  getRecallStructures(
    workspaceId: string,
    sourceIds: string[],
    hyperedgeLimitPerMember: number,
    maxSensitivity?: Sensitivity
  ): Promise<RecallStructures> {
    return recall.getRecallStructures(
      this.state,
      workspaceId,
      sourceIds,
      hyperedgeLimitPerMember,
      maxSensitivity
    );
  }

  getUnresolvedConflictIds(
    workspaceId: string,
    ids: string[],
    maxSensitivity?: Sensitivity
  ): Promise<string[]> {
    return recall.getUnresolvedConflictIds(this.state, workspaceId, ids, maxSensitivity);
  }

  pointerCandidates(query: PointerCandidateQuery): Promise<PointerCandidate[]> {
    return factIndex.pointerCandidates(this.state, query);
  }

  /** FTS arm of hybrid Tier-3 recall: lexical substring match over statement. */
  ftsCandidates(query: Omit<PointerCandidateQuery, "bands">): Promise<FtsCandidate[]> {
    return factIndex.ftsCandidates(this.state, query);
  }

  /** make-primitives-recallable (PR3) — non-fact candidates over `mnemo_decision`-equivalent state. */
  recallableCandidates(query: PrimitiveCandidateQuery): Promise<PrimitiveCandidate[]> {
    return recall.recallableCandidates(this.state, query);
  }

  // ── Meta-cognition (Wave F) ───────────────────────────────────────────────────

  getConfidenceMap(workspaceId: string, opts?: { limit?: number }): Promise<ConfidenceMapRow[]> {
    return metacognition.getConfidenceMap(this.state, workspaceId, opts);
  }

  getKnowledgeGaps(
    workspaceId: string,
    opts?: { limit?: number; minScore?: number }
  ): Promise<KnowledgeGapRow[]> {
    return metacognition.getKnowledgeGaps(this.state, workspaceId, opts);
  }

  getMetacognitionTrends(workspaceId: string): Promise<MetacognitionTrends> {
    return metacognition.getMetacognitionTrends(this.state, workspaceId);
  }

  refreshMetacognitionViews(): Promise<void> {
    return metacognition.refreshMetacognitionViews(this.state);
  }

  // ── Anticipation (Wave G) ─────────────────────────────────────────────────────

  getSequentialPatterns(args: {
    workspaceId: string;
    predecessorId?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<SequentialPatternRow[]> {
    return anticipation.getSequentialPatterns(this.state, args);
  }

  getPeriodicPatterns(args: {
    workspaceId: string;
    dayOfWeek?: number;
    hourBucket?: number;
    limit?: number;
  }): Promise<PeriodicPatternRow[]> {
    return anticipation.getPeriodicPatterns(this.state, args);
  }

  refreshAnticipationViews(): Promise<void> {
    return anticipation.refreshAnticipationViews(this.state);
  }

  getConditionalPatterns(): Promise<ConditionalPatternRow[]> {
    return anticipation.getConditionalPatterns(this.state);
  }
  getCoOccurrencePatterns(): Promise<CoOccurrencePatternRow[]> {
    return anticipation.getCoOccurrencePatterns(this.state);
  }

  // ── Relations ─────────────────────────────────────────────────────────────────

  createRelation(input: CreateRelationInput): Promise<MnemoRelation> {
    return relations.createRelation(this.state, input);
  }

  getRelations(filter: RelationFilter): Promise<MnemoRelation[]> {
    return relations.getRelations(this.state, filter);
  }

  listCitations(filter: CitationFilter): Promise<MnemoCitation[]> {
    return graph.listCitations(this.state, filter);
  }

  /**
   * flatten-legacy-dual-core PR9f (design.md D6.5) — mirrors legacy
   * `buildGraphQuery`'s filters exactly (canonical entities only, non-
   * synthetic episodes, active decisions, non-dismissed relations valid at
   * `asOf`/now), then shares `assembleGraphSnapshot` with `GraphRepository`
   * (adapter-postgres) for the focus/meta tail so both never drift.
   */
  getGraphSnapshot(filter: GraphSnapshotFilter): Promise<GraphSnapshot> {
    return graph.getGraphSnapshot(this.state, filter);
  }

  countEntityMentions(input: {
    workspaceId: string;
    entityIds: string[];
    maxSensitivity?: Sensitivity;
  }): Promise<Record<string, number>> {
    return graph.countEntityMentions(this.state, input);
  }

  findHiddenIds(input: {
    workspaceId: string;
    ids: string[];
    maxSensitivity: Sensitivity;
  }): Promise<string[]> {
    return relations.findHiddenIds(this.state, input);
  }

  countOpenConflicts(input: {
    workspaceId: string;
    maxSensitivity?: Sensitivity;
  }): Promise<number> {
    return relations.countOpenConflicts(this.state, input);
  }

  /**
   * flatten-legacy-dual-core PR9g (design.md D6.5) — mirrors legacy
   * `backfillSemanticNeighbors` (`core/src/graph/semantic-neighbors.ts`):
   * delete-then-insert per workspace, brute-force top-k cosine over active
   * embedded facts (no real HNSW index to fake in-memory — this fake has no
   * pgvector, so it's a full scan instead of the adapter-postgres/legacy
   * `INSERT ... JOIN LATERAL`), same per-fact top-k/threshold semantics.
   * Idempotent: delete-first means a repeat call with unchanged embeddings
   * reproduces the identical edge set.
   */
  backfillSemanticNeighbors(input: {
    workspaceId: string;
    k?: number;
    threshold?: number;
    modelVersion?: string;
  }): Promise<number> {
    return graph.backfillSemanticNeighbors(this.state, input);
  }

  updateRelationStrength(id: string, delta: number): Promise<void> {
    return relations.updateRelationStrength(this.state, id, delta);
  }

  deleteRelation(id: string, workspaceId: string): Promise<void> {
    return relations.deleteRelation(this.state, id, workspaceId);
  }

  closeRelation(
    id: string,
    workspaceId: string,
    opts?: { maxSensitivity?: Sensitivity }
  ): Promise<boolean> {
    return relations.closeRelation(this.state, id, workspaceId, opts);
  }

  /** flatten-legacy-dual-core D6.4 — see `ApplyRelationJudgmentInput`'s doc comment (ports.ts). */
  applyRelationJudgment(input: ApplyRelationJudgmentInput): Promise<MnemoRelation | null> {
    return relations.applyRelationJudgment(this.state, input);
  }

  // B5 — see `ResolveConflictInput`'s doc comment (ports.ts) for why this is
  // one composite method rather than 4-6 chained calls. In-memory fake has no
  // real transaction boundary to test (that's `FactRepository`'s job via a
  // real Postgres integration test) — this exists purely so callers relying
  // on `InMemoryStorageAdapter` (e.g. unit tests unrelated to B5 itself) see
  // correct end-state behavior.
  resolveConflict(input: ResolveConflictInput): Promise<ResolveConflictResult> {
    return relations.resolveConflict(this.state, input);
  }

  // ── Worth governance ──────────────────────────────────────────────────────────

  updateWorth(
    id: string,
    workspaceId: string,
    primitiveKind: PrimitiveKind,
    delta: WorthDelta
  ): Promise<void> {
    return recall.updateWorth(this.state, id, workspaceId, primitiveKind, delta);
  }

  recordRecall(entry: RecallLogEntry): Promise<void> {
    return recall.recordRecall(this.state, entry);
  }

  /** Test inspection of observations recorded by this instance only. */
  readonly recallObservations = recall.createRecallObservationStore();

  recordRecallObservation(
    request: RecallRequestObservation,
    hits: RecallHitObservation[]
  ): Promise<void> {
    return recall.recordRecallObservation(this.state, this.recallObservations, request, hits);
  }

  getTdPredecessors(
    _workspaceId: string,
    _sessionId: string,
    _excludeFactId: string
  ): Promise<Array<{ factId: string; tdCredit: number; recalledAt: Date }>> {
    return recall.getTdPredecessors(this.state, _workspaceId, _sessionId, _excludeFactId);
  }

  getRecallPrecision(workspaceId: string): Promise<RecallPrecisionReport> {
    return recall.getRecallPrecision(this.state, workspaceId);
  }

  getContextEconomy(workspaceId: string, days: number, maxSensitivity: Sensitivity) {
    return recall.getContextEconomy(
      this.state,
      this.recallObservations,
      workspaceId,
      days,
      maxSensitivity
    );
  }

  getRecallLatency(
    workspaceId: string,
    days: number
  ): Promise<{ p50Ms: number | null; p95Ms: number | null; samples: number }> {
    return recall.getRecallLatency(this.state, workspaceId, days);
  }

  getWritesPerDay(
    workspaceId: string,
    days: number
  ): Promise<Array<{ day: string; count: number }>> {
    return workspace.getWritesPerDay(this.state, workspaceId, days);
  }

  getRecallMetrics(workspaceId: string, days: number): Promise<RecallMetrics> {
    return recall.getRecallMetrics(this.state, workspaceId, days);
  }

  getSessionStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<SessionStats> {
    return sessions.getSessionStats(this.state, input);
  }

  getFactStats(input: { workspaceId: string; maxSensitivity?: Sensitivity }): Promise<FactStats> {
    return recall.getFactStats(this.state, input);
  }

  // ─── §11 Governance ─────────────────────────────────────────────────────────

  setCanonical(id: string, workspaceId: string, canonical: boolean): Promise<void> {
    return facts.setCanonical(this.state, id, workspaceId, canonical);
  }

  getRecalledFactIds(workspaceId: string, sessionId: string): Promise<string[]> {
    return recall.getRecalledFactIds(this.state, workspaceId, sessionId);
  }

  getProvenanceCredit(
    workspaceId: string,
    terminalIds: string[],
    lambda: number,
    maxHops: number
  ): Promise<Array<{ factId: string; credit: number }>> {
    return relations.getProvenanceCredit(this.state, workspaceId, terminalIds, lambda, maxHops);
  }

  // ── flatten-legacy-dual-core Slice 3c pt.1 (PR10) — active-learning review queue ──

  listActiveLearningReview(filter: ActiveLearningReviewFilter): Promise<ActiveLearningReviewRow[]> {
    return activeLearning.listActiveLearningReview(this.state, filter);
  }

  countUnresolvedActiveLearningReview(workspaceId: string): Promise<number> {
    return activeLearning.countUnresolvedActiveLearningReview(this.state, workspaceId);
  }

  enqueueActiveLearningReview(
    input: EnqueueActiveLearningReviewInput
  ): Promise<EnqueueActiveLearningReviewResult> {
    return activeLearning.enqueueActiveLearningReview(this.state, input);
  }

  resolveActiveLearningReview(
    input: ResolveActiveLearningReviewInput
  ): Promise<ResolveActiveLearningReviewResult> {
    return activeLearning.resolveActiveLearningReview(this.state, input);
  }

  // ── Audit ─────────────────────────────────────────────────────────────────────

  appendAuditEntry(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<void> {
    return audit.appendAuditEntry(this.state, entry);
  }

  listAuditLog(workspaceId: string, limit: number): Promise<AuditLogEntry[]> {
    return audit.listAuditLog(this.state, workspaceId, limit);
  }

  getAuditActivity(input: {
    workspaceId: string;
    days: number;
    actorIds: string[];
  }): Promise<AuditActivity> {
    return audit.getAuditActivity(this.state, input);
  }

  // ── Outbox ────────────────────────────────────────────────────────────────────

  appendOutbox(entry: Omit<OutboxEntry, "id" | "createdAt" | "attempts">): Promise<void> {
    return outbox.appendOutbox(this.state, entry);
  }

  claimOutbox(limit: number): Promise<OutboxEntry[]> {
    return outbox.claimOutbox(this.state, limit);
  }

  markOutboxProcessed(ids: string[]): Promise<void> {
    return outbox.markOutboxProcessed(this.state, ids);
  }

  markOutboxFailed(id: string, error: string): Promise<void> {
    return outbox.markOutboxFailed(this.state, id, error);
  }

  reapDeadLetters(maxAttempts: number): Promise<number> {
    return outbox.reapDeadLetters(this.state, maxAttempts);
  }

  purgeOutbox(olderThanMs: number): Promise<number> {
    return outbox.purgeOutbox(this.state, olderThanMs);
  }

  countPendingOutbox(): Promise<number> {
    return outbox.countPendingOutbox(this.state);
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────────

  createWebhookEndpoint(
    input: import("../ports.js").CreateWebhookEndpointInput
  ): Promise<import("../ports.js").MnemoWebhookEndpoint> {
    return webhooks.createWebhookEndpoint(this.state, input);
  }

  getWebhookEndpoint(
    id: string,
    workspaceId: string
  ): Promise<import("../ports.js").MnemoWebhookEndpoint | null> {
    return webhooks.getWebhookEndpoint(this.state, id, workspaceId);
  }

  listWebhookEndpoints(workspaceId: string): Promise<import("../ports.js").MnemoWebhookEndpoint[]> {
    return webhooks.listWebhookEndpoints(this.state, workspaceId);
  }

  updateWebhookEndpoint(
    id: string,
    workspaceId: string,
    input: import("../ports.js").UpdateWebhookEndpointInput
  ): Promise<import("../ports.js").MnemoWebhookEndpoint> {
    return webhooks.updateWebhookEndpoint(this.state, id, workspaceId, input);
  }

  deleteWebhookEndpoint(id: string, workspaceId: string): Promise<void> {
    return webhooks.deleteWebhookEndpoint(this.state, id, workspaceId);
  }

  recordWebhookDelivery(entry: import("../ports.js").CreateWebhookDeliveryInput): Promise<void> {
    return webhooks.recordWebhookDelivery(this.state, entry);
  }

  listWebhookDeliveries(
    webhookId: string,
    workspaceId: string,
    limit = 50
  ): Promise<import("../ports.js").MnemoWebhookDelivery[]> {
    return webhooks.listWebhookDeliveries(this.state, webhookId, workspaceId, limit);
  }

  listPendingWebhookDeliveries(
    limit: number
  ): Promise<import("../ports.js").MnemoWebhookDelivery[]> {
    return webhooks.listPendingWebhookDeliveries(this.state, limit);
  }

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
  ): Promise<void> {
    return webhooks.updateWebhookDelivery(this.state, id, workspaceId, update);
  }

  // ── Reminders (prospective memory) ────────────────────────────────────────────

  createReminder(
    input: import("../ports.js").CreateReminderInput
  ): Promise<import("../ports.js").MnemoReminder> {
    return reminders.createReminder(this.state, input);
  }

  listDueReminderWorkspaceIds(): Promise<string[]> {
    return reminders.listDueReminderWorkspaceIds(this.state);
  }

  getReminder(
    id: string,
    workspaceId: string
  ): Promise<import("../ports.js").MnemoReminder | null> {
    return reminders.getReminder(this.state, id, workspaceId);
  }

  listPendingReminders(
    workspaceId: string,
    asOf: Date
  ): Promise<import("../ports.js").MnemoReminder[]> {
    return reminders.listPendingReminders(this.state, workspaceId, asOf);
  }

  dismissReminder(
    id: string,
    workspaceId: string,
    newStatus: "triggered" | "dismissed"
  ): Promise<void> {
    return reminders.dismissReminder(this.state, id, workspaceId, newStatus);
  }

  listReminders(
    workspaceId: string,
    status: "pending" | "triggered" | "dismissed" | "all",
    limit: number
  ): Promise<import("../ports.js").MnemoReminder[]> {
    return reminders.listReminders(this.state, workspaceId, status, limit);
  }

  claimUndeliveredReminders(
    workspaceId: string,
    input: { ids: string[]; limit: number }
  ): Promise<import("../ports.js").MnemoReminder[]> {
    return reminders.claimUndeliveredReminders(this.state, workspaceId, input);
  }

  // ── Recall log (ACT-R activation — TASK-4001) ────────────────────────────────

  getRecallLog(
    workspaceId: string,
    memoryId: string,
    limit: number
  ): Promise<Array<{ id: string; recalledAt: string; recallScore: number }>> {
    return recall.getRecallLog(this.state, workspaceId, memoryId, limit);
  }

  getRecallLogs(
    workspaceId: string,
    memoryIds: string[],
    limitPerMemory: number
  ): Promise<RecallLogRecord[]> {
    return recall.getRecallLogs(this.state, workspaceId, memoryIds, limitPerMemory);
  }

  getRecentQueriesForFacts(
    workspaceId: string,
    factIds: string[],
    limit: number
  ): Promise<string[]> {
    return recall.getRecentQueriesForFacts(this.state, workspaceId, factIds, limit);
  }

  // ── §9 L3 — Query cache (cosine >= threshold) ─────────────────────────────────

  lookupQueryCache(
    input: LookupQueryCacheInput
  ): Promise<{ resultIds: string[]; resultKinds: string[] } | null> {
    return queryCache.lookupQueryCache(this.state, input);
  }

  pruneQueryCache(workspaceId: string, olderThanMs: number): Promise<number> {
    return queryCache.pruneQueryCache(this.state, workspaceId, olderThanMs);
  }

  insertQueryCache(input: InsertQueryCacheInput): Promise<void> {
    return queryCache.insertQueryCache(this.state, input);
  }

  // ── §9 L3 — Embedding LRU (exact text-hash) ───────────────────────────────────

  getCachedEmbedding(
    workspaceId: string,
    textHash: string,
    model?: string
  ): Promise<Float32Array | null> {
    return queryCache.getCachedEmbedding(this.state, workspaceId, textHash, model);
  }

  putCachedEmbedding(input: {
    workspaceId: string;
    textHash: string;
    embedding: Float32Array;
    model: string;
  }): Promise<void> {
    return queryCache.putCachedEmbedding(this.state, input);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  healthCheck(): Promise<HealthStatus> {
    return lifecycle.healthCheck(this.state);
  }

  close(): Promise<void> {
    return lifecycle.close(this.state);
  }

  listWorkspaceIds(): Promise<string[]> {
    return lifecycle.listWorkspaceIds(this.state);
  }

  // ── RDD-5: Workspace operational mode (in-memory test double) ────────────────

  getWorkspaceMode(workspaceId: string) {
    return workspace.getWorkspaceMode(this.state, workspaceId);
  }

  setWorkspaceMode(
    workspaceId: string,
    patch: {
      mode?: "learning" | "production";
      sessionCount?: number;
      promoteAt?: number | null;
      factCount?: number;
      entityCount?: number;
    }
  ) {
    return workspace.setWorkspaceMode(this.state, workspaceId, patch);
  }

  incrementWorkspaceModeCounters(
    workspaceId: string,
    delta: {
      factCount?: number;
      entityCount?: number;
      sessionCount?: number;
    }
  ) {
    return workspace.incrementWorkspaceModeCounters(this.state, workspaceId, delta);
  }

  // ── Neuro-dynamics stubs (Wave Y, §25.2/§25.3) ───────────────────────────────

  decayKind(workspaceId: string, decayClass: string, halfLifeDays: number): Promise<number> {
    return neuroDynamics.decayKind(this.state, workspaceId, decayClass, halfLifeDays);
  }

  recordCoRecallStdp(workspaceId: string, relationId: string, coRecalledAt: Date): Promise<void> {
    return neuroDynamics.recordCoRecallStdp(this.state, workspaceId, relationId, coRecalledAt);
  }

  normalizeHebbianWeights(workspaceId: string): Promise<number> {
    return neuroDynamics.normalizeHebbianWeights(this.state, workspaceId);
  }

  // ── Wave Y §25.1 — review queue + drift detection stubs ──────────────────────

  enqueueReviewItem(input: {
    workspaceId: string;
    primitiveId: string;
    primitiveKind?: string;
    reason: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    return neuroDynamics.enqueueReviewItem(this.state, input);
  }

  queryDriftCandidates(workspaceId: string): Promise<
    Array<{
      id: string;
      statement: string;
      metadata: Record<string, unknown>;
      sensitivity: Sensitivity;
    }>
  > {
    return neuroDynamics.queryDriftCandidates(this.state, workspaceId);
  }

  // §36 Embedding-model migration (fact rows only in this double)
  listStaleEmbeddings(
    table: import("../ports.js").EmbeddableTable,
    workspaceId: string,
    currentModel: string,
    limit: number,
    opts?: { plaintextOnly?: boolean }
  ): Promise<Array<{ id: string; text: string }>> {
    return embeddingMaintenance.listStaleEmbeddings(
      this.state,
      table,
      workspaceId,
      currentModel,
      limit,
      opts
    );
  }

  hasActiveEmbeddingMigration(workspaceId: string, currentModel: string): Promise<boolean> {
    return embeddingMaintenance.hasActiveEmbeddingMigration(this.state, workspaceId, currentModel);
  }

  markEmbeddingsStale(
    table: import("../ports.js").EmbeddableTable,
    workspaceId: string,
    currentModel: string
  ): Promise<number> {
    return embeddingMaintenance.markEmbeddingsStale(this.state, table, workspaceId, currentModel);
  }

  updateEmbeddingVector(
    table: import("../ports.js").EmbeddableTable,
    id: string,
    workspaceId: string,
    vector: number[],
    model: string
  ): Promise<void> {
    return embeddingMaintenance.updateEmbeddingVector(
      this.state,
      table,
      id,
      workspaceId,
      vector,
      model
    );
  }

  // §37 Hot-tier snapshot stubs
  upsertHotTierSnapshot(rows: import("../ports.js").HotTierSnapshotRow[]): Promise<void> {
    return embeddingMaintenance.upsertHotTierSnapshot(this.state, rows);
  }

  loadHotTierSnapshots(workspaceId?: string): Promise<import("../ports.js").HotTierSnapshotRow[]> {
    return embeddingMaintenance.loadHotTierSnapshots(this.state, workspaceId);
  }

  // ── RDD-4: Hybrid dedup gate ──────────────────────────────────────────────────

  /**
   * Return distinct topic_keys for facts in a session that were tagged with the
   * given extraction_source. Used by the hybrid collapse dedup gate.
   */
  listSessionTopicKeysBySource(
    workspaceId: string,
    sessionId: string,
    source: string
  ): Promise<string[]> {
    return facts.listSessionTopicKeysBySource(this.state, workspaceId, sessionId, source);
  }

  // ── Test helpers ──────────────────────────────────────────────────────────────

  /** Clear all data — call between test cases. */
  reset(): void {
    resetInMemoryStorageState(this.state);
  }
}
