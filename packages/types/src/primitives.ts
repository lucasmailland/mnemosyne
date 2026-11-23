import type { ActorType } from "./provenance.js";

/**
 * 10 Cognitive Primitive interfaces — DATA_MODEL.md §2.1–§2.10.
 *
 * Every primitive lives in a workspace (multi-tenant RLS), has bitemporal
 * time axes (validFrom/validTo = world truth; createdAt = system discovery),
 * and participates in the Hebbian relation graph via MnemoRelation.
 *
 * Decay classes (how `worth` decays over time without recall):
 *   Semantic (slow)   — fact, decision, strategy, workflow, skill, reasoning
 *   Episodic (medium) — episode, entity
 *   Working (fast)    — task (high priority items degrade if not acted on)
 *   Immutable         — event (no decay, no updatedAt — append-only)
 *
 * SQL GENERATED columns (worth, memory_strength) are computed by Postgres
 * triggers and are read-only on the TypeScript side.
 *
 * Quick reference — kind enums:
 *   MnemoFact.kind    (13): "preference"|"trait"|"event"|"relationship"|"skill"|"concern"|
 *                             "architecture"|"bugfix"|"config"|"discovery"|"policy"|"process"|"other"
 *   MnemoDecision.kind (8): "decision"|"architecture"|"policy"|"process"|"bugfix"|"learning"|"discovery"|"config"
 *   MnemoEntity.kind   (6): "person"|"organization"|"project"|"concept"|"place"|"other"
 */

// ─── §2.1 mnemo_fact ──────────────────────────────────────────────────────────

/**
 * A piece of durable behavioral knowledge about a user, agent, or domain.
 *
 * Use for: user preferences, beliefs, observed traits, relationship facts.
 * Do NOT use for: architectural decisions (→ MnemoDecision), sequential events
 * (→ MnemoEpisode), or named entities (→ MnemoEntity).
 *
 * Bitemporal: validFrom/validTo = when true in the world; createdAt = system discovery.
 * Forget by setting validTo = NOW() — rows are never deleted.
 * Sensitivity ceiling is enforced via SENSITIVITY_ORDER (never string comparison, MED-23).
 */
/**
 * Why an encrypted fact's text is not in a read (SECURITY.md §7):
 * `erased` — its actor's key was destroyed by crypto-erasure;
 * `unreadable` — no key ring is configured, or the key does not open it.
 */
export type FactRedaction = "erased" | "unreadable";

export interface MnemoFact {
  id: string;
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  /** The platform account (mnemo_user.id) behind this write, when one exists. */
  userId?: string | null;
  actorType?: ActorType;
  scope: "global" | "conversation";
  scopeRef?: string;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;

  statement: string;
  subject: string;
  kind:
    | "preference"
    | "trait"
    | "event"
    | "relationship"
    | "skill"
    | "concern"
    | "architecture"
    | "bugfix"
    | "config"
    | "discovery"
    | "policy"
    | "process"
    | "other";

  confidence: number;
  relevance: number;
  hitCount: number;
  lastRecalledAt?: Date;

  worthSuccess: number;
  worthFailure: number;
  worthAlpha: number;
  worthBeta: number;
  worth: number; // GENERATED — read-only

  memoryType: "semantic" | "episodic" | "procedural" | "working";
  memoryStrength: number;
  memoryStability: number;
  lastStrengthUpdate?: Date;

  attribution: "user_stated" | "user_belief" | "objective_fact" | "inferred";
  attributedTo?: "user" | "assistant" | "system";
  sourceMessageIds: string[];
  /**
   * Other memory primitive ids (facts/decisions/episodes/entities) this fact
   * references. Physical `linked_memory_ids` column — `NOT NULL DEFAULT '{}'`
   * (flatten-legacy-dual-core PR9a / D6.2). Non-optional to match the DB
   * default and the `MemoryFactSchemaForList` wire contract that requires it.
   */
  linkedMemoryIds: string[];

