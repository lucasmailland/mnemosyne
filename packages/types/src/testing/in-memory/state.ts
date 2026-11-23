// in-memory/state.ts — the single shared, behaviour-free state object for
// InMemoryStorageAdapter's 32 domain modules (decompose-inmemory-storage-adapter
// Batch B0, design.md D1/D3). Every collection here is exactly the field that
// used to live directly on the class; nothing here has any behavior of its own.

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
} from "../../primitives.js";
import type { MnemoSession, SessionTurn } from "../../session.js";
import type { MnemoRelation, MnemoCitation } from "../../relations.js";
import type { AuditLogEntry } from "../../audit.js";
import type { OutboxEntry } from "../../outbox.js";
import type {
  RecallLogEntry,
  LshBandValue,
  HealthSnapshot,
  ReplayFailureReview,
  ActiveLearningReviewRow,
} from "../../ports.js";
import type { HarnessEventAck, ManagedSessionProvenance } from "../../harness.js";

export interface InMemoryHarnessSession {
  id: string;
  logicalSource: string;
  workspaceId: string;
  host: string;
  clientInstanceId: string;
  hostSessionId: string;
  generation: number;
  predecessorSessionId: string | null;
  status: "active" | "collapse_pending" | "collapsed" | "archived";
  closeKind: "authoritative" | "provisional" | null;
  terminalDigestVersion: number | null;
  terminalMaxEnqueueSequence: number | null;
  terminalMessageSetDigest: string | null;
  closeGraceDeadline: Date | null;
  closeRequestedAt: Date | null;
  sensitivity: "public" | "internal";
  provenance: ManagedSessionProvenance;
  startSequence: number;
  turnCount: number;
  tokenCount: number;
  lastActivityAt: Date;
  captureIncomplete: boolean;
  captureIncompleteReasons: string[];
  leased: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  collapseAttempts: number;
  collapseNextAttemptAt: Date | null;
  collapseOperationId: string | null;
  archiveReason: string | null;
  archivedAt: Date | null;
  collapsedAt: Date | null;
}

export interface InMemoryHarnessTurn {
  turnOrigin?: SessionTurn["turnOrigin"];
  turnOriginEvidence?: string;
  sessionId: string;
  workspaceId: string;
  turnIndex: number;
  sourceMessageId: string;
  supersedesSourceMessageId: string | null;
  role: "user" | "assistant";
  content: string;
  contentHash: string;
  retracted: boolean;
  retractedAt: Date | null;
  retractionReason: string | null;
  pinned: boolean;
  tokenCount: number;
  ingestionEventId: string;
  createdAt: Date;
}

export interface InMemoryHarnessLedger {
  id: string;
  workspaceId: string;
  eventId: string;
  logicalSource: string;
  enqueueSequence: number;
  payloadHash: string;
  provenance: ManagedSessionProvenance;
  state: "retryable" | "accepted" | "rejected" | "cancelled";
  acknowledgement: HarnessEventAck;
}

export interface InMemoryStorageState {
  // Data stores
  sessions: Map<string, MnemoSession>;
  turns: SessionTurn[];
  facts: Map<string, MnemoFact>;
  decisions: Map<string, MnemoDecision>;
  episodes: Map<string, MnemoEpisode>;
  entities: Map<string, MnemoEntity>;
  strategies: Map<string, MnemoStrategy>;
  workflows: Map<string, MnemoWorkflow>;
  skills: Map<string, MnemoSkill>;
  tasks: Map<string, MnemoTask>;
  events: Map<string, MnemoEvent>;
  reasonings: Map<string, MnemoReasoning>;
  hyperedges: Map<string, MnemoHyperedge>;
  compositionRules: Map<string, MnemoCompositionRule>;
  inferences: MnemoInferenceLogEntry[];
  factHashes: Map<string, MnemoFactHash>;
  factLsh: Map<string, LshBandValue[]>; // key: `${ws}:${factId}`
  embeddings: Map<string, number[]>;
  relations: Map<string, MnemoRelation>;
  // flatten-legacy-dual-core Phase 9 (task 9.1) — persisted `mnemo_health`
  // rows, keyed by workspaceId. `fresh: true` appends; `fresh: false` reads
  // the newest entry. Extraction jobs (`mnemo_extraction_job`) have no
  // in-memory model — `extractionJobsFailed7d`/`extractionJobsDeferred`
  // always report 0 here, same disclosed limitation as `getAuditFeed`'s
  // archive-source gap above.
  healthSnapshots: Map<string, HealthSnapshot[]>;
  // flatten-legacy-dual-core PR9e (design.md D6.5): read-only surface — no
  // `createCitation` port method exists yet (citation writes stay on the
  // legacy extraction pipeline for now), so `listCitations` always returns
  // an empty result set against this fake. A write path can populate this
  // collection once a follow-up PR adds one.
  citations: MnemoCitation[];
  // flatten-legacy-dual-core PR9g (design.md D6.5) — mirrors the physical
  // `public.mnemo_semantic_neighbor` table's composite PK
  // (workspaceId, sourceFactId, targetFactId). Populated by
  // `backfillSemanticNeighbors`, read (projected to entity pairs) by
  // `getGraphSnapshot`'s `includeSemantic` overlay below.
  semanticNeighbors: Map<
    string,
    { workspaceId: string; sourceFactId: string; targetFactId: string; cosine: number }
  >; // key: `${workspaceId}:${sourceFactId}:${targetFactId}`
  agentProfiles: Map<string, MnemoAgentProfile>; // key: `${ws}:${agentId}`
  workspaceModes: Map<
    string,
    {
      mode: "learning" | "production";
      sessionCount: number;
      promoteAt: number | null;
      startedAt: Date;
      factCount: number;
      entityCount: number;
    }
  >;

