/**
 * DrizzleStorageAdapter — implements the full StorageAdapter port (TASK-5001).
 *
 * Key invariants:
 *  1. GUC on every workspace-scoped transaction: SELECT mnemo_set_workspace($id)
 *  2. Outbox appended in the same PG transaction as the primary write (CRIT-05)
 *  3. GENERATED columns (worth) are never written directly
 *  4. NUMERIC columns come back as strings; parse with parseFloat()
 *
 * This file is a thin facade that delegates to repositories/. All method bodies
 * live in the repository classes under repositories/.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import { pgPoolWaitDuration } from "./metrics.js";

import type { DecayClass, Sensitivity } from "@mnemo-ai/types";

import type {
  StorageAdapter,
  StorageCapabilities,
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
  PurgeFactsFilter,
  PurgeFactsResult,
  CreateDecisionInput,
  UpdateDecisionInput,
  DecisionFilter,
  CreateEpisodeInput,
  UpdateEpisodeInput,
  EpisodeFilter,
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
  CitationFilter,
  MnemoCitation,
  GraphSnapshotFilter,
  GraphSnapshot,
  RecallLogEntry,
  RecallRequestObservation,
  RecallHitObservation,
  RecallPrecisionReport,
  RecallMetrics,
  FactStats,
  SessionStats,
  AuditActivity,
  HealthSnapshotDay,
  AuditFeedStats,
  MnemoWebhookEndpoint,
  MnemoWebhookDelivery,
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
  CreateWebhookDeliveryInput,
  MnemoReminder,
  CreateReminderInput,
  CreateCompositionRuleInput,
  UpdateCompositionRuleInput,
  CompositionRuleFilter,
  AppendInferenceInput,
  InferenceLogFilter,
  UpsertFactHashInput,
  ConfidenceMapRow,
  KnowledgeGapRow,
  MetacognitionTrends,
  SequentialPatternRow,
  PeriodicPatternRow,
  ConditionalPatternRow,
  CoOccurrencePatternRow,
  MaterialiseInferenceInput,
  UpsertFactLshInput,
  PointerCandidateQuery,
  PointerCandidate,
  FtsCandidate,
  PrimitiveCandidate,
  PrimitiveCandidateQuery,
  FederatedRecallCandidate,
  FederatedRecallQuery,
  RecallPrimitiveRef,
  RecallPrimitiveRecord,
  RecallLogRecord,
  RecallStructures,
  EmbeddableTable,
  SimilarEpisode,
  SimilarEntity,
  HotTierSnapshotRow,
  ApplyConsolidationMergeInput,
  ConsolidationMergeSnapshot,
  ReplayFailureReview,
  LookupQueryCacheInput,
  InsertQueryCacheInput,
  HarnessIngestionPort,
  HarnessEvent,
  HarnessEventAck,
  ManagedSessionProvenance,
  ManagedSessionLifecyclePort,
  ManagedSessionClaim,
  ManagedCollapseRetry,
  ManagedLifecycleQuiesceResult,
  ManagedArchiveReason,
  ManagedCollapsePort,
  ManagedCollapseCommitResult,
} from "@mnemo-ai/types";

import type {
  MnemoSession,
  SessionTurn,
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
  MnemoRelation,
  MnemoCompositionRule,
  MnemoInferenceLogEntry,
  MnemoFactHash,
  MnemoAgentProfile,
  PrimitiveKind,
  WorthDelta,
  HealthStatus,
  PaginatedResult,
  OutboxEntry,
  AuditLogEntry,
  WorkspaceVitals,
  AuditFeedFilter,
  AuditFeedEntry,
  GetHealthSnapshotInput,
  HealthSnapshot,
  RememberKind,
  ActiveLearningReviewFilter,
  ActiveLearningReviewRow,
  EnqueueActiveLearningReviewInput,
  EnqueueActiveLearningReviewResult,
  ResolveActiveLearningReviewInput,
  ResolveActiveLearningReviewResult,
} from "@mnemo-ai/types";

// Repository imports
import { SessionRepository } from "./repositories/SessionRepository.js";
import { ReviewQueueRepository } from "./repositories/ReviewQueueRepository.js";
import { FactRepository } from "./repositories/FactRepository.js";
import { DecisionRepository } from "./repositories/DecisionRepository.js";
import { DuplicateLookupRepository } from "./repositories/DuplicateLookupRepository.js";
import { EpisodeRepository } from "./repositories/EpisodeRepository.js";
import { EntityRepository } from "./repositories/EntityRepository.js";
import { KnowledgeRepository } from "./repositories/KnowledgeRepository.js";
import { TaskRepository } from "./repositories/TaskRepository.js";
import { EventRepository } from "./repositories/EventRepository.js";
import { ReasoningRepository } from "./repositories/ReasoningRepository.js";
import { GraphRepository } from "./repositories/GraphRepository.js";
import { CitationRepository } from "./repositories/CitationRepository.js";
import { RecallRepository } from "./repositories/RecallRepository.js";
import { AuditRepository } from "./repositories/AuditRepository.js";
import { runtimeConnectionParams } from "./pg-timeouts.js";
import { openFacts } from "./encryption/fact-decryptor.js";
import { WebhookRepository } from "./repositories/WebhookRepository.js";
import { EncryptionRepository } from "./repositories/EncryptionRepository.js";
import { CompositionRepository } from "./repositories/CompositionRepository.js";
import { EmbeddingRepository } from "./repositories/EmbeddingRepository.js";
import { AnalyticsRepository } from "./repositories/AnalyticsRepository.js";
import { PluginRepository } from "./repositories/PluginRepository.js";
import { MeteringRepository } from "./repositories/MeteringRepository.js";
import { WorkspaceRepository } from "./repositories/WorkspaceRepository.js";
import { ConsolidationRepository } from "./repositories/ConsolidationRepository.js";
import { HealthRepository } from "./repositories/HealthRepository.js";
import { HarnessRepository } from "./repositories/HarnessRepository.js";
import { ManagedCollapseRepository } from "./repositories/ManagedCollapseRepository.js";
import { ManagedSessionRepository } from "./repositories/ManagedSessionRepository.js";
import { ManagedWorkerRepository } from "./repositories/ManagedWorkerRepository.js";
import type { ManagedEffectClaim, ManagedSessionWorkerPort } from "@mnemo-ai/types";

// ─── Drizzle client setup ─────────────────────────────────────────────────────

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDrizzleClient(connectionString: string): {
  db: DrizzleClient;
  pgClient: postgres.Sql;
} {
  // Pool sizing is env-driven so operators can tune without code changes.
  // DATABASE_POOL_IDLE_TIMEOUT and DATABASE_CONNECT_TIMEOUT are specified in
  // milliseconds for consistency with other Mnemosyne timeout env vars; they
  // are converted to seconds here because postgres.js expects seconds.
  const poolMax = parseInt(process.env["DATABASE_POOL_MAX"] ?? "10", 10);
  const poolIdleTimeout = parseInt(process.env["DATABASE_POOL_IDLE_TIMEOUT"] ?? "30000", 10); // ms → s below
  const connectTimeout = parseInt(process.env["DATABASE_CONNECT_TIMEOUT"] ?? "5000", 10); // ms → s below

  const pgClient = postgres(connectionString, {
    max: poolMax,
    idle_timeout: Math.floor(poolIdleTimeout / 1000), // postgres.js uses seconds
    connect_timeout: Math.floor(connectTimeout / 1000), // postgres.js uses seconds
    max_lifetime: 1800, // recycle connections every 30min to avoid stale auth
    // Resolve unqualified names (e.g. mnemo_set_workspace()) to mnemosyne.*,
    // plus the PG-TIMEOUTS statement/lock/idle-in-transaction limits.
    connection: runtimeConnectionParams(process.env),
  });
  const db = drizzle(pgClient, { schema });

  // Cold-connect latency as pool-wait proxy: postgres-js auto-pools internally
  // and does not expose per-query pool-wait hooks. We observe the initial
  // connection establishment time as the best available approximation.
  const poolProbeStart = Date.now();
  pgClient`SELECT 1`.then(
    () => {
      pgPoolWaitDuration.observe({}, (Date.now() - poolProbeStart) / 1000);
    },
    () => {
      /* non-fatal — pool-wait metric starts at zero samples */
    }
  );

  return { db, pgClient };
}

/** Callback injected by the server to unwrap a per-actor DEK via the KEK hierarchy. */
export type DekUnwrapper = (workspaceId: string, actorId: string, wrappedDek: string) => Buffer;

/** Callback injected by the server to provision (generate + wrap) a fresh per-actor DEK. */
export type DekProvisioner = (
  workspaceId: string,
  actorId: string
) => { dek: Buffer; wrapped: string };