  /**
   * Correlation id for the session that produced this fact. **Not authoritative
   * and deliberately un-FK'd**: it arrives from `POST /remember`'s body and
   * nothing validates it against `mnemo_session`, so an FK would turn a stale
   * or invented id into a constraint error and lose the write — the exact
   * failure class P74 removed. Use {@link MnemoFact.episodeId} to answer "what
   * context did this come from". See DATA_MODEL.md §4.9.
   */
  sessionId?: string;
  extractionSource?: string;
  topicKey?: string;
  revisionCount: number;
  protocolVersion: string;

  entityId?: string;
  /**
   * **The canonical fact→context link.** FK to `mnemo_episode` (ON DELETE SET
   * NULL), written by the collapse through `linkSessionFactsToEpisode`, and the
   * one field `preferSourceEpisode` (spec §17) reads on every cold recall.
   *
   * Of the four ways this schema can express "this came from that session",
   * this is the only one with referential integrity. See DATA_MODEL.md §4.9 for
   * the other three and why they cannot be tightened.
   */
  episodeId?: string;

  status: "active" | "merged" | "forgotten";
  pinned: boolean;
  /** §11 governance: worth>0.8 ∧ confLower>0.7 → exempt from consolidation merging (MEMORY_MODEL line 1045). */
  canonical: boolean;
  /** Per-fact sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  /**
   * Set only when the row's encrypted `statement`/`subject` could not be
   * opened on read; both then hold a placeholder (`[erased]`, `[unreadable]`)
   * instead of ciphertext. See {@link FactRedaction}.
   */
  redacted?: FactRedaction;
  mergedIntoId?: string;

  validFrom: Date;
  validTo?: Date;

  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;

  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.2 mnemo_decision ──────────────────────────────────────────────────────

/**
 * A logged architectural or policy decision with full rationale.
 *
 * Use for: design choices, technical policies, process decisions, ADRs.
 * Do NOT use for: behavioral preferences (→ MnemoFact) or task tracking (→ MnemoTask).
 *
 * Decisions have a `status` lifecycle: active → superseded (when a newer decision
 * replaces it, supersededById links to the replacement).
 * Decay: slow semantic decay. Architectural decisions remain relevant long-term.
 */
export interface MnemoDecision {
  id: string;
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  conversationId?: string;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;
  /** Project/entity scope reference (e.g. 'project-x'). Mirrors mnemo_fact.scope_ref. */
  scopeRef?: string;

  kind:
    | "decision"
    | "architecture"
    | "policy"
    | "process"
    | "bugfix"
    | "learning"
    | "discovery"
    | "config";
  title: string;
  body: string;

  topicKey?: string;
  revisionCount: number;
  normalizedHash: string;

  status: "active" | "superseded" | "withdrawn";
  supersededById?: string;

  decidedByUserId?: string;
  confidence?: number;
  /** Per-decision sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;

  validFrom: Date;
  validTo?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.3 mnemo_episode ───────────────────────────────────────────────────────

/**
 * An episodic memory — a bounded narrative record of a session or event.
 *
 * Use for: conversation summaries, meeting records, project milestones.
 * Do NOT use for: individual facts extracted from a session (→ MnemoFact).
 *
 * Episodes can be hierarchical (parentEpisodeId). Root episodes (isRoot=true, parentEpisodeId=null)
 * represent top-level events. Delta episodes store only what changed relative to parent.
 * Session collapse (collapseSession in core) creates episodes from conversation turns.
 */
export interface MnemoEpisode {
  id: string;
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;

  title: string;
  narrative: string;
  occurredAt: Date;
  durationMinutes?: number;
  participants: string[];
  topics: string[];
  linkedFactIds: string[];

  parentEpisodeId?: string; // NULL = root
  deltaContent?: string;
  isRoot: boolean;
  depth: number;