  // §9 L3 — query cache and embedding LRU stores. P59: mirrors the real
  // mnemo_query_cache table — insert-only, age-windowed on createdAt (which
  // stands in for last_used_at since writes never touch-on-hit), topK
  // matched exactly, workspace-shared only (design.md D13).
  queryCache: Array<{
    workspaceId: string;
    embedding: Float32Array;
    resultIds: string[];
    resultKinds: string[];
    topK: number;
    createdAt: number;
  }>;
  // key: `${ws}:${textHash}` — the model that produced the vector is part of
  // the entry, not the key, mirroring the real table's unique index.
  embeddingCache: Map<string, { embedding: Float32Array; model: string }>;

  // Append-only logs — tests can inspect these
  outbox: OutboxEntry[];
  auditLog: AuditLogEntry[];
  /**
   * P111 — `mnemo_review_item` rows. This used to be a no-op in the in-memory
   * adapter, so nothing a unit test could see recorded a review: the §33
   * contradiction path, the §34.7 abuse flag, self-reflect's knowledge gaps and
   * the Wave X anomaly flag all wrote into a discard. The test double had the
   * same one-half-of-a-mechanism shape as the production code it stands in for.
   */
  reviewItems: Array<{
    workspaceId: string;
    primitiveId: string;
    primitiveKind?: string;
    reason: string;
    detail?: Record<string, unknown>;
    createdAt: Date;
  }>;
  recallLog: Array<RecallLogEntry & { recalledAt?: Date }>;
  consolidationReviews: Array<{
    id: string;
    workspaceId: string;
    factId: string;
    reason: string;
    review: ReplayFailureReview;
  }>;
  // flatten-legacy-dual-core Slice 3c pt.1 (PR10) — active-learning review queue.
  activeLearningReviewQueue: ActiveLearningReviewRow[];

  // ── Webhooks ──────────────────────────────────────────────────────────────────
  webhookEndpoints: import("../../ports.js").MnemoWebhookEndpoint[];
  webhookDeliveries: import("../../ports.js").MnemoWebhookDelivery[];

  // ── Reminders (prospective memory) ────────────────────────────────────────────
  reminders: import("../../ports.js").MnemoReminder[];