// ─── DrizzleStorageAdapter ────────────────────────────────────────────────────

export class DrizzleStorageAdapter
  implements StorageAdapter, HarnessIngestionPort, ManagedSessionLifecyclePort, ManagedCollapsePort
{
  readonly capabilities: StorageCapabilities = {
    vectorSearch: false,
    ftsSearch: false,
    bitemporal: true,
    graphExpansion: false,
    transactions: true,
    rls: true,
  };

  private readonly pgClient: postgres.Sql | null = null;

  private readonly sessions: SessionRepository;
  private readonly reviewQueue: ReviewQueueRepository;
  private readonly facts: FactRepository;
  private readonly decisions: DecisionRepository;
  private readonly duplicates: DuplicateLookupRepository;
  private readonly episodes: EpisodeRepository;
  private readonly entities: EntityRepository;
  private readonly knowledge: KnowledgeRepository;
  private readonly tasks: TaskRepository;
  private readonly events: EventRepository;
  private readonly reasonings: ReasoningRepository;
  private readonly graph: GraphRepository;
  private readonly citations: CitationRepository;
  private readonly recall: RecallRepository;
  private readonly audit: AuditRepository;
  private readonly webhooks: WebhookRepository;
  private readonly encryption: EncryptionRepository;
  private readonly compositions: CompositionRepository;
  private readonly embeddings: EmbeddingRepository;
  private readonly analytics: AnalyticsRepository;
  private readonly plugins: PluginRepository;
  private readonly metering: MeteringRepository;
  private readonly workspace: WorkspaceRepository;
  private readonly consolidation: ConsolidationRepository;
  private readonly health: HealthRepository;
  private readonly harness: HarnessRepository;
  private readonly managedSessions: ManagedSessionRepository;

  constructor(
    private readonly db: DrizzleClient,
    pgClientForClose?: postgres.Sql,
    private readonly dekUnwrapper?: DekUnwrapper,
    private readonly dekProvisioner?: DekProvisioner,
    private readonly replicaDb?: DrizzleClient
  ) {
    if (pgClientForClose) {
      this.pgClient = pgClientForClose;
    }
    const readDb = replicaDb ?? db;

    this.encryption = new EncryptionRepository(db, readDb, dekUnwrapper, dekProvisioner);
    this.sessions = new SessionRepository(db, readDb);
    this.reviewQueue = new ReviewQueueRepository(db);
    this.facts = new FactRepository(db, readDb, dekUnwrapper, dekProvisioner);
    this.decisions = new DecisionRepository(db, readDb);
    this.duplicates = new DuplicateLookupRepository(db);
    this.episodes = new EpisodeRepository(db, readDb);
    this.entities = new EntityRepository(db, readDb);
    this.knowledge = new KnowledgeRepository(db, readDb);
    this.tasks = new TaskRepository(db, readDb);
    this.events = new EventRepository(db, readDb);
    this.reasonings = new ReasoningRepository(db, readDb);
    this.graph = new GraphRepository(db, readDb);
    this.citations = new CitationRepository(db, readDb);
    this.recall = new RecallRepository(db, readDb);
    this.audit = new AuditRepository(
      db,
      readDb,
      this.encryption.getActorDekInTx.bind(this.encryption),
      dekUnwrapper
    );
    this.webhooks = new WebhookRepository(db, readDb);
    this.compositions = new CompositionRepository(db, readDb);
    this.embeddings = new EmbeddingRepository(db, readDb);
    this.analytics = new AnalyticsRepository(db, readDb);
    this.plugins = new PluginRepository(db, readDb);
    this.metering = new MeteringRepository(db, readDb);
    this.workspace = new WorkspaceRepository(db, pgClientForClose ?? null);
    this.consolidation = new ConsolidationRepository(db);
    this.health = new HealthRepository(db);
    this.harness = new HarnessRepository(db);
    this.managedSessions = new ManagedSessionRepository(db, this.sessions);
  }

  /** Same tx-scoped adapter factory commitManagedCollapse uses, so an effect's
   * writes go through the ordinary repositories under the caller's transaction. */
  private managedWorker(): ManagedWorkerRepository {
    return new ManagedWorkerRepository(
      this.db,
      (tx) =>
        new DrizzleStorageAdapter(
          tx as unknown as DrizzleClient,
          undefined,
          this.dekUnwrapper,
          this.dekProvisioner
        )
    );
  }

  forgetManagedTranscriptForEpisode(input: {
    workspaceId: string;
    episodeId: string;
    actorId: string;
  }): Promise<{ sessionId: string | null; turnsRemoved: number }> {
    return this.managedSessions.forgetManagedTranscriptForEpisode(input);
  }

  exportManagedSessions(input: {
    workspaceId: string;
    limit: number;
  }): ReturnType<ManagedSessionRepository["exportManagedSessions"]> {
    return this.managedSessions.exportManagedSessions(input);
  }

  exportManagedTranscripts(input: {
    workspaceId: string;
    limit: number;
  }): ReturnType<ManagedSessionRepository["exportManagedTranscripts"]> {
    return this.managedSessions.exportManagedTranscripts(input);
  }

  managedLifecycleStats(): ReturnType<
    NonNullable<import("@mnemo-ai/types").StorageAdapter["managedLifecycleStats"]>
  > {
    return this.managedSessions.managedLifecycleStats();
  }

  isHarnessIngestionEnabled(input: { workspaceId: string }): Promise<boolean> {
    return this.managedWorker().isHarnessIngestionEnabled(input);
  }

  disableHarnessIngestion(input: {
    workspaceId: string;
  }): Promise<{ ingestionEnabled: false; fenceEpoch: number }> {
    return this.managedWorker().disableHarnessIngestion(input);
  }

  heartbeatManagedCollapseLease(
    input: Parameters<ManagedSessionWorkerPort["heartbeatManagedCollapseLease"]>[0]
  ): Promise<boolean> {
    return this.managedWorker().heartbeatManagedCollapseLease(input);
  }

  claimManagedCollapseEffects(
    input: Parameters<ManagedSessionWorkerPort["claimManagedCollapseEffects"]>[0]
  ): Promise<ManagedEffectClaim[]> {
    return this.managedWorker().claimManagedCollapseEffects(input);
  }

  completeManagedCollapseEffect(
    input: Parameters<ManagedSessionWorkerPort["completeManagedCollapseEffect"]>[0]
  ): Promise<boolean> {
    return this.managedWorker().completeManagedCollapseEffect(input);
  }

  retryManagedCollapseEffect(
    input: Parameters<ManagedSessionWorkerPort["retryManagedCollapseEffect"]>[0]
  ): Promise<boolean> {
    return this.managedWorker().retryManagedCollapseEffect(input);
  }

  runManagedCollapseEffect(
    input: Parameters<ManagedSessionWorkerPort["runManagedCollapseEffect"]>[0],
    apply: Parameters<ManagedSessionWorkerPort["runManagedCollapseEffect"]>[1]
  ): Promise<boolean> {
    return this.managedWorker().runManagedCollapseEffect(input, apply);
  }

  commitManagedCollapse(
    input: Parameters<ManagedCollapsePort["commitManagedCollapse"]>[0]
  ): Promise<ManagedCollapseCommitResult> {
    return new ManagedCollapseRepository(
      this.db,
      (tx) =>
        new DrizzleStorageAdapter(
          tx as unknown as DrizzleClient,
          undefined,
          this.dekUnwrapper,
          this.dekProvisioner
        )
    ).commitManagedCollapse(input);
  }

  // ─── Session ────────────────────────────────────────────────────────────────

  ingestHarnessEvent(input: {
    workspaceId: string;
    provenance: ManagedSessionProvenance;
    event: HarnessEvent;
    receivedAt: Date;
  }): Promise<HarnessEventAck> {
    return this.harness.ingestHarnessEvent(input);
  }

  async createSession(input: CreateSessionInput): Promise<MnemoSession> {
    return this.sessions.createSession(input);
  }
  async appendTurn(
    sessionId: string,
    turn: Omit<SessionTurn, "id" | "createdAt">
  ): Promise<number> {
    return this.sessions.appendTurn(sessionId, turn);
  }
  async listTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> {
    return this.sessions.listTurns(sessionId, workspaceId);
  }
  async listManagedCollapseTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> {
    return this.managedSessions.listManagedCollapseTurns(sessionId, workspaceId);
  }
  claimManagedSessions(input: {
    workspaceId: string;
    leaseOwner: string;
    limit: number;
    inactivityMs: number;
    provisionalGraceMs: number;
    leaseMs: number;
  }): Promise<ManagedSessionClaim[]> {
    return this.managedSessions.claimManagedSessions(input);
  }
  markManagedCollapseRetry(input: {
    workspaceId: string;
    sessionId: string;
    leaseOwner: string;
    error: string;
    baseRetryMs: number;
    maxRetryMs: number;
  }): Promise<ManagedCollapseRetry | null> {
    return this.managedSessions.markManagedCollapseRetry(input);
  }
  finalizeManagedArchive(input: {
    workspaceId: string;
    sessionId: string;
    leaseOwner: string;
    operationId: string;
    reason: ManagedArchiveReason;
  }): Promise<boolean> {
    return this.managedSessions.finalizeManagedArchive(input);
  }
  releaseExpiredManagedLeases(input: { workspaceId: string }): Promise<number> {
    return this.managedSessions.releaseExpiredManagedLeases(input);
  }
  retryLegacyManagedArchive(input: { workspaceId: string; sessionId: string }): Promise<boolean> {
    return this.managedSessions.retryLegacyManagedArchive(input);
  }
  quiesceManagedLifecycle(input: { workspaceId: string }): Promise<ManagedLifecycleQuiesceResult> {
    return this.managedSessions.quiesceManagedLifecycle(input);
  }
  purgeManagedTurns(input: {
    workspaceId: string;
    terminalBefore: Date;
    limit: number;
  }): Promise<number> {
    return this.managedSessions.purgeManagedTurns(input);
  }
  async closeSession(id: string, workspaceId: string): Promise<void> {
    return this.sessions.closeSession(id, workspaceId);
  }
  /** LIFECYCLE-7/8 — same tx-scoped adapter factory commitManagedCollapse uses. */
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
    return this.sessions.commitSessionCollapse(
      input,
      (tx) =>
        new DrizzleStorageAdapter(
          tx as unknown as DrizzleClient,
          undefined,
          this.dekUnwrapper,
          this.dekProvisioner
        ) as StorageAdapter,
      apply
    );
  }
  async recordCollapseFailure(id: string, workspaceId: string, error: string): Promise<void> {
    return this.sessions.recordCollapseFailure(id, workspaceId, error);
  }
  async archiveSession(id: string, workspaceId: string, reason?: string): Promise<void> {
    return this.sessions.archiveSession(id, workspaceId, reason);
  }
  async getSession(id: string, workspaceId: string): Promise<MnemoSession | null> {
    return this.sessions.getSession(id, workspaceId);
  }
  async listSessions(
    workspaceId: string,
    limit?: number,
    offset?: number
  ): Promise<MnemoSession[]> {
    return this.sessions.listSessions(workspaceId, limit, offset);
  }
  async pinSessionTurn(input: {
    sessionId: string;
    workspaceId: string;
    turnId?: string;
    turnIndex?: number;
    pinned: boolean;
  }): Promise<boolean> {
    return this.sessions.pinSessionTurn(input);
  }
  async replaceSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
    scratch: Record<string, unknown>;
  }): Promise<boolean> {
    return this.sessions.replaceSessionScratch(input);
  }
  async getSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<Record<string, unknown> | null> {
    return this.sessions.getSessionScratch(input);
  }
  async updateSessionSummary(args: {
    sessionId: string;
    workspaceId: string;
    summary: Record<string, unknown>;
    factCount: number;
  }): Promise<void> {
    return this.sessions.updateSessionSummary(args);
  }
  async recordSessionOutcome(
    sessionId: string,
    workspaceId: string,
    rating: "success" | "failure" | "neutral"
  ): Promise<boolean> {
    return this.sessions.recordSessionOutcome(sessionId, workspaceId, rating);
  }
  async recordSessionRecall(sessionId: string, workspaceId: string): Promise<void> {
    return this.sessions.recordSessionRecall(sessionId, workspaceId);
  }

  // ─── Facts ──────────────────────────────────────────────────────────────────

  /**
   * Every fact this adapter hands out passes through here: confidential and
   * restricted rows come back with their text decrypted under the writing
   * actor's DEK, or with a placeholder and `redacted` when that key is gone
   * (crypto-erasure) or there is no key ring. See encryption/fact-decryptor.ts.
   */
  private openFacts<T extends { statement: string; subject?: string; actorId?: string | null }>(
    workspaceId: string,
    items: T[]
  ) {
    return openFacts(this.db, this.dekUnwrapper, workspaceId, items);
  }
  private async openFact(workspaceId: string, fact: MnemoFact | null): Promise<MnemoFact | null> {
    return fact ? (await this.openFacts(workspaceId, [fact]))[0]! : null;
  }

  async createFact(input: CreateFactInput): Promise<MnemoFact> {
    return (await this.openFact(input.workspaceId, await this.facts.createFact(input)))!;
  }
  async getFact(id: string, workspaceId: string): Promise<MnemoFact | null> {
    return this.openFact(workspaceId, await this.facts.getFact(id, workspaceId));
  }

  async findFactByImportedId(workspaceId: string, importedId: string): Promise<MnemoFact | null> {
    return this.openFact(
      workspaceId,
      await this.facts.findFactByImportedId(workspaceId, importedId)
    );
  }
  async updateFact(
    id: string,
    workspaceId: string,
    input: UpdateFactInput
  ): Promise<MnemoFact | null> {
    return this.openFact(workspaceId, await this.facts.updateFact(id, workspaceId, input));
  }
  async mergeFactByTopicKey(input: MergeFactByTopicKeyInput): Promise<MnemoFact | null> {
    return this.openFact(input.workspaceId, await this.facts.mergeFactByTopicKey(input));
  }
  async replaceFact(input: ReplaceFactInput): Promise<ReplaceFactResult | null> {
    const result = await this.facts.replaceFact(input);
    if (!result) return null;
    const [previous, replacement] = await this.openFacts(input.workspaceId, [
      result.previous,
      result.replacement,
    ]);
    return { previous: previous!, replacement: replacement! };
  }
  async archiveFact(id: string, workspaceId: string): Promise<boolean> {
    return this.facts.archiveFact(id, workspaceId);
  }

  async findLiveFactByStatement(input: FindLiveFactByStatementInput): Promise<MnemoFact | null> {
    return this.openFact(input.workspaceId, await this.facts.findLiveFactByStatement(input));
  }
  async linkSessionFactsToEpisode(
    workspaceId: string,
    sessionId: string,
    episodeId: string
  ): Promise<number> {
    return this.facts.linkSessionFactsToEpisode(workspaceId, sessionId, episodeId);
  }
  async queryFacts(filter: FactFilter): Promise<PaginatedResult<MnemoFact>> {
    const page = await this.facts.queryFacts(filter);
    return { ...page, items: await this.openFacts(filter.workspaceId, page.items) };
  }
  async queryFactsPage(filter: FactPageFilter): Promise<FactPage> {
    const page = await this.facts.queryFactsPage(filter);
    return { ...page, items: await this.openFacts(filter.workspaceId, page.items) };
  }
  async queryDeletedFactsPage(filter: {
    workspaceId: string;
    cursor?: string;
    deletedSince?: Date;
    limit: number;
  }): Promise<{ id: string; deletedAt: Date; createdAt: Date | null; cursor: string }[]> {
    return this.facts.queryDeletedFactsPage(filter);
  }
  async federationServeMark(workspaceId: string, peerId: string): Promise<Date | null> {
    return this.facts.federationServeMark(workspaceId, peerId);
  }
  async raiseFederationServeMark(
    workspaceId: string,
    peerId: string,
    servedUntil: Date
  ): Promise<void> {
    return this.facts.raiseFederationServeMark(workspaceId, peerId, servedUntil);
  }
  async relocateFact(input: {
    id: string;
    fromWorkspaceId: string;
    toWorkspaceId: string;
    actorId: string;
    reason?: string;
  }): Promise<{ previousId: string; newId: string } | null> {
    return this.facts.relocateFact(input);
  }

  async purgeForgottenFacts(workspaceId: string, actorId: string): Promise<number> {
    return this.facts.purgeForgottenFacts(workspaceId, actorId);
  }
  async getWorkspaceVitals(workspaceId: string): Promise<WorkspaceVitals> {
    return this.facts.getVitals(workspaceId);
  }
  async getAuditFeed(filter: AuditFeedFilter): Promise<AuditFeedEntry[]> {
    return this.facts.getAuditFeed(filter);
  }
  async getAuditFeedStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<AuditFeedStats> {
    return this.facts.getAuditFeedStats(input);
  }
  async getHealthSnapshot(input: GetHealthSnapshotInput): Promise<HealthSnapshot | null> {
    return this.health.getHealthSnapshot(input);
  }
  async getHealthSnapshots(input: {
    workspaceId: string;
    days: number;
  }): Promise<HealthSnapshotDay[]> {
    return this.health.getHealthSnapshots(input);
  }
  async applyConsolidationMerge(
    input: ApplyConsolidationMergeInput
  ): Promise<ConsolidationMergeSnapshot | null> {
    return this.consolidation.applyConsolidationMerge(input);
  }
  async rollbackConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    review: ReplayFailureReview;
  }): Promise<"rolled_back" | "conflict"> {
    return this.consolidation.rollbackConsolidationMerge(input);
  }
  async finalizeConsolidationMerge(input: {
    snapshot: ConsolidationMergeSnapshot;
    applyReplayBoost: boolean;
  }): Promise<"finalized" | "conflict"> {
    return this.consolidation.finalizeConsolidationMerge(input);
  }
  async refreshConsolidationMergeLease(input: {
    snapshot: ConsolidationMergeSnapshot;
    leaseExpiresAt: Date;
  }): Promise<"refreshed" | "conflict"> {
    return this.consolidation.refreshConsolidationMergeLease(input);
  }
  async inspectConsolidationMergeState(
    snapshot: ConsolidationMergeSnapshot
  ): Promise<"pending" | "restored" | "retained" | "divergent"> {
    return this.consolidation.inspectConsolidationMergeState(snapshot);
  }
  async recoverExpiredConsolidationMerges(input: {
    workspaceId: string;
    expiredBefore: Date;
  }): Promise<number> {
    return this.consolidation.recoverExpiredConsolidationMerges(input);
  }
  async findContradictingFacts(
    workspaceId: string,
    input: FindContradictingFactsInput
  ): Promise<ContradictingFact[]> {
    // Ceiling applied in the query; the rest opened like every fact read. A
    // candidate whose text cannot be opened has nothing to contradict.
    const rows = await this.openFacts(
      workspaceId,
      await this.facts.findContradictingFacts(workspaceId, input)
    );
    return rows.flatMap(({ actorId: _actorId, redacted, ...c }) => (redacted ? [] : [c]));
  }
  async setCanonical(id: string, workspaceId: string, canonical: boolean): Promise<void> {
    return this.facts.setCanonical(id, workspaceId, canonical);
  }
  async getRecalledFactIds(workspaceId: string, sessionId: string): Promise<string[]> {
    return this.facts.getRecalledFactIds(workspaceId, sessionId);
  }
  async getProvenanceCredit(
    workspaceId: string,
    terminalIds: string[],
    lambda: number,
    maxHops: number
  ): Promise<Array<{ factId: string; credit: number }>> {
    return this.facts.getProvenanceCredit(workspaceId, terminalIds, lambda, maxHops);
  }
  async listActiveLearningReview(
    filter: ActiveLearningReviewFilter
  ): Promise<ActiveLearningReviewRow[]> {
    return this.reviewQueue.listActiveLearningReview(filter);
  }
  async countUnresolvedActiveLearningReview(workspaceId: string): Promise<number> {
    return this.reviewQueue.countUnresolvedActiveLearningReview(workspaceId);
  }
  async enqueueActiveLearningReview(
    input: EnqueueActiveLearningReviewInput
  ): Promise<EnqueueActiveLearningReviewResult> {
    return this.reviewQueue.enqueueActiveLearningReview(input);
  }
  async resolveActiveLearningReview(
    input: ResolveActiveLearningReviewInput
  ): Promise<ResolveActiveLearningReviewResult> {
    return this.reviewQueue.resolveActiveLearningReview(input);
  }
  async lookupQueryCache(
    input: LookupQueryCacheInput
  ): Promise<{ resultIds: string[]; resultKinds: string[] } | null> {
    return this.facts.lookupQueryCache(input);
  }
  async pruneQueryCache(workspaceId: string, olderThanMs: number): Promise<number> {
    return this.facts.pruneQueryCache(workspaceId, olderThanMs);
  }
  async insertQueryCache(input: InsertQueryCacheInput): Promise<void> {
    return this.facts.insertQueryCache(input);
  }
  async getCachedEmbedding(
    workspaceId: string,
    textHash: string,
    model?: string
  ): Promise<Float32Array | null> {
    return this.facts.getCachedEmbedding(workspaceId, textHash, model);
  }
  async putCachedEmbedding(input: {
    workspaceId: string;
    textHash: string;
    embedding: Float32Array;
    model: string;
  }): Promise<void> {
    return this.facts.putCachedEmbedding(input);
  }
  async purgeFacts(filter: PurgeFactsFilter): Promise<PurgeFactsResult> {
    return this.facts.purgeFactsBySensitivity(filter);
  }

  // ─── Decisions ──────────────────────────────────────────────────────────────

  async createDecisionUnlessDuplicate(
    input: CreateDecisionInput
  ): Promise<{ decision: MnemoDecision; reused: boolean }> {
    return this.duplicates.createDecisionUnlessDuplicate(input);
  }
  async createDecision(input: CreateDecisionInput): Promise<MnemoDecision> {
    return this.decisions.createDecision(input);
  }
  async mergeDecisionByTopicKey(
    input: MergeDecisionByTopicKeyInput
  ): Promise<MnemoDecision | null> {
    return this.decisions.mergeDecisionByTopicKey(input);
  }
  async getDecision(id: string, workspaceId: string): Promise<MnemoDecision | null> {
    return this.decisions.getDecision(id, workspaceId);
  }
  async updateDecision(id: string, input: UpdateDecisionInput): Promise<MnemoDecision> {
    return this.decisions.updateDecision(id, input);
  }
  async archiveDecision(id: string, workspaceId: string): Promise<void> {
    return this.decisions.archiveDecision(id, workspaceId);
  }
  async supersedeDecision(input: SupersedeDecisionInput): Promise<MnemoDecision> {
    return this.decisions.supersedeDecision(input);
  }
  async queryDecisions(filter: DecisionFilter): Promise<PaginatedResult<MnemoDecision>> {
    return this.decisions.queryDecisions(filter);
  }

  // ─── Episodes ───────────────────────────────────────────────────────────────

  async createEpisode(input: CreateEpisodeInput): Promise<MnemoEpisode> {
    return this.episodes.createEpisode(input);
  }
  async getEpisode(id: string, workspaceId: string): Promise<MnemoEpisode | null> {
    return this.episodes.getEpisode(id, workspaceId);
  }
  async reconstructEpisode(id: string, workspaceId: string): Promise<MnemoEpisode> {
    return this.episodes.reconstructEpisode(id, workspaceId);
  }
  async getEpisodeTreeNeighbors(
    episodeId: string,
    workspaceId: string,
    limit?: number
  ): Promise<MnemoEpisode[]> {
    return this.episodes.getEpisodeTreeNeighbors(episodeId, workspaceId, limit);
  }
  async findSimilarEpisodes(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEpisode[]> {
    return this.episodes.findSimilarEpisodes(workspaceId, embedding, limit, minSim);
  }
  async updateEpisode(id: string, input: UpdateEpisodeInput): Promise<MnemoEpisode> {
    return this.episodes.updateEpisode(id, input);
  }
  // ─── Entity vector search (P16) ─────────────────────────────────────────────
  async findSimilarEntities(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEntity[]> {
    return this.entities.findSimilarEntities(workspaceId, embedding, limit, minSim);
  }
  async archiveEpisode(id: string, workspaceId: string): Promise<void> {
    return this.episodes.archiveEpisode(id, workspaceId);
  }
  async queryEpisodes(filter: EpisodeFilter): Promise<PaginatedResult<MnemoEpisode>> {
    return this.episodes.queryEpisodes(filter);
  }
  async getKnowledgeDistribution(
    workspaceId: string
  ): Promise<Partial<Record<RememberKind, number>>> {
    return this.episodes.getKnowledgeDistribution(workspaceId);
  }
  async persistCompression(input: {
    workspaceId: string;
    rootEpisodeId: string;
    compressedNarrative: string;
    retainedDeltas: Array<{ episodeId: string; deltaContent: string }>;
  }): Promise<void> {
    return this.episodes.persistCompression(input);
  }

  // ─── Entities ───────────────────────────────────────────────────────────────

  async createEntity(input: CreateEntityInput): Promise<MnemoEntity> {
    return this.entities.createEntity(input);
  }
  async getEntity(id: string, workspaceId: string): Promise<MnemoEntity | null> {
    return this.entities.getEntity(id, workspaceId);
  }
  async updateEntity(id: string, input: UpdateEntityInput): Promise<MnemoEntity> {
    return this.entities.updateEntity(id, input);
  }
  async archiveEntity(id: string, workspaceId: string): Promise<void> {
    return this.entities.archiveEntity(id, workspaceId);
  }
  async supersedeEntity(input: SupersedeEntityInput): Promise<MnemoEntity> {
    return this.entities.supersedeEntity(input);
  }
  async queryEntities(filter: EntityFilter): Promise<PaginatedResult<MnemoEntity>> {
    return this.entities.queryEntities(filter);
  }

  // ─── Strategies ─────────────────────────────────────────────────────────────

  async createStrategyUnlessDuplicate(
    input: CreateStrategyInput
  ): Promise<{ strategy: MnemoStrategy; reused: boolean }> {
    return this.duplicates.createStrategyUnlessDuplicate(input);
  }
  async createStrategy(input: CreateStrategyInput): Promise<MnemoStrategy> {
    return this.knowledge.createStrategy(input);
  }
  async getStrategy(id: string, workspaceId: string): Promise<MnemoStrategy | null> {
    return this.knowledge.getStrategy(id, workspaceId);
  }
  async updateStrategy(id: string, input: UpdateStrategyInput): Promise<MnemoStrategy> {
    return this.knowledge.updateStrategy(id, input);
  }
  async archiveStrategy(id: string, workspaceId: string): Promise<void> {
    return this.knowledge.archiveStrategy(id, workspaceId);
  }
  async queryStrategies(filter: StrategyFilter): Promise<PaginatedResult<MnemoStrategy>> {
    return this.knowledge.queryStrategies(filter);
  }

  // ─── Workflows ──────────────────────────────────────────────────────────────

  async createWorkflow(input: CreateWorkflowInput): Promise<MnemoWorkflow> {
    return this.knowledge.createWorkflow(input);
  }
  async getWorkflow(id: string, workspaceId: string): Promise<MnemoWorkflow | null> {
    return this.knowledge.getWorkflow(id, workspaceId);
  }
  async updateWorkflow(id: string, input: UpdateWorkflowInput): Promise<MnemoWorkflow> {
    return this.knowledge.updateWorkflow(id, input);
  }
  async archiveWorkflow(id: string, workspaceId: string): Promise<void> {
    return this.knowledge.archiveWorkflow(id, workspaceId);
  }
  async queryWorkflows(filter: WorkflowFilter): Promise<PaginatedResult<MnemoWorkflow>> {
    return this.knowledge.queryWorkflows(filter);
  }

  // ─── Skills ─────────────────────────────────────────────────────────────────

  async createSkill(input: CreateSkillInput): Promise<MnemoSkill> {
    return this.knowledge.createSkill(input);
  }
  async getSkill(id: string, workspaceId: string): Promise<MnemoSkill | null> {
    return this.knowledge.getSkill(id, workspaceId);
  }
  async updateSkill(id: string, input: UpdateSkillInput): Promise<MnemoSkill> {
    return this.knowledge.updateSkill(id, input);
  }
  async archiveSkill(id: string, workspaceId: string): Promise<void> {
    return this.knowledge.archiveSkill(id, workspaceId);
  }
  async querySkills(filter: SkillFilter): Promise<PaginatedResult<MnemoSkill>> {
    return this.knowledge.querySkills(filter);
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────────

  async listTasksForSession(
    workspaceId: string,
    sessionId: string
  ): Promise<Array<{ id: string; status: string }>> {
    return this.tasks.listTasksForSession(workspaceId, sessionId);
  }
  async createTask(input: CreateTaskInput): Promise<MnemoTask> {
    return this.tasks.createTask(input);
  }
  async getTask(id: string, workspaceId: string): Promise<MnemoTask | null> {
    return this.tasks.getTask(id, workspaceId);
  }
  async updateTask(id: string, input: UpdateTaskInput): Promise<MnemoTask> {
    return this.tasks.updateTask(id, input);
  }
  async archiveTask(id: string, workspaceId: string): Promise<void> {
    return this.tasks.archiveTask(id, workspaceId);
  }
  async delegateTask(
    id: string,
    workspaceId: string,
    input: { assignedTo: string; delegatedBy: string }
  ): Promise<MnemoTask> {
    return this.tasks.delegateTask(id, workspaceId, input);
  }
  async queryTasks(filter: TaskFilter): Promise<PaginatedResult<MnemoTask>> {
    return this.tasks.queryTasks(filter);
  }

  // ─── Events ─────────────────────────────────────────────────────────────────

  async createEvent(input: CreateEventInput): Promise<MnemoEvent> {
    return this.events.createEvent(input);
  }
  async getEvent(id: string, workspaceId: string): Promise<MnemoEvent | null> {
    return this.events.getEvent(id, workspaceId);
  }
  async archiveEvent(id: string, workspaceId: string): Promise<void> {
    return this.events.archiveEvent(id, workspaceId);
  }
  async appendEventAnnotation(
    id: string,
    workspaceId: string,
    annotation: { author: string; content: string; at: Date }
  ): Promise<MnemoEvent> {
    return this.events.appendEventAnnotation(id, workspaceId, annotation);
  }
  async queryEvents(filter: EventFilter): Promise<PaginatedResult<MnemoEvent>> {
    return this.events.queryEvents(filter);
  }
  async updateEventSensitivity(
    id: string,
    workspaceId: string,
    sensitivity: Sensitivity
  ): Promise<void> {
    return this.events.updateEventSensitivity(id, workspaceId, sensitivity);
  }

  // ─── Reasoning ──────────────────────────────────────────────────────────────

  async createReasoning(input: CreateReasoningInput): Promise<MnemoReasoning> {
    return this.reasonings.createReasoning(input);
  }
  async getReasoning(id: string, workspaceId: string): Promise<MnemoReasoning | null> {
    return this.reasonings.getReasoning(id, workspaceId);
  }
  async updateReasoning(id: string, input: UpdateReasoningInput): Promise<MnemoReasoning> {
    return this.reasonings.updateReasoning(id, input);
  }
  async archiveReasoning(id: string, workspaceId: string): Promise<void> {
    return this.reasonings.archiveReasoning(id, workspaceId);
  }
  async queryReasoning(filter: ReasoningFilter): Promise<PaginatedResult<MnemoReasoning>> {
    return this.reasonings.queryReasoning(filter);
  }
  async searchReasoning(input: {
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
    return this.reasonings.searchReasoning(input);
  }
  async recordReasoningUse(id: string, workspaceId: string): Promise<void> {
    return this.reasonings.recordReasoningUse(id, workspaceId);
  }
  async setReasoningStatus(
    id: string,
    workspaceId: string,
    status: MnemoReasoning["status"]
  ): Promise<void> {
    return this.reasonings.setReasoningStatus(id, workspaceId, status);
  }
  async getAgentProfile(workspaceId: string, agentId: string): Promise<MnemoAgentProfile | null> {
    return this.reasonings.getAgentProfile(workspaceId, agentId);
  }
  async upsertAgentProfile(input: {
    workspaceId: string;
    agentId: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MnemoAgentProfile> {
    return this.reasonings.upsertAgentProfile(input);
  }
  async incrementSessionsSinceReflection(workspaceId: string, agentId: string): Promise<number> {
    return this.reasonings.incrementSessionsSinceReflection(workspaceId, agentId);
  }

  // ─── Relations ──────────────────────────────────────────────────────────────

  async createRelation(input: CreateRelationInput): Promise<MnemoRelation> {
    return this.graph.createRelation(input);
  }
  async getRelations(filter: RelationFilter): Promise<MnemoRelation[]> {
    return this.graph.getRelations(filter);
  }
  async updateRelationStrength(id: string, delta: number): Promise<void> {
    return this.graph.updateRelationStrength(id, delta);
  }
  async deleteRelation(id: string, workspaceId: string): Promise<void> {
    return this.graph.deleteRelation(id, workspaceId);
  }
  async closeRelation(
    id: string,
    workspaceId: string,
    opts?: { maxSensitivity?: Sensitivity }
  ): Promise<boolean> {
    return this.graph.closeRelation(id, workspaceId, opts);
  }
  // B5 — implemented on `facts` (not `graph`), matching `replaceFact`'s
  // existing precedent of cross-entity (fact + relation) atomic writes.
  async resolveConflict(input: ResolveConflictInput): Promise<ResolveConflictResult> {
    return this.facts.resolveConflict(input);
  }
  async applyRelationJudgment(input: ApplyRelationJudgmentInput): Promise<MnemoRelation | null> {
    return this.graph.applyRelationJudgment(input);
  }

  // ─── Citations (flatten-legacy-dual-core PR9e, design.md D6.5) ────────────────

  async listCitations(filter: CitationFilter): Promise<MnemoCitation[]> {
    return this.citations.listCitations(filter);
  }

  // ─── Graph snapshot (flatten-legacy-dual-core PR9f, design.md D6.5) ───────────

  async getGraphSnapshot(filter: GraphSnapshotFilter): Promise<GraphSnapshot> {
    return this.graph.getGraphSnapshot(filter);
  }

  async countEntityMentions(input: {
    workspaceId: string;
    entityIds: string[];
    maxSensitivity?: Sensitivity;
  }): Promise<Record<string, number>> {
    return this.graph.countEntityMentions(input);
  }

  async findHiddenIds(input: {
    workspaceId: string;
    ids: string[];
    maxSensitivity: Sensitivity;
  }): Promise<string[]> {
    return this.graph.findHiddenIds(input);
  }

  async countOpenConflicts(input: {
    workspaceId: string;
    maxSensitivity?: Sensitivity;
  }): Promise<number> {
    return this.graph.countOpenConflicts(input);
  }

  // ─── Semantic-neighbor backfill (flatten-legacy-dual-core PR9g, design.md D6.5) ─

  async backfillSemanticNeighbors(input: {
    workspaceId: string;
    k?: number;
    threshold?: number;
    modelVersion?: string;
  }): Promise<number> {
    return this.graph.backfillSemanticNeighbors(input);
  }

  // ─── Hyperedges ─────────────────────────────────────────────────────────────

  async createHyperedge(input: CreateHyperedgeInput): Promise<MnemoHyperedge> {
    return this.graph.createHyperedge(input);
  }
  async getHyperedge(
    id: string,
    workspaceId: string,
    opts?: { includeClosed?: boolean; maxSensitivity?: Sensitivity }
  ): Promise<MnemoHyperedge | null> {
    return this.graph.getHyperedge(id, workspaceId, opts);
  }
  async updateHyperedge(id: string, input: UpdateHyperedgeInput): Promise<MnemoHyperedge> {
    return this.graph.updateHyperedge(id, input);
  }
  async archiveHyperedge(id: string, workspaceId: string): Promise<void> {
    return this.graph.archiveHyperedge(id, workspaceId);
  }
  async queryHyperedges(filter: HyperedgeFilter): Promise<PaginatedResult<MnemoHyperedge>> {
    return this.graph.queryHyperedges(filter);
  }
  async bumpHyperedgeActivation(id: string, workspaceId: string): Promise<void> {
    return this.graph.bumpHyperedgeActivation(id, workspaceId);
  }

  // ─── Worth / Recall ─────────────────────────────────────────────────────────

  async updateWorth(
    id: string,
    workspaceId: string,
    primitiveKind: PrimitiveKind,
    delta: WorthDelta
  ): Promise<void> {
    return this.recall.updateWorth(id, workspaceId, primitiveKind, delta);
  }
  async recordRecall(entry: RecallLogEntry): Promise<void> {
    return this.recall.recordRecall(entry);
  }
  async recordRecallObservation(
    request: RecallRequestObservation,
    hits: RecallHitObservation[]
  ): Promise<void> {
    return this.recall.recordRecallObservation(request, hits);
  }
  async getTdPredecessors(
    workspaceId: string,
    sessionId: string,
    excludeFactId: string
  ): Promise<Array<{ factId: string; tdCredit: number; recalledAt: Date }>> {
    return this.recall.getTdPredecessors(workspaceId, sessionId, excludeFactId);
  }
  async getRecallPrecision(workspaceId: string): Promise<RecallPrecisionReport> {
    return this.recall.getRecallPrecision(workspaceId);
  }
  async getContextEconomy(workspaceId: string, days: number, maxSensitivity: Sensitivity) {
    return this.recall.getContextEconomy(workspaceId, days, maxSensitivity);
  }

  async getRecallLatency(
    workspaceId: string,
    days: number
  ): Promise<{ p50Ms: number | null; p95Ms: number | null; samples: number }> {
    return this.recall.getRecallLatency(workspaceId, days);
  }
  async getWritesPerDay(
    workspaceId: string,
    days: number
  ): Promise<Array<{ day: string; count: number }>> {
    return this.facts.getWritesPerDay(workspaceId, days);
  }
  async getRecallMetrics(workspaceId: string, days: number): Promise<RecallMetrics> {
    return this.recall.getRecallMetrics(workspaceId, days);
  }
  async getSessionStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<SessionStats> {
    return this.sessions.getSessionStats(input);
  }
  async getFactStats(input: {
    workspaceId: string;
    maxSensitivity?: Sensitivity;
  }): Promise<FactStats> {
    return this.recall.getFactStats(input);
  }
  async getRecallLog(
    workspaceId: string,
    memoryId: string,
    limit: number
  ): Promise<Array<{ id: string; recalledAt: string; recallScore: number }>> {
    return this.recall.getRecallLog(workspaceId, memoryId, limit);
  }
  async getRecallLogs(
    workspaceId: string,
    memoryIds: string[],
    limitPerMemory: number
  ): Promise<RecallLogRecord[]> {
    return this.recall.getRecallLogs(workspaceId, memoryIds, limitPerMemory);
  }
  async getRecallPrimitives(
    workspaceId: string,
    refs: RecallPrimitiveRef[]
  ): Promise<RecallPrimitiveRecord[]> {
    const records = await this.recall.getRecallPrimitives(workspaceId, refs);
    const facts = records.filter((r) => r.kind === "fact");
    if (facts.length === 0) return records;
    const opened = await this.openFacts(
      workspaceId,
      facts.map((r) => r.value as MnemoFact)
    );
    const byId = new Map(opened.map((f) => [f.id, f]));
    // Same rule as the candidate arms: a fact that cannot be opened is not a hit.
    return records.flatMap((r) => {
      if (r.kind !== "fact") return [r];
      const fact = byId.get(r.id)!;
      return fact.redacted ? [] : [{ ...r, value: fact }];
    });
  }
  async getRecallStructures(
    workspaceId: string,
    sourceIds: string[],
    hyperedgeLimitPerMember: number,
    maxSensitivity?: Sensitivity
  ): Promise<RecallStructures> {
    return this.recall.getRecallStructures(
      workspaceId,
      sourceIds,
      hyperedgeLimitPerMember,
      maxSensitivity
    );
  }
  async getRecentQueriesForFacts(
    workspaceId: string,
    factIds: string[],
    limit: number
  ): Promise<string[]> {
    return this.recall.getRecentQueriesForFacts(workspaceId, factIds, limit);
  }
  async recordCoRecallStdp(
    workspaceId: string,
    relationId: string,
    coRecalledAt: Date
  ): Promise<void> {
    return this.recall.recordCoRecallStdp(workspaceId, relationId, coRecalledAt);
  }
  async normalizeHebbianWeights(workspaceId: string): Promise<number> {
    return this.recall.normalizeHebbianWeights(workspaceId);
  }
  async decayKind(
    workspaceId: string,
    decayClass: DecayClass,
    halfLifeDays: number
  ): Promise<number> {
    return this.recall.decayKind(workspaceId, decayClass, halfLifeDays);
  }
  async isConsolidationLocked(workspaceId: string): Promise<boolean> {
    return this.recall.isConsolidationLocked(workspaceId);
  }
  async enqueueReviewItem(input: {
    workspaceId: string;
    primitiveId: string;
    primitiveKind?: string;
    reason: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    return this.recall.enqueueReviewItem(input);
  }
  async enqueueReview(input: {
    workspaceId: string;
    primitiveKind: string;
    primitiveId: string;
    reason: string;
    priority?: number;
  }): Promise<void> {
    // Sweep callers (governance demote, stale tasks) re-flag every run.
    return this.recall.enqueueReviewItem(input, { skipIfPending: true });
  }
  async queryDriftCandidates(workspaceId: string): Promise<
    Array<{
      id: string;
      statement: string;
      metadata: Record<string, unknown>;
      sensitivity: Sensitivity;
    }>
  > {
    return this.recall.queryDriftCandidates(workspaceId);
  }
  async lookupFactHash(workspaceId: string, statementHash: string): Promise<MnemoFactHash | null> {
    return this.recall.lookupFactHash(workspaceId, statementHash);
  }
  async upsertFactHash(input: UpsertFactHashInput): Promise<MnemoFactHash> {
    return this.recall.upsertFactHash(input);
  }
  async upsertFactLsh(input: UpsertFactLshInput): Promise<void> {
    return this.recall.upsertFactLsh(input);
  }
  // Recall leaves out a fact whose text cannot be opened: a hit that says
  // "[erased]" answers nothing. GET /facts/:id still shows it, flagged.
  async pointerCandidates(query: PointerCandidateQuery): Promise<PointerCandidate[]> {
    const rows = await this.recall.pointerCandidates(query);
    return (await this.openFacts(query.workspaceId, rows)).filter((r) => !r.redacted);
  }
  async ftsCandidates(query: Omit<PointerCandidateQuery, "bands">): Promise<FtsCandidate[]> {
    const rows = await this.recall.ftsCandidates(query);
    return (await this.openFacts(query.workspaceId, rows)).filter((r) => !r.redacted);
  }
  async recallableCandidates(query: PrimitiveCandidateQuery): Promise<PrimitiveCandidate[]> {
    return this.recall.recallableCandidates(query);
  }
  async federatedRecallCandidates(
    query: FederatedRecallQuery
  ): Promise<FederatedRecallCandidate[]> {
    return this.recall.federatedRecallCandidates(query);
  }

  getUnresolvedConflictIds(
    workspaceId: string,
    ids: string[],
    maxSensitivity?: Sensitivity
  ): Promise<string[]> {
    return this.recall.getUnresolvedConflictIds(workspaceId, ids, maxSensitivity);
  }

  // ─── Audit / Outbox ─────────────────────────────────────────────────────────

  async appendAuditEntry(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<void> {
    return this.audit.appendAuditEntry(entry);
  }
  async getAuditActivity(input: {
    workspaceId: string;
    days: number;
    actorIds: string[];
  }): Promise<AuditActivity> {
    return this.audit.getAuditActivity(input);
  }
  async listAuditLog(workspaceId: string, limit: number): Promise<AuditLogEntry[]> {
    return this.audit.listAuditLog(workspaceId, limit);
  }
  async appendOutbox(entry: Omit<OutboxEntry, "id" | "createdAt" | "attempts">): Promise<void> {
    return this.audit.appendOutbox(entry);
  }
  async claimOutbox(limit: number): Promise<OutboxEntry[]> {
    return this.audit.claimOutbox(limit);
  }
  async markOutboxProcessed(ids: string[]): Promise<void> {
    return this.audit.markOutboxProcessed(ids);
  }
  async markOutboxFailed(id: string, error: string): Promise<void> {
    return this.audit.markOutboxFailed(id, error);
  }
  async reapDeadLetters(maxAttempts: number): Promise<number> {
    return this.audit.reapDeadLetters(maxAttempts);
  }
  async purgeOutbox(olderThanMs: number): Promise<number> {
    return this.audit.purgeOutbox(olderThanMs);
  }
  async countPendingOutbox(): Promise<number> {
    return this.audit.countPendingOutbox();
  }
  async appendDeletionLog(input: {
    workspaceId: string;
    deletedItemId: string;
    deletedItemType: string;
    deletionType: "soft" | "hard" | "gdpr_erasure" | "federation_tombstone" | "retention_purge";
    actorId: string;
    reason?: string;
    itemCreatedAt?: Date;
  }): Promise<void> {
    return this.audit.appendDeletionLog(input);
  }

  // ─── Webhooks / Reminders ────────────────────────────────────────────────────

  async createWebhookEndpoint(input: CreateWebhookEndpointInput): Promise<MnemoWebhookEndpoint> {
    return this.webhooks.createWebhookEndpoint(input);
  }
  async getWebhookEndpoint(id: string, workspaceId: string): Promise<MnemoWebhookEndpoint | null> {
    return this.webhooks.getWebhookEndpoint(id, workspaceId);
  }
  async listWebhookEndpoints(workspaceId: string): Promise<MnemoWebhookEndpoint[]> {
    return this.webhooks.listWebhookEndpoints(workspaceId);
  }
  async updateWebhookEndpoint(
    id: string,
    workspaceId: string,
    input: UpdateWebhookEndpointInput
  ): Promise<MnemoWebhookEndpoint> {
    return this.webhooks.updateWebhookEndpoint(id, workspaceId, input);
  }
  async deleteWebhookEndpoint(id: string, workspaceId: string): Promise<void> {
    return this.webhooks.deleteWebhookEndpoint(id, workspaceId);
  }
  async recordWebhookDelivery(entry: CreateWebhookDeliveryInput): Promise<void> {
    return this.webhooks.recordWebhookDelivery(entry);
  }
  async listWebhookDeliveries(
    webhookId: string,
    workspaceId: string,
    limit?: number
  ): Promise<MnemoWebhookDelivery[]> {
    return this.webhooks.listWebhookDeliveries(webhookId, workspaceId, limit);
  }
  async listPendingWebhookDeliveries(limit: number): Promise<MnemoWebhookDelivery[]> {
    return this.webhooks.listPendingWebhookDeliveries(limit);
  }
  async updateWebhookDelivery(
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
    return this.webhooks.updateWebhookDelivery(id, workspaceId, update);
  }
  async createReminder(input: CreateReminderInput): Promise<MnemoReminder> {
    return this.webhooks.createReminder(input);
  }
  async getReminder(id: string, workspaceId: string): Promise<MnemoReminder | null> {
    return this.webhooks.getReminder(id, workspaceId);
  }
  async listPendingReminders(workspaceId: string, asOf: Date): Promise<MnemoReminder[]> {
    return this.webhooks.listPendingReminders(workspaceId, asOf);
  }
  async dismissReminder(
    id: string,
    workspaceId: string,
    newStatus: "triggered" | "dismissed"
  ): Promise<void> {
    return this.webhooks.dismissReminder(id, workspaceId, newStatus);
  }
  async listReminders(
    workspaceId: string,
    status: "pending" | "triggered" | "dismissed" | "all",
    limit: number
  ): Promise<MnemoReminder[]> {
    return this.webhooks.listReminders(workspaceId, status, limit);
  }
  claimUndeliveredReminders(
    workspaceId: string,
    input: { ids: string[]; limit: number }
  ): Promise<MnemoReminder[]> {
    return this.webhooks.claimUndeliveredReminders(workspaceId, input);
  }

  // ─── GDPR Encryption ────────────────────────────────────────────────────────

  async getActorDek(workspaceId: string, actorId: string): Promise<string | null> {
    return this.encryption.getActorDek(workspaceId, actorId);
  }
  async destroyActorDek(workspaceId: string, actorId: string): Promise<boolean> {
    return this.encryption.destroyActorDek(workspaceId, actorId);
  }
  async destroyUserDeks(workspaceId: string, userId: string): Promise<number> {
    return this.encryption.destroyUserDeks(workspaceId, userId);
  }
  async hardDeleteFact(
    id: string,
    workspaceId: string,
    audit?: { actorId: string; reason?: string }
  ): Promise<{ createdAt: Date } | false> {
    return this.encryption.hardDeleteFact(id, workspaceId, audit);
  }

  // ─── Composition ────────────────────────────────────────────────────────────

  async createCompositionRule(input: CreateCompositionRuleInput): Promise<MnemoCompositionRule> {
    return this.compositions.createCompositionRule(input);
  }
  async getCompositionRule(id: string, workspaceId: string): Promise<MnemoCompositionRule | null> {
    return this.compositions.getCompositionRule(id, workspaceId);
  }
  async updateCompositionRule(
    id: string,
    workspaceId: string,
    input: UpdateCompositionRuleInput
  ): Promise<MnemoCompositionRule> {
    return this.compositions.updateCompositionRule(id, workspaceId, input);
  }
  async queryCompositionRules(
    filter: CompositionRuleFilter
  ): Promise<PaginatedResult<MnemoCompositionRule>> {
    return this.compositions.queryCompositionRules(filter);
  }
  async bumpCompositionExecution(id: string, workspaceId: string): Promise<void> {
    return this.compositions.bumpCompositionExecution(id, workspaceId);
  }
  async ensureBuiltinCompositionRules(workspaceId: string): Promise<void> {
    return this.compositions.ensureBuiltinCompositionRules(workspaceId);
  }
  async appendInference(input: AppendInferenceInput): Promise<MnemoInferenceLogEntry> {
    return this.compositions.appendInference(input);
  }
  async materialiseInference(input: MaterialiseInferenceInput): Promise<{ id: string }> {
    return this.compositions.materialiseInference(input);
  }
  async queryInferences(
    filter: InferenceLogFilter
  ): Promise<PaginatedResult<MnemoInferenceLogEntry>> {
    return this.compositions.queryInferences(filter);
  }

  // ─── Embeddings ─────────────────────────────────────────────────────────────

  async listStaleEmbeddings(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string,
    limit: number,
    opts?: { plaintextOnly?: boolean }
  ): Promise<Array<{ id: string; text: string }>> {
    return this.embeddings.listStaleEmbeddings(table, workspaceId, currentModel, limit, opts);
  }

  async getEmbeddingSourceSensitivity(
    table: EmbeddableTable,
    id: string,
    workspaceId: string
  ): Promise<string | null> {
    return this.embeddings.getEmbeddingSourceSensitivity(table, id, workspaceId);
  }
  async markEmbeddingsStale(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string
  ): Promise<number> {
    return this.embeddings.markEmbeddingsStale(table, workspaceId, currentModel);
  }
  async hasActiveEmbeddingMigration(workspaceId: string, currentModel: string): Promise<boolean> {
    return this.embeddings.hasActiveEmbeddingMigration(workspaceId, currentModel);
  }
  async updateEmbeddingVector(
    table: EmbeddableTable,
    id: string,
    workspaceId: string,
    vector: number[],
    model: string
  ): Promise<void> {
    return this.embeddings.updateEmbeddingVector(table, id, workspaceId, vector, model);
  }
  async upsertHotTierSnapshot(rows: HotTierSnapshotRow[]): Promise<void> {
    return this.embeddings.upsertHotTierSnapshot(rows);
  }
  async loadHotTierSnapshots(workspaceId?: string): Promise<HotTierSnapshotRow[]> {
    return this.embeddings.loadHotTierSnapshots(workspaceId);
  }

  // ─── Analytics ──────────────────────────────────────────────────────────────

  async getConfidenceMap(
    workspaceId: string,
    opts?: { limit?: number }
  ): Promise<ConfidenceMapRow[]> {
    return this.analytics.getConfidenceMap(workspaceId, opts);
  }
  async getKnowledgeGaps(
    workspaceId: string,
    opts?: { limit?: number; minScore?: number }
  ): Promise<KnowledgeGapRow[]> {
    return this.analytics.getKnowledgeGaps(workspaceId, opts);
  }
  async getMetacognitionTrends(workspaceId: string): Promise<MetacognitionTrends> {
    return this.analytics.getMetacognitionTrends(workspaceId);
  }
  async refreshMetacognitionViews(): Promise<void> {
    return this.analytics.refreshMetacognitionViews();
  }
  async getSequentialPatterns(args: {
    workspaceId: string;
    predecessorId?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<SequentialPatternRow[]> {
    return this.analytics.getSequentialPatterns(args);
  }
  async getPeriodicPatterns(args: {
    workspaceId: string;
    dayOfWeek?: number;
    hourBucket?: number;
    limit?: number;
  }): Promise<PeriodicPatternRow[]> {
    return this.analytics.getPeriodicPatterns(args);
  }
  async refreshAnticipationViews(): Promise<void> {
    return this.analytics.refreshAnticipationViews();
  }
  async getConditionalPatterns(args: {
    workspaceId: string;
    queryKey?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<ConditionalPatternRow[]> {
    return this.analytics.getConditionalPatterns(args);
  }
  async getCoOccurrencePatterns(args: {
    workspaceId: string;
    sourceId: string;
    minCoRecall?: number;
    limit?: number;
  }): Promise<CoOccurrencePatternRow[]> {
    return this.analytics.getCoOccurrencePatterns(args);
  }

  // ─── Plugins ────────────────────────────────────────────────────────────────

  async getPluginState(
    workspaceId: string,
    pluginId: string
  ): Promise<Record<string, unknown> | null> {
    return this.plugins.getPluginState(workspaceId, pluginId);
  }
  async upsertPluginState(
    workspaceId: string,
    pluginId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    return this.plugins.upsertPluginState(workspaceId, pluginId, state);
  }
  async deletePluginStateKey(workspaceId: string, pluginId: string, key: string): Promise<void> {
    return this.plugins.deletePluginStateKey(workspaceId, pluginId, key);
  }
  async createPromptVersion(input: {
    workspaceId: string;
    agentId: string;
    promptText: string;
    diffFromPrevious: string;
    algorithm: string;
    trajectoriesUsed: number;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
    status: "candidate";
  }): Promise<{ id: string }> {
    return this.plugins.createPromptVersion(input);
  }
  async getActivePromptVersion(
    workspaceId: string,
    agentId: string
  ): Promise<{
    id: string;
    status: "candidate" | "testing" | "active" | "rolled_back";
    trajectoriesUsed: number | null;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
  } | null> {
    return this.plugins.getActivePromptVersion(workspaceId, agentId);
  }
  async listPromptVersions(
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
  > {
    return this.plugins.listPromptVersions(workspaceId, agentId);
  }
  async transitionPromptVersion(
    workspaceId: string,
    promptVersionId: string,
    newStatus: "testing" | "active" | "rolled_back",
    avgScoreAfter: number
  ): Promise<void> {
    return this.plugins.transitionPromptVersion(
      workspaceId,
      promptVersionId,
      newStatus,
      avgScoreAfter
    );
  }
  async listScoredTrajectories(
    workspaceId: string,
    agentId: string,
    limit: number
  ): Promise<
    Array<{ sessionId: string; score: number; promptVersionId: string | null; createdAt: Date }>
  > {
    return this.plugins.listScoredTrajectories(workspaceId, agentId, limit);
  }

  // ─── Metering ────────────────────────────────────────────────────────────────

  async appendMeterEvent(event: {
    workspaceId: string;
    metric: string;
    quantity: number;
    occurredAt: Date;
    costUsd: number;
    idempotencyKey: string;
  }): Promise<void> {
    return this.metering.appendMeterEvent(event);
  }
  async getWorkspaceEmbeddingTokenUsage(workspaceId: string, since: Date): Promise<number> {
    return this.metering.getWorkspaceEmbeddingTokenUsage(workspaceId, since);
  }
  async getWorkspaceMonthlyRecallCount(workspaceId: string): Promise<number> {
    return this.metering.getWorkspaceMonthlyRecallCount(workspaceId);
  }
  async getWorkspaceMonthlySpendUsd(workspaceId: string): Promise<number> {
    return this.metering.getWorkspaceMonthlySpendUsd(workspaceId);
  }
  async getMonthToDateUsageFromDb(workspaceId: string): Promise<Record<string, number>> {
    return this.metering.getMonthToDateUsageFromDb(workspaceId);
  }
  async computeCandidateAbScore(
    workspaceId: string,
    agentId: string,
    promptVersionId: string
  ): Promise<number | null> {
    return this.metering.computeCandidateAbScore(workspaceId, agentId, promptVersionId);
  }
  async listStaleTasks(
    workspaceId: string,
    staleSinceMs: number,
    limit: number
  ): Promise<Array<{ id: string; title: string; status: string; updatedAt: Date }>> {
    return this.metering.listStaleTasks(workspaceId, staleSinceMs, limit);
  }
  async countFactsByTypeStatus(): Promise<Array<{ type: string; status: string; count: number }>> {
    return this.metering.countFactsByTypeStatus();
  }
  async worthHistogram(): Promise<Array<{ bucket: string; count: number }>> {
    return this.metering.worthHistogram();
  }
  async countActiveSessions(): Promise<number> {
    return this.metering.countActiveSessions();
  }
  async countTasksByStatus(): Promise<Array<{ status: string; count: number }>> {
    return this.metering.countTasksByStatus();
  }
  async countStaleTasks(): Promise<number> {
    return this.metering.countStaleTasks();
  }

  // ─── Workspace ──────────────────────────────────────────────────────────────

  async getWorkspaceMode(workspaceId: string): Promise<{
    mode: "learning" | "production";
    sessionCount: number;
    promoteAt: number | null;
    startedAt?: Date;
    factCount?: number;
    entityCount?: number;
  } | null> {
    return this.workspace.getWorkspaceMode(workspaceId);
  }
  async setWorkspaceMode(
    workspaceId: string,
    patch: {
      mode?: "learning" | "production";
      sessionCount?: number;
      promoteAt?: number | null;
      factCount?: number;
      entityCount?: number;
    }
  ): Promise<void> {
    return this.workspace.setWorkspaceMode(workspaceId, patch);
  }
  async incrementWorkspaceModeCounters(
    workspaceId: string,
    delta: { factCount?: number; entityCount?: number; sessionCount?: number }
  ): Promise<void> {
    return this.workspace.incrementWorkspaceModeCounters(workspaceId, delta);
  }
  async listSessionTopicKeysBySource(
    workspaceId: string,
    sessionId: string,
    source: string
  ): Promise<string[]> {
    return this.workspace.listSessionTopicKeysBySource(workspaceId, sessionId, source);
  }
  async listWorkspaceIds(): Promise<string[]> {
    return this.workspace.listWorkspaceIds();
  }
  async listDueReminderWorkspaceIds(): Promise<string[]> {
    return this.workspace.listDueReminderWorkspaceIds();
  }
  async healthCheck(): Promise<HealthStatus> {
    return this.workspace.healthCheck();
  }
  async close(): Promise<void> {
    return this.workspace.close();
  }
  async runSql(query: string): Promise<Array<Record<string, unknown>>> {
    return this.workspace.runSql(query);
  }
}