  isSynthetic: boolean;
  /**
   * Correlation id for the conversation/session this episode summarises. **Not
   * authoritative and deliberately un-FK'd**: besides the collapse,
   * `@mnemo-ai/cup` writes v2 `session_id` values here during the v2→v3
   * migration, and those have no row in `mnemo_session` — an FK would break the
   * migration. See DATA_MODEL.md §4.9.
   */
  sourceConversationId?: string;
  /** Per-episode sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  // P18 — bitemporal validity interval. validFrom = when this episode became valid;
  // validTo = null means currently valid; archive sets validTo = now().
  validFrom: Date;
  validTo?: Date;

  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.4 mnemo_entity ────────────────────────────────────────────────────────

/**
 * A named real-world entity that facts and episodes can reference.
 *
 * Use for: persons, organizations, projects, concepts, places.
 * Do NOT use for: facts about the entity (→ MnemoFact with entityId pointer) or
 * the entity's decisions (→ MnemoDecision).
 *
 * Canonical deduplication: canonicalId = null means this row IS canonical.
 * Aliases grow automatically as different name forms are observed (mentionCount, lastSeenAt).
 */
export interface MnemoEntity {
  id: string;
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  /** Who WROTE this row (provenance) — the platform account, when one exists. */
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;

  name: string;
  kind: "person" | "organization" | "project" | "concept" | "place" | "other";
  aliases: string[];
  canonicalId?: string; // NULL = this row is canonical
  description?: string;
  /**
   * Who this row is ABOUT (subject), not who wrote it — deliberately a
   * different field from `userId` above. Only ever set via the dedicated
   * POST /entities/:id/link-user route (admin-or-self, workspace-membership
   * checked); never accepted on create/update, so an LLM cannot claim an
   * identity by supplying this field. Only valid when kind === "person".
   */
  linkedUserId?: string | null;

  firstSeenAt: Date;
  lastSeenAt: Date;
  mentionCount: number;
  /** Per-entity sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  // P18 — bitemporal validity interval. validFrom = when this entity became valid;
  // validTo = null means currently valid; archive sets validTo = now().
  validFrom: Date;
  validTo?: Date;

  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.5 mnemo_strategy ──────────────────────────────────────────────────────

/**
 * A trigger→action heuristic that the agent applies recurrently.
 *
 * Use for: "when X happens, do Y" patterns learned from experience or policy.
 * Do NOT use for: one-off decisions (→ MnemoDecision) or task instructions (→ MnemoTask).
 *
 * worth is GENERATED from successCount/failureCount (Beta distribution mean). Strategies with
 * high worth float to the top of recall results. Low-worth strategies decay toward archival.
 */
export interface MnemoStrategy {
  id: string;
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;
  /** Project/entity scope reference (e.g. 'project-x'). Mirrors mnemo_fact.scope_ref. */
  scopeRef?: string;

  trigger: string;
  action: string;
  context?: string;

  relatedFacts: string[];
  memoryType: "procedural";
  attribution: "user_stated" | "user_belief" | "objective_fact" | "inferred";

  successCount: number;
  failureCount: number;
  worth: number; // GENERATED — read-only

  supersedesId?: string;
  status: "active" | "superseded" | "archived";
  /** Per-strategy sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;

  validFrom: Date;
  validTo?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.6 mnemo_workflow ──────────────────────────────────────────────────────

/**
 * A reusable multi-step process template with ordered steps, conditions, and timing.
 *
 * Use for: standard operating procedures, repeatable agent workflows, checklists.
 * Do NOT use for: one-off task plans (→ MnemoTask) or general heuristics (→ MnemoStrategy).
 *
 * Versioned: previousVersionId links to the superseded version. executionCount and
 * successRate track runtime performance to inform worth decay.
 */

export interface WorkflowStep {
  order: number;
  action: string;
  condition?: string;
  expectedDurationMs: number;
  tools?: string[];
}

export interface MnemoWorkflow {
  id: string;
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;
  /** Project/entity scope reference (e.g. 'project-x'). Mirrors mnemo_fact.scope_ref. */
  scopeRef?: string;

  name: string;
  description?: string;
  steps: WorkflowStep[];

  avgDurationMs: number;
  successRate: number;
  worth: number;
  executionCount: number;
  lastExecutedAt?: Date;

  version: number;
  previousVersionId?: string;
  status: "active" | "deprecated" | "draft";
  /** Per-workflow sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  // P18 — bitemporal validity interval. validFrom = when this workflow became valid;
  // validTo = null means currently valid; archive sets validTo = now().
  validFrom: Date;
  validTo?: Date;

  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.7 mnemo_skill ─────────────────────────────────────────────────────────

/**
 * A stored prompt template for a repeatable task.
 *
 * Use for: prompt engineering building blocks, reusable generation patterns.
 * Do NOT use for: process templates with conditional steps (→ MnemoWorkflow) or
 * trigger→action heuristics (→ MnemoStrategy).
 *
 * qualityScore tracks runtime effectiveness; usageCount drives worth.
 * Embeddings allow semantic retrieval ("find a skill for writing SQL from natural language").
 */
export interface MnemoSkill {
  id: string;
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;