  // ── Recall log (ACT-R activation — TASK-4001) ────────────────────────────────
  mnemoRecallLog: Array<{
    id: string;
    workspaceId: string;
    memoryId: string;
    recalledAt: string;
    recallScore: number;
  }>;
  harnessSessions: Map<string, InMemoryHarnessSession>;
  harnessTurns: InMemoryHarnessTurn[];
  harnessLedger: Map<string, InMemoryHarnessLedger>;
  harnessSequenceLedger: Map<string, string>;
  harnessLosses: Array<{
    sessionId: string;
    workspaceId: string;
    sourceMessageId: string;
    role: string;
    contentHash: string;
    eventId: string;
  }>;
  harnessRetractions: Array<{
    sessionId: string;
    workspaceId: string;
    sourceMessageId: string;
    predecessorSessionId: string | null;
    eventId: string;
  }>;
  harnessMessageChunks: Array<{
    workspaceId: string;
    sessionId: string;
    ingestionEventId: string;
    logicalSource: string;
    sourceGeneration: number;
    sourceMessageId: string;
    supersedesSourceMessageId?: string;
    role: "user" | "assistant";
    chunkIndex: number;
    chunkCount: number;
    chunkContentHash: string;
    messageContentHash: string;
    content: string;
  }>;
  harnessControls: Map<string, boolean>;
  managedOperations: Map<
    string,
    {
      workspaceId: string;
      sessionId: string;
      generation: number;
      result: import("../../harness.js").ManagedCollapseCommitResult;
    }
  >;
  managedProvenance: Array<{
    workspaceId: string;
    sessionId: string;
    operationId: string;
    primitiveKind: string;
    primitiveId: string;
    sourceMessageIds: string[];
    sensitivity: import("../../common.js").Sensitivity;
    [key: string]: unknown;
  }>;
  managedCollapseEffects: Array<{
    workspaceId: string;
    operationId: string;
    effectKind:
      | "lifecycle_event"
      | "metrics"
      | "redis_cleanup"
      | import("../../managed-collapse.js").ManagedPostCommitEffectKind;
    targetKind?: string;
    targetId?: string;
    payload?: Record<string, unknown>;
    sessionId: string;
    status: "pending" | "completed";
    attempts: number;
    nextAttemptAt: Date | null;
    completedAt: Date | null;
    lastError: string | null;
  }>;
}

export function createInMemoryStorageState(): InMemoryStorageState {
  return {
    sessions: new Map<string, MnemoSession>(),
    turns: [],
    facts: new Map<string, MnemoFact>(),
    decisions: new Map<string, MnemoDecision>(),
    episodes: new Map<string, MnemoEpisode>(),
    entities: new Map<string, MnemoEntity>(),
    strategies: new Map<string, MnemoStrategy>(),
    workflows: new Map<string, MnemoWorkflow>(),
    skills: new Map<string, MnemoSkill>(),
    tasks: new Map<string, MnemoTask>(),
    events: new Map<string, MnemoEvent>(),
    reasonings: new Map<string, MnemoReasoning>(),
    hyperedges: new Map<string, MnemoHyperedge>(),
    compositionRules: new Map<string, MnemoCompositionRule>(),
    inferences: [],
    factHashes: new Map<string, MnemoFactHash>(),
    factLsh: new Map<string, LshBandValue[]>(),
    embeddings: new Map<string, number[]>(),
    relations: new Map<string, MnemoRelation>(),
    healthSnapshots: new Map<string, HealthSnapshot[]>(),
    citations: [],
    semanticNeighbors: new Map<
      string,
      { workspaceId: string; sourceFactId: string; targetFactId: string; cosine: number }
    >(),
    agentProfiles: new Map<string, MnemoAgentProfile>(),
    workspaceModes: new Map(),
    queryCache: [],
    embeddingCache: new Map<string, { embedding: Float32Array; model: string }>(),
    outbox: [],
    auditLog: [],
    reviewItems: [],
    recallLog: [],
    consolidationReviews: [],
    activeLearningReviewQueue: [],
    webhookEndpoints: [],
    webhookDeliveries: [],
    reminders: [],
    mnemoRecallLog: [],
    harnessSessions: new Map(),
    harnessTurns: [],
    harnessLedger: new Map(),
    harnessSequenceLedger: new Map(),
    harnessLosses: [],
    harnessRetractions: [],
    harnessMessageChunks: [],
    harnessControls: new Map(),
    managedOperations: new Map(),
    managedProvenance: [],
    managedCollapseEffects: [],
  };
}

/** D3: clears exactly the 19 collections today's reset() clears — not all 35. */
export function resetInMemoryStorageState(state: InMemoryStorageState): void {
  state.sessions.clear();
  state.turns = [];
  state.facts.clear();
  state.decisions.clear();
  state.episodes.clear();
  state.entities.clear();
  state.strategies.clear();
  state.workflows.clear();
  state.skills.clear();
  state.tasks.clear();
  state.events.clear();
  state.reasonings.clear();
  state.relations.clear();
  state.citations = [];
  state.workspaceModes.clear();
  state.outbox = [];
  state.auditLog = [];
  state.recallLog = [];
  state.mnemoRecallLog = [];
  state.harnessSessions.clear();
  state.harnessTurns = [];
  state.harnessLedger.clear();
  state.harnessSequenceLedger.clear();
  state.harnessLosses = [];
  state.harnessRetractions = [];
  state.harnessMessageChunks = [];
  state.harnessControls.clear();
  state.managedOperations.clear();
  state.managedProvenance = [];
  state.managedCollapseEffects = [];
}