  name: string;
  promptTemplate: string;
  variables: string[];
  requiredContext: string[];

  qualityScore: number;
  worth: number;
  usageCount: number;
  lastUsedAt?: Date;
  /** Per-skill sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;

  // P18 — bitemporal validity interval. validFrom = when this skill became valid;
  // validTo = null means currently valid; archive sets validTo = now().
  validFrom: Date;
  validTo?: Date;

  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.8 mnemo_task ──────────────────────────────────────────────────────────

/**
 * A tracked action item with a full lifecycle and delegation chain.
 *
 * Use for: work items, reminders, delegated actions, subtasks with blocking chains.
 * Do NOT use for: general heuristics (→ MnemoStrategy) or process templates (→ MnemoWorkflow).
 *
 * blockedBy and subtaskIds form a DAG. parentTaskId enables hierarchical decomposition.
 * Decay: fast (working memory class) — high-priority tasks that are not acted on lose worth.
 */
export interface MnemoTask {
  id: string;
  workspaceId: string;
  actorId?: string;
  agentId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;

  title: string;
  description?: string;
  status: "pending" | "in_progress" | "blocked" | "delegated" | "completed" | "cancelled";
  priority: "critical" | "high" | "medium" | "low";

  assignedTo: string;
  delegatedBy?: string;
  delegatedAt?: Date;

  blockedBy: string[];
  subtaskIds: string[];
  parentTaskId?: string;

  relatedFacts: string[];
  relatedEntities: string[];
  sessionId?: string;

  outcome?: string;
  lessonsLearned?: string;
  /** Per-task sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  startedAt?: Date;
  completedAt?: Date;
  dueAt?: Date;

  // P18 — bitemporal validity interval. validFrom = when this task became valid;
  // validTo = null means currently valid; archiveTask always sets validTo=now(),
  // and sets status='cancelled' only when the task is not already terminal
  // (completed/cancelled) — see TERMINAL_TASK_STATUSES (ports.ts).
  validFrom: Date;
  validTo?: Date;

  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.9 mnemo_event ─────────────────────────────────────────────────────────

/**
 * An immutable record of something that happened. Events are append-only.
 *
 * Use for: system events, external webhooks, calendar events, audit trail entries.
 * Do NOT use for: mutable state (→ MnemoFact) or sequential narratives (→ MnemoEpisode).
 *
 * IMPORTANT: Events have no `updatedAt`. Once written, an event row never changes.
 * Annotations are appended via the annotations array (JSONB), not by editing the row.
 * Decay: IMMUTABLE — events do not decay. They accumulate forever (partitioned by occurredAt).
 */

export interface EventAnnotation {
  author: string;
  content: string;
  at: Date;
}

export interface MnemoEvent {
  id: string;
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;

  type: "system" | "external" | "user" | "agent" | "scheduled";
  name: string;
  description: string;
  occurredAt: Date;
  durationS?: number;

  source: string;
  relatedEntities: string[];
  annotations: EventAnnotation[];
  /** Per-event sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23).
   *  Raise-only: once set, can only be elevated, never lowered (append-only principle). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  // Events are immutable — no updatedAt
  createdAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.10 mnemo_reasoning ────────────────────────────────────────────────────

/**
 * A stored chain-of-thought — a question, its reasoning steps, and the conclusion reached.
 *
 * Use for: caching successful reasoning patterns, building a "how I solved X" library.
 * Do NOT use for: final answers/facts (→ MnemoFact) or process steps (→ MnemoWorkflow).
 *
 * worth is GENERATED and decays with disuse — the system prioritises reasoning that
 * has been recalled and applied multiple times. Embeddings are on the `question` field
 * to enable semantic retrieval of "find how I reasoned about problems like this".
 *
 * `status` remains the retrieval gate (searchReasoning filters on
 * `status IN ('active','golden')`) — `validTo` is the audit axis only, not a
 * read predicate. Do not swap the two.
 */

export interface ReasoningStep {
  step: number;
  reasoning: string;
  conclusion?: string;
}

export interface MnemoReasoning {
  id: string;
  workspaceId: string;
  agentId?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: ActorType;
  /** Multi-tenant ownership: "workspace:<id>" | "user:<id>" | "tenant:<id>" */
  scopeOwner?: string;

  question: string;
  chain: ReasoningStep[];
  conclusion: string;

  successCount: number;
  failureCount: number;
  worth: number; // GENERATED — read-only

  topicKey?: string;
  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;

  status: "active" | "archived" | "pruned" | "quarantined" | "golden";
  lastUsedAt?: Date;
  usageCount: number;
  /** Per-reasoning sensitivity ceiling — compared via SENSITIVITY_ORDER, never string equality (MED-23). */
  sensitivity: "public" | "internal" | "confidential" | "restricted";

  // P64 — bitemporal validity interval. validFrom = when this reasoning became valid;
  // validTo = null means currently valid; archiveReasoning sets validTo = now().
  validFrom: Date;
  validTo?: Date;

  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ─── §2.11 mnemo_hyperedge ──────────────────────────────────────────────────

/**
 * An n-ary relation connecting 3 or more memory primitives.
 *
 * Use for: groups of memories that co-activate together under a shared context.
 * Do NOT use for: binary relations between two primitives (→ MnemoRelation via memory_relate).
 *
 * Hebbian: activationCount bumps each time any member is recalled together with the others
 * (bumpHyperedgeActivation, driven by hyperedge_bump events in the OutboxWorker) — it only
 * increments activation_count, never touches worth.
 * worth is a plain `real` column, default 0.5 at creation — NOT a Beta-Bernoulli posterior
 * (no alpha/beta or success/failure counters here). StorageAdapter.updateWorth() does have a
 * "hyperedge" case (±0.1 TD(λ)-style step, clamped to [0,1]) implemented identically in both
 * DrizzleStorageAdapter/RecallRepository and InMemoryStorageAdapter, but nothing in the
 * current call graph ever invokes updateWorth with kind "hyperedge": memory_self_edit's
 * strengthen/weaken only targets fact/strategy, and PATCH /hyperedges/:id only accepts
 * label/description/contextQuery, not worth. So in practice worth stays frozen at its
 * creation-time value unless a future caller wires up that update path.
 * Bitemporal: validFrom/validTo = membership window; createdAt = discovery time.
 * NOTE: No metadata column on the underlying table. No contextEmbeddingModel column.
 */
export interface MnemoHyperedge {
  id: string;
  workspaceId: string;
  memberIds: string[];
  label?: string;
  description?: string;
  contextQuery?: string;
  contextEmbedding?: Float32Array;
  activationCount: number;
  worth: number;
  validFrom: Date;
  validTo?: Date;
  createdAt: Date;
  actorId?: string;
  /** The platform account (mnemo_user.id) behind this write, when one exists. */
  userId?: string | null;
  actorType?: ActorType;
}

// ─── §32 Compositionality ──────────────────────────────────────────────────

export interface MnemoCompositionRule {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  conditionDsl: unknown;
  actionDsl: unknown;
  priority: number;
  isActive: boolean;
  executionCount: number;
  createdBy?: string;
  source: "manual" | "mined" | "imported";
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface MnemoInferenceLogEntry {
  id: string;
  workspaceId: string;
  ruleId: string;
  inputFactIds: string[];
  derivedKind?: string;
  derivedId?: string;
  confidence: number;
  rationale?: string;
  triggeredByQuery?: string;
  conversationId?: string;
  createdAt: Date;
}

export interface MnemoFactHash {
  workspaceId: string;
  statementHash: string;
  factId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
}

// ─── §31 Meta-cognition view rows ──────────────────────────────────────────

export interface ConfidenceMapRow {
  workspaceId: string;
  // Entity-keyed (spec §31, migration 0020).
  entityId: string;
  canonicalName: string;
  kind: string;
  factCount: number;
  avgConfidence: number;
  coverageLevel: "expert" | "familiar" | "aware" | "minimal" | "blind";
  freshness: "current" | "recent" | "aging" | "stale";
  // Back-compat / aggregate fields (topicKey aliases canonicalName).
  topicKey: string;
  memoryCount: number;
  avgWorth: number;
  evidenceVolume: number;
  distinctAttributions: number;
  pinnedCount: number;
  lowStrengthCount: number;
  lastUpdatedAt: Date;
}

export interface KnowledgeGapRow {
  workspaceId: string;
  topicKey: string;
  avgWorth: number;
  evidenceVolume: number;
  memoryCount: number;
  recallHits30d: number;
  gapScore: number;
}

export interface TrendPair {
  current: number;
  previous: number;
  delta: number;
}

export interface MetacognitionTrends {
  recallHitRate: TrendPair;
  /** PROXY: AVG(activation_score) — mnemo_recall_log has no latency column. */
  avgRecallLatency: TrendPair;
  sessionCollapseQuality: TrendPair;
  strategySuccessRate: TrendPair;
}

// ─── Anticipation view rows (ALGORITHMS.md §8) ──────────────────────────────

export interface SequentialPatternRow {
  workspaceId: string;
  predecessorId: string;
  successorId: string;
  support: number;
  avgLagSeconds: number;
  confidence: number;
}

export interface PeriodicPatternRow {
  workspaceId: string;
  memoryId: string; // alias for fact_id in the MV
  dayOfWeek: number;
  hourBucket: number;
  slotRecalls: number;
  distinctWeeks: number;
  slotShare: number;
}

export interface ConditionalPatternRow {
  workspaceId: string;
  queryKey: string;
  factId: string;
  coReturns: number;
  queryTotal: number;
  confidence: number;
}

export interface CoOccurrencePatternRow {
  workspaceId: string;
  sourceId: string;
  partnerId: string;
  coRecallCount: number;
  hebbianWeight: number;
}

// ─── Union: any cognitive primitive ───────────────────────────────────────────

export type CognitivePrimitive =
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

export type PrimitiveKind =
  | "fact"
  | "decision"
  | "episode"
  | "entity"
  | "strategy"
  | "workflow"
  | "skill"
  | "task"
  | "event"
  | "reasoning"
  | "hyperedge";

/** Runtime companion to {@link PrimitiveKind} — validate untyped API input against this. */
export const PRIMITIVE_KINDS: readonly PrimitiveKind[] = [
  "fact",
  "decision",
  "episode",
  "entity",
  "strategy",
  "workflow",
  "skill",
  "task",
  "event",
  "reasoning",
  "hyperedge",
];

/**
 * Per-{@link PrimitiveKind} subtype enums (the `subtype` field on
 * RememberRequest). Only "fact", "decision", and "entity" have a real
 * subtype taxonomy today — the rest have no subtype concept and `subtype`
 * is ignored for them.
 */
export const PRIMITIVE_SUBTYPES = {
  // Q-3: architecture … process are the categories agents file facts under
  // (the decision vocabulary). Not "decision" itself: a fact whose kind names
  // another primitive is hydrated as that primitive by recall.
  fact: [
    "preference",
    "trait",
    "event",
    "relationship",
    "skill",
    "concern",
    "architecture",
    "bugfix",
    "config",
    "discovery",
    "policy",
    "process",
    "other",
  ],
  decision: [
    "decision",
    "architecture",
    "policy",
    "process",
    "bugfix",
    "learning",
    "discovery",
    "config",
  ],
  entity: ["person", "organization", "project", "concept", "place", "other"],
} as const satisfies Partial<Record<PrimitiveKind, readonly string[]>>;

// ─── §2.13 mnemo_agent_profile (Wave M2 — spec §13 self-editing memory) ─────

/**
 * Per-agent self-model / profile store.
 * Populated and rewritten by the reflection cycle (runReflectionCycle).
 * One row per (workspace_id, agent_id) — upserted on every reflection pass.
 */
export interface MnemoAgentProfile {
  workspaceId: string;
  agentId: string;
  /** Free-text summary generated by the last reflection cycle. */
  summary: string;
  /**
   * Flexible metadata bag.
   * Reserved keys: sessionsSinceReflection (number), lastReflectionAt (ISO string).
   */
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
