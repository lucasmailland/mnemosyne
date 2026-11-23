# Mnemosyne v3 — Data Model Specification

> **Status:** Implemented — all 10 primitives exist in @mnemo-ai/types; see packages/types/src/primitives.ts — verified 2026-06-13

> Version: 3.0.0 | Status: Design | Updated: 2026-06-09

---

## 1. Overview

### Cognitive Primitives (10 types)

| #   | Table             | Category    | Decay Class             | Half-Life | Recallable | Relationships                         |
| --- | ----------------- | ----------- | ----------------------- | --------- | ---------- | ------------------------------------- |
| 1   | `mnemo_fact`      | Declarative | semantic                | 58 days   | yes        | entity, episode, session, relations   |
| 2   | `mnemo_decision`  | Declarative | semantic                | 58 days   | yes        | entity, relations, supersedes chain   |
| 3   | `mnemo_episode`   | Episodic    | episodic                | 35 days   | yes        | facts, entity, delta-tree (parent)    |
| 4   | `mnemo_entity`    | Declarative | ∞ (no decay)            | —         | yes        | facts, decisions, aliases, canonical  |
| 5   | `mnemo_strategy`  | Procedural  | procedural              | 173 days  | yes        | facts, supersedes chain               |
| 6   | `mnemo_workflow`  | Procedural  | procedural              | 173 days  | yes        | tasks, entity                         |
| 7   | `mnemo_skill`     | Procedural  | procedural              | 173 days  | yes        | entity, facts (required context)      |
| 8   | `mnemo_task`      | Operational | lifecycle (no decay)    | —         | yes        | facts, entities, parent task, session |
| 9   | `mnemo_event`     | Episodic    | ∞ (immutable, no decay) | —         | yes        | entities, episode, annotations        |
| 10  | `mnemo_reasoning` | Procedural  | reasoning               | —         | yes        | facts, decisions, task                |

### Storage-Aware Decay (Pressure-Aware Activation)

In v3, memory decay is not just a function of time (Ebbinghaus), but also of **environmental pressure**.

- **Storage Pressure**: If `StorageAdapter.getFactCount()` exceeds the `Config.softLimit`, the `memory_stability` of all primitives is multiplied by a **Pressure Factor** (`0.5x` to `0.9x`).
- **Consequence**: In high-pressure environments, the agent "forgets" faster to prioritize high-worth information, maintaining a constant cognitive load.

### Relationship Infrastructure

```
mnemo_relation    — typed binary edges (9 locked verbs, hebbian weight)
mnemo_hyperedge   — n-ary associations (GIN-indexed member_ids array)
mnemo_citation    — provenance links (source → derived)
```

### Primitive Connection Diagram

```
                    ┌─────────────────────────────────────────────────────┐
                    │                   mnemo_entity                       │
                    │         (canonical things: person/org/project)       │
                    └──────┬──────────────────────────┬───────────────────┘
                           │ entity_id                │ entity_id
                    ┌──────▼──────┐            ┌──────▼──────┐
                    │ mnemo_fact  │◄────────────│mnemo_episode│
                    │(declarative)│  linked_    │  (episodic) │
                    └─────┬───┬──┘  fact_ids   └──────┬──────┘
                          │   │                        │ parent_episode_id
                          │   │                        ▼ (delta tree)
                          │   │               ┌────────────────┐
                          │   │               │  mnemo_episode │
                          │   │               │  (delta child) │
                          │   │               └────────────────┘
                          │   │
              ┌───────────┘   └────────────┐
              ▼                            ▼
    ┌──────────────────┐        ┌─────────────────┐
    │  mnemo_decision  │        │  mnemo_strategy │
    │ (policy/choice)  │        │("when X do Y")  │
    └────────┬─────────┘        └────────┬────────┘
             │superseded_by_id           │
             ▼                           │
    ┌──────────────────┐                 │
    │  mnemo_decision  │     ┌───────────┴────────────┐
    │  (supersedes)    │     │      mnemo_workflow     │
    └──────────────────┘     │   (multi-step recipe)  │
                             └───────────┬────────────┘
                                         │ spawns
                             ┌───────────▼────────────┐
                             │      mnemo_task         │
                             │  (state machine work)   │
                             └────────────────────────┘

    ┌──────────────────┐     ┌──────────────────┐     ┌────────────────────┐
    │    mnemo_skill   │     │   mnemo_event    │     │  mnemo_reasoning   │
    │ (prompt template)│     │(immutable occur.)│     │  (CoT cache)       │
    └──────────────────┘     └──────────────────┘     └────────────────────┘

    ─────── mnemo_relation ─── (binary edges, hebbian weight) ──────────────
    ─────── mnemo_hyperedge ── (n-ary, GIN-indexed member_ids array) ────────
    ─────── mnemo_citation ─── (provenance: source_id → derived_id) ─────────
```

---

## 2. Core Tables

### 2.1 mnemo_fact

```sql
CREATE TABLE mnemo_fact (
  -- Identity
  id                  TEXT        PRIMARY KEY,                          -- cuid2
  workspace_id        TEXT        NOT NULL,                             -- tenancy boundary (no FK — host owns)
  agent_id            TEXT,                                             -- agent that extracted this fact
  actor_id            TEXT,                                             -- namespaced credential ref (ActorRef) that wrote this row — NOT a userId, see "Provenance identity" in CLAUDE.md
  user_id             TEXT        REFERENCES mnemo_user(id) ON DELETE SET NULL, -- the platform account behind actor_id, when one exists
  actor_type          TEXT,                                             -- 'agent' | 'user' | 'system' | 'federation'
  scope               TEXT        NOT NULL CHECK (scope IN (
                        'global', 'conversation', 'employee', 'team'
                      )),                                               -- visibility scope
  scope_ref           TEXT,                                             -- e.g. conversation_id when scope='conversation'

  -- Content
  statement           TEXT        NOT NULL,                             -- the actual knowledge claim
  subject             TEXT        NOT NULL,                             -- entity/topic this fact is about
  kind                TEXT        NOT NULL CHECK (kind IN (
                        'preference', 'trait', 'event',
                        'relationship', 'skill', 'concern',
                        'architecture', 'bugfix', 'config',             -- 0048: the categories
                        'discovery', 'policy', 'process',               -- agents file facts under
                        'other'
                      )),                                               -- structural category

  -- Confidence & retrieval signals
  confidence          NUMERIC(6,4) NOT NULL DEFAULT 0.7,               -- [0,1] extraction confidence
  relevance           REAL        NOT NULL DEFAULT 1.0,                 -- [0,1] tunable retrieval weight
  hit_count           INTEGER     NOT NULL DEFAULT 0,                   -- recall event counter
  last_recalled_at    TIMESTAMPTZ,                                      -- most recent recall timestamp

  -- Memory Worth (RL-native governance, arXiv:2604.12007)
  worth_success       NUMERIC(10,4) NOT NULL DEFAULT 0,                -- times recalled AND outcome = good (fractional TD credits)
  worth_failure       NUMERIC(10,4) NOT NULL DEFAULT 0,                -- times recalled AND outcome = bad (fractional TD credits)
  worth_alpha         NUMERIC(8,4) NOT NULL DEFAULT 1.0,               -- Beta-Bernoulli α hyperparameter (prior successes)
  worth_beta          NUMERIC(8,4) NOT NULL DEFAULT 1.0,               -- Beta-Bernoulli β hyperparameter (prior failures)
  worth               NUMERIC(6,4) GENERATED ALWAYS AS (
                        CASE
                          WHEN worth_success + worth_failure = 0 THEN 0.5
                          ELSE worth_success / (worth_success + worth_failure)
                        END
                      ) STORED,                                         -- P(success|recalled) — Wilson CI on app side

  -- Cognitive memory model (Ebbinghaus/Hebbian)
  memory_type         TEXT        NOT NULL DEFAULT 'semantic'
                        CHECK (memory_type IN (
                          'semantic', 'episodic', 'procedural', 'working'
                        )),
  memory_strength     REAL        NOT NULL DEFAULT 1.0,                 -- [0,1] current activation (decays)
  memory_stability    REAL        NOT NULL DEFAULT 1.0,                 -- [0,∞] resistance to decay
  last_strength_update TIMESTAMPTZ,                                     -- last Hebbian potentiation update

  -- Attribution (theory-of-mind)
  attribution         TEXT        NOT NULL DEFAULT 'inferred'
                        CHECK (attribution IN (
                          'user_stated', 'user_belief', 'objective_fact', 'inferred'
                        )),
  attributed_to       TEXT        CHECK (attributed_to IN (
                        'user', 'assistant', 'system'
                      )),                                               -- speaker role that produced this
  source_message_ids  TEXT[]      NOT NULL DEFAULT '{}',                -- originating message IDs

  -- Provenance & versioning
  session_id          TEXT,                                             -- correlation only — NOT authoritative, no FK (see §Contexto de origen)
  extraction_source   TEXT,                                             -- 'conversation'|'document'|'cron'|etc.
  topic_key           TEXT,                                             -- stable upsert key (e.g. 'prefs/timezone')
  revision_count      INTEGER     NOT NULL DEFAULT 1,                   -- increment on upsert
  protocol_version    TEXT        NOT NULL DEFAULT 'v3.0',              -- Memory Protocol version

  -- Foreign keys to mnemo-owned tables
  entity_id           TEXT        REFERENCES mnemo_entity(id) ON DELETE SET NULL,
  episode_id          TEXT        REFERENCES mnemo_episode(id) ON DELETE SET NULL, -- CANONICAL fact→context link

  -- Lifecycle
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'merged', 'forgotten')),
  pinned              BOOLEAN     NOT NULL DEFAULT false,               -- pinned facts skip decay
  merged_into_id      TEXT,                                             -- consolidation target

  -- Validity window
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to            TIMESTAMPTZ,                                      -- NULL = currently valid

  -- Embedding
  embedding           halfvec(1536),                                    -- pgvector halfvec for HNSW
  embedding_model     TEXT,                                             -- model that produced embedding
  embedding_stale     BOOLEAN     NOT NULL DEFAULT false,               -- true after model upgrade

  -- Full-text search
  text_lemmatized     TSVECTOR,                                         -- tsvector for full-text (ts_rank_cd)

  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata            JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
// packages/types/src/primitives/fact.ts
export interface MnemoFact {
  id: string;
  workspaceId: string;
  agentId?: string;
  /** Namespaced credential ref (ActorRef), e.g. "key:<id>" — see "Provenance identity" in CLAUDE.md */
  actorId?: string;
  /** The platform account (mnemo_user.id) behind this write, when one exists. */
  userId?: string | null;
  actorType?: "agent" | "user" | "system" | "federation";
  scope: "global" | "conversation" | "employee" | "team";
  scopeRef?: string;
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
  worth: number; // GENERATED column — read-only
  memoryType: "semantic" | "episodic" | "procedural" | "working";
  memoryStrength: number;
  memoryStability: number;
  lastStrengthUpdate?: Date;
  attribution: "user_stated" | "user_belief" | "objective_fact" | "inferred";
  attributedTo?: "user" | "assistant" | "system";
  sourceMessageIds: string[];
  sessionId?: string;
  extractionSource?: string;
  topicKey?: string;
  revisionCount: number;
  protocolVersion: string;
  entityId?: string;
  episodeId?: string;
  status: "active" | "merged" | "forgotten";
  pinned: boolean;
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
```

---

### 2.2 mnemo_decision

```sql
CREATE TABLE mnemo_decision (
  id                  TEXT        PRIMARY KEY,
  workspace_id        TEXT        NOT NULL,
  agent_id            TEXT,
  conversation_id     TEXT,

  -- Content
  kind                TEXT        NOT NULL CHECK (kind IN (
                        'decision', 'architecture', 'policy', 'process',
                        'bugfix', 'learning', 'discovery', 'config'
                      )),
  title               TEXT        NOT NULL,
  body                TEXT        NOT NULL,                             -- full rationale text

  -- Deduplication & versioning
  topic_key           TEXT,                                             -- stable upsert key
  revision_count      INTEGER     NOT NULL DEFAULT 1,
  normalized_hash     TEXT        NOT NULL,                             -- SHA-256 of normalized body

  -- Supersession chain
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'superseded', 'withdrawn')),
  superseded_by_id    TEXT,                                             -- FK to newer decision

  -- Attribution
  decided_by_user_id  TEXT,
  confidence          REAL,

  -- Embedding
  embedding           halfvec(1536),
  embedding_model     TEXT,
  embedding_stale     BOOLEAN     NOT NULL DEFAULT false,
  text_lemmatized     TSVECTOR,

  -- Validity
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata            JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface MnemoDecision {
  id: string;
  workspaceId: string;
  agentId?: string;
  conversationId?: string;
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
  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;
  validFrom: Date;
  validTo?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.3 mnemo_episode

```sql
CREATE TABLE mnemo_episode (
  id                      TEXT        PRIMARY KEY,
  workspace_id            TEXT        NOT NULL,
  agent_id                TEXT,

  -- Content
  title                   TEXT        NOT NULL,
  narrative               TEXT        NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL,
  duration_minutes        INTEGER,
  participants            TEXT[]      NOT NULL DEFAULT '{}',            -- user or agent IDs (no FK)
  topics                  TEXT[]      NOT NULL DEFAULT '{}',            -- topical tags (GIN-indexed)

  -- Linked primitives (denormalised for hot-path reads)
  linked_fact_ids         TEXT[]      NOT NULL DEFAULT '{}',

  -- Delta-encoding tree (DELTAMEM, arXiv:2606.03083)
  parent_episode_id       TEXT        REFERENCES mnemo_episode(id),     -- NULL = root
  delta_content           TEXT,                                         -- what differs from parent
  is_root                 BOOLEAN     NOT NULL DEFAULT false,
  depth                   INTEGER     NOT NULL DEFAULT 0,               -- hops from root

  -- Classification
  is_synthetic            BOOLEAN     NOT NULL DEFAULT false,           -- auto-created by pipeline

  -- Source
  source_conversation_id  TEXT,                                          -- correlation only — no FK (see §Contexto de origen)

  -- Audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata                JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface MnemoEpisode {
  id: string;
  workspaceId: string;
  agentId?: string;
  title: string;
  narrative: string;
  occurredAt: Date;
  durationMinutes?: number;
  participants: string[];
  topics: string[];
  linkedFactIds: string[];
  parentEpisodeId?: string;
  deltaContent?: string;
  isRoot: boolean;
  depth: number;
  isSynthetic: boolean;
  sourceConversationId?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.4 mnemo_entity

```sql
CREATE TABLE mnemo_entity (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  kind            TEXT        NOT NULL CHECK (kind IN (
                    'person', 'organization', 'project', 'concept', 'place', 'other'
                  )),
  aliases         TEXT[]      NOT NULL DEFAULT '{}',                    -- alternate names (GIN-indexed)
  canonical_id    TEXT,                                                  -- NULL = this row is canonical
  description     TEXT,                                                  -- LLM-generated one-liner
  actor_id        TEXT,                                                  -- namespaced credential ref that wrote this row (provenance) — NOT a userId
  user_id         TEXT        REFERENCES mnemo_user(id) ON DELETE SET NULL, -- platform account behind actor_id, when one exists (provenance)
  actor_type      TEXT,                                                  -- 'agent' | 'user' | 'system' | 'federation'
  linked_user_id  TEXT        REFERENCES mnemo_user(id) ON DELETE SET NULL, -- the platform account this row is ABOUT (subject) — a different question from user_id above; only kind='person' rows may set this
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  mention_count   INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB       NOT NULL DEFAULT '{}',

  CONSTRAINT uq_entity_workspace_name_kind UNIQUE (workspace_id, name, kind),
  CONSTRAINT mnemo_entity_linked_user_is_person CHECK (linked_user_id IS NULL OR kind = 'person')
);
```

`user_id` and `linked_user_id` answer two different questions — see "Provenance
identity" in CLAUDE.md. `user_id` is provenance: who wrote this row. `linked_user_id`
is the subject: who this row is ABOUT. Only settable via `POST/DELETE
/entities/:id/link-user` (never `POST /entities` or `PATCH /entities/:id`).

```typescript
export interface MnemoEntity {
  id: string;
  workspaceId: string;
  name: string;
  kind: "person" | "organization" | "project" | "concept" | "place" | "other";
  aliases: string[];
  canonicalId?: string;
  description?: string;
  actorId?: string;
  userId?: string | null;
  actorType?: "agent" | "user" | "system" | "federation";
  /** The platform account this row is ABOUT. Distinct from userId (who wrote it). Only settable via link-user/unlink-user. */
  linkedUserId?: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  mentionCount: number;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.5 mnemo_strategy

```sql
CREATE TABLE mnemo_strategy (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  agent_id        TEXT,

  -- Content
  trigger         TEXT        NOT NULL,                                  -- "When a user reports a billing issue"
  action          TEXT        NOT NULL,                                  -- "Check Stripe dashboard first"
  context         TEXT,                                                  -- supporting rationale

  -- Worth (RL governance)
  success_count   INTEGER     NOT NULL DEFAULT 0,
  failure_count   INTEGER     NOT NULL DEFAULT 0,
  worth           REAL GENERATED ALWAYS AS (
                    CASE
                      WHEN success_count + failure_count = 0 THEN 0.5
                      ELSE success_count::REAL / (success_count + failure_count)
                    END
                  ) STORED,

  -- Supersession
  supersedes_id   TEXT,                                                  -- previous strategy this replaced
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'superseded', 'archived')),

  -- Embedding
  embedding       halfvec(1536),
  embedding_model TEXT,
  embedding_stale BOOLEAN     NOT NULL DEFAULT false,

  -- Validity
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface MnemoStrategy {
  id: string;
  workspaceId: string;
  agentId?: string;
  trigger: string;
  action: string;
  context?: string;
  successCount: number;
  failureCount: number;
  worth: number; // GENERATED
  supersedesId?: string;
  status: "active" | "superseded" | "archived";
  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;
  validFrom: Date;
  validTo?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.6 mnemo_workflow

```sql
CREATE TABLE mnemo_workflow (
  id                  TEXT        PRIMARY KEY,
  workspace_id        TEXT        NOT NULL,

  name                TEXT        NOT NULL,
  description         TEXT,
  steps               JSONB       NOT NULL DEFAULT '[]',                -- WorkflowStep[]

  -- Adaptive metrics (learned from executions)
  avg_duration_ms     INTEGER     NOT NULL DEFAULT 0,
  success_rate        REAL        NOT NULL DEFAULT 0.0,
  execution_count     INTEGER     NOT NULL DEFAULT 0,
  last_executed_at    TIMESTAMPTZ,

  -- Versioning
  version             INTEGER     NOT NULL DEFAULT 1,
  previous_version_id TEXT,

  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'deprecated', 'draft')),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata            JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface WorkflowStep {
  order: number;
  action: string;
  condition?: string; // "If X then skip to step N"
  expectedDurationMs: number;
  tools?: string[]; // MCP tools required
}

export interface MnemoWorkflow {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  avgDurationMs: number;
  successRate: number;
  executionCount: number;
  lastExecutedAt?: Date;
  version: number;
  previousVersionId?: string;
  status: "active" | "deprecated" | "draft";
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.7 mnemo_skill

```sql
CREATE TABLE mnemo_skill (
  id                TEXT        PRIMARY KEY,
  workspace_id      TEXT        NOT NULL,

  name              TEXT        NOT NULL,                                -- "code-review-typescript"
  prompt_template   TEXT        NOT NULL,                                -- Jinja/Mustache with {{variables}}
  variables         TEXT[]      NOT NULL DEFAULT '{}',                  -- variable names in template
  required_context  TEXT[]      NOT NULL DEFAULT '{}',                  -- memory types to recall first

  -- Quality
  quality_score     REAL        NOT NULL DEFAULT 0.5,                   -- from user feedback [0,1]
  usage_count       INTEGER     NOT NULL DEFAULT 0,
  last_used_at      TIMESTAMPTZ,

  -- Embedding (for skill retrieval)
  embedding         halfvec(1536),
  embedding_model   TEXT,
  embedding_stale   BOOLEAN     NOT NULL DEFAULT false,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface MnemoSkill {
  id: string;
  workspaceId: string;
  name: string;
  promptTemplate: string;
  variables: string[];
  requiredContext: string[];
  qualityScore: number;
  usageCount: number;
  lastUsedAt?: Date;
  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.8 mnemo_task

```sql
CREATE TABLE mnemo_task (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,

  -- Content
  title           TEXT        NOT NULL,
  description     TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending', 'in_progress', 'blocked',
                      'delegated', 'completed', 'cancelled'
                    )),
  priority        TEXT        NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('critical', 'high', 'medium', 'low')),

  -- Assignment
  assigned_to     TEXT        NOT NULL,                                  -- agentId
  delegated_by    TEXT,                                                  -- agentId that delegated
  delegated_at    TIMESTAMPTZ,

  -- Dependencies (self-referential, stored as arrays for simplicity)
  blocked_by      TEXT[]      NOT NULL DEFAULT '{}',                    -- task IDs blocking this
  subtask_ids     TEXT[]      NOT NULL DEFAULT '{}',                    -- child task IDs
  parent_task_id  TEXT,

  -- Context
  related_facts    TEXT[]      NOT NULL DEFAULT '{}',
  related_entities TEXT[]      NOT NULL DEFAULT '{}',
  session_id       TEXT,

  -- Outcome
  outcome          TEXT,
  lessons_learned  TEXT,                                                 -- auto-extracted → Strategy on complete

  -- Lifecycle
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  due_at          TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface MnemoTask {
  id: string;
  workspaceId: string;
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
  startedAt?: Date;
  completedAt?: Date;
  dueAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.9 mnemo_event

```sql
CREATE TABLE mnemo_event (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,

  type            TEXT        NOT NULL CHECK (type IN (
                    'system', 'external', 'user', 'agent', 'scheduled'
                  )),
  name            TEXT        NOT NULL,                                  -- "deploy.completed"
  description     TEXT        NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  duration_s      INTEGER,                                               -- span events (seconds)

  -- Context
  source          TEXT        NOT NULL,                                  -- "github"|"slack"|"agent:review-bot"
  related_entities TEXT[]     NOT NULL DEFAULT '{}',

  -- Immutable annotations (comments without mutation)
  annotations     JSONB       NOT NULL DEFAULT '[]',                    -- {author, content, at}[]

  -- Events are immutable: no updated_at, no status
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface EventAnnotation {
  author: string;
  content: string;
  at: Date;
}

export interface MnemoEvent {
  id: string;
  workspaceId: string;
  type: "system" | "external" | "user" | "agent" | "scheduled";
  name: string;
  description: string;
  occurredAt: Date;
  durationS?: number;
  source: string;
  relatedEntities: string[];
  annotations: EventAnnotation[];
  createdAt: Date;
  metadata: Record<string, unknown>;
}
```

---

### 2.10 mnemo_reasoning

```sql
CREATE TABLE mnemo_reasoning (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  agent_id        TEXT,

  -- Content
  question        TEXT        NOT NULL,                                  -- the problem/query
  chain           JSONB       NOT NULL DEFAULT '[]',                    -- CoT steps [{step, reasoning, conclusion}]
  conclusion      TEXT        NOT NULL,

  -- Quality tracking
  success_count   INTEGER     NOT NULL DEFAULT 0,
  failure_count   INTEGER     NOT NULL DEFAULT 0,
  worth           REAL GENERATED ALWAYS AS (
                    CASE
                      WHEN success_count + failure_count = 0 THEN 0.5
                      ELSE success_count::REAL / (success_count + failure_count)
                    END
                  ) STORED,

  -- Retrieval
  topic_key       TEXT,                                                  -- fast lookup key
  embedding       halfvec(1536),
  embedding_model TEXT,
  embedding_stale BOOLEAN     NOT NULL DEFAULT false,

  -- Lifecycle
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived', 'pruned')),
  last_used_at    TIMESTAMPTZ,
  usage_count     INTEGER     NOT NULL DEFAULT 0,

  -- Bitemporal validity interval (P64, migration 0030). status remains the
  -- retrieval gate (searchReasoning filters on active/golden); valid_to is
  -- the audit axis only, closed by archiveReasoning.
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to        TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB       NOT NULL DEFAULT '{}'
);
```

```typescript
export interface ReasoningStep {
  step: number;
  reasoning: string;
  conclusion?: string;
}

export interface MnemoReasoning {
  id: string;
  workspaceId: string;
  agentId?: string;
  question: string;
  chain: ReasoningStep[];
  conclusion: string;
  successCount: number;
  failureCount: number;
  worth: number; // GENERATED
  topicKey?: string;
  embedding?: Float32Array;
  embeddingModel?: string;
  embeddingStale: boolean;
  status: "active" | "archived" | "pruned" | "quarantined" | "golden";
  lastUsedAt?: Date;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

> **Note:** `quarantined` and `golden` statuses were added by migration 0025
> (`0025_reasoning_lifecycle.sql`). The baseline constraint only had
> `active | archived | pruned`.

---

### 2.11 Supporting Tables

These tables are referenced by algorithm SQL (retrieval cascade, collapse pipeline, temporal/spatial reasoning, contradiction resolution) but were absent from earlier drafts. All workspace-scoped tables carry RLS matching the pattern established in §2.1.

```sql
-- mnemo_recall_log: TD(λ) credit tracking — required by the retrieval cascade
CREATE TABLE mnemo_recall_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL,
  fact_id          UUID NOT NULL REFERENCES mnemo_fact(id) ON DELETE CASCADE,
  session_id       UUID REFERENCES mnemo_session(id) ON DELETE SET NULL,
  recalled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  query_text       TEXT,
  hit_rank         INT,
  td_credit        NUMERIC(8,6) DEFAULT 0,
  activation_score NUMERIC(6,4)
);
ALTER TABLE mnemo_recall_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_recall_log FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_recall_log_ws ON mnemo_recall_log
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_recall_log_fact    ON mnemo_recall_log(fact_id, recalled_at DESC);
CREATE INDEX idx_recall_log_session ON mnemo_recall_log(session_id) WHERE session_id IS NOT NULL;

-- mnemo_session_turn: individual turns within a session (needed by collapse pipeline)
CREATE TABLE mnemo_session_turn (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  session_id   UUID NOT NULL REFERENCES mnemo_session(id) ON DELETE CASCADE,
  turn_index   INT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content      TEXT NOT NULL,
  token_count  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mnemo_session_turn ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_session_turn FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_session_turn_ws ON mnemo_session_turn
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_session_turn_session ON mnemo_session_turn(session_id, turn_index);

-- mnemo_spatial_index: geographic / spatial retrieval anchors
CREATE TABLE mnemo_spatial_index (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL,
  fact_id       UUID NOT NULL REFERENCES mnemo_fact(id) ON DELETE CASCADE,
  location_name TEXT,
  latitude      NUMERIC(9,6),
  longitude     NUMERIC(9,6),
  radius_km     NUMERIC(8,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mnemo_spatial_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_spatial_index FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_spatial_index_ws ON mnemo_spatial_index
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_spatial_fact ON mnemo_spatial_index(fact_id);

-- mnemo_temporal_anchor: explicit time-scoped associations for temporal reasoning
CREATE TABLE mnemo_temporal_anchor (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  fact_id      UUID NOT NULL REFERENCES mnemo_fact(id) ON DELETE CASCADE,
  anchor_label TEXT NOT NULL,           -- e.g. "Q3 2025", "during project alpha"
  anchor_start TIMESTAMPTZ,
  anchor_end   TIMESTAMPTZ,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  recurrence   JSONB,                   -- null unless is_recurring; RFC5545 RRULE-like
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mnemo_temporal_anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_temporal_anchor FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_temporal_anchor_ws ON mnemo_temporal_anchor
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_temporal_fact  ON mnemo_temporal_anchor(fact_id);
CREATE INDEX idx_temporal_range ON mnemo_temporal_anchor(anchor_start, anchor_end);

-- mnemo_causal_chain: directed causal links between facts/decisions
CREATE TABLE mnemo_causal_chain (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  cause_id     UUID NOT NULL,           -- references any primitive by id
  cause_type   TEXT NOT NULL,           -- primitive kind: fact, decision, event, etc.
  effect_id    UUID NOT NULL,
  effect_type  TEXT NOT NULL,
  confidence   NUMERIC(6,4) NOT NULL DEFAULT 0.5,
  lag_seconds  INT,                     -- typical time between cause and effect
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mnemo_causal_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_causal_chain FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_causal_chain_ws ON mnemo_causal_chain
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_causal_cause  ON mnemo_causal_chain(cause_id, workspace_id);
CREATE INDEX idx_causal_effect ON mnemo_causal_chain(effect_id, workspace_id);

-- mnemo_analogy_map: structural similarity mappings for analogical reasoning
CREATE TABLE mnemo_analogy_map (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  source_id    UUID NOT NULL,
  source_type  TEXT NOT NULL,
  target_id    UUID NOT NULL,
  target_type  TEXT NOT NULL,
  similarity   NUMERIC(6,4) NOT NULL,   -- cosine similarity at time of mapping
  mapping_type TEXT NOT NULL CHECK (mapping_type IN ('structural', 'semantic', 'functional')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mnemo_analogy_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_analogy_map FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_analogy_map_ws ON mnemo_analogy_map
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_analogy_source ON mnemo_analogy_map(source_id, workspace_id);
CREATE UNIQUE INDEX idx_analogy_pair ON mnemo_analogy_map(workspace_id, source_id, target_id);

-- mnemo_salience_map: per-workspace topic salience scores for anticipatory prefetch
CREATE TABLE mnemo_salience_map (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  topic        TEXT NOT NULL,
  salience     NUMERIC(6,4) NOT NULL DEFAULT 0.5,
  decay_rate   NUMERIC(8,6) NOT NULL DEFAULT 0.1,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mnemo_salience_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_salience_map FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_salience_map_ws ON mnemo_salience_map
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE UNIQUE INDEX idx_salience_topic ON mnemo_salience_map(workspace_id, topic);

-- mnemo_prime_ctx: pre-fetched context injected at session start (anticipatory memory)
CREATE TABLE mnemo_prime_ctx (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  session_id   UUID NOT NULL REFERENCES mnemo_session(id) ON DELETE CASCADE,
  fact_id      UUID NOT NULL REFERENCES mnemo_fact(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('periodic', 'sequential', 'conditional', 'entity')),
  confidence   NUMERIC(6,4) NOT NULL,
  injected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mnemo_prime_ctx ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_prime_ctx FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_prime_ctx_ws ON mnemo_prime_ctx
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_prime_ctx_session ON mnemo_prime_ctx(session_id);

-- mnemo_contradiction_queue: facts flagged as contradictory pending resolution
CREATE TABLE mnemo_contradiction_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL,
  fact_a_id           UUID NOT NULL REFERENCES mnemo_fact(id) ON DELETE CASCADE,
  fact_b_id           UUID NOT NULL REFERENCES mnemo_fact(id) ON DELETE CASCADE,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contradiction_type  TEXT NOT NULL CHECK (contradiction_type IN ('direct', 'temporal', 'probabilistic')),
  confidence          NUMERIC(6,4) NOT NULL,   -- confidence that this IS a contradiction
  resolved_at         TIMESTAMPTZ,
  resolution          TEXT CHECK (resolution IN ('fact_a_wins', 'fact_b_wins', 'both_kept', 'both_archived', 'merged')),
  resolved_by         TEXT                     -- actor_id or 'auto'
);
ALTER TABLE mnemo_contradiction_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_contradiction_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_contradiction_queue_ws ON mnemo_contradiction_queue
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
CREATE INDEX idx_contradiction_unresolved ON mnemo_contradiction_queue(workspace_id, detected_at)
  WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX idx_contradiction_pair ON mnemo_contradiction_queue(workspace_id, fact_a_id, fact_b_id)
  WHERE resolved_at IS NULL;
```

---

### 2.12 Transactional Outbox

```sql
-- §2.12 Transactional Outbox
-- All non-PG side effects (vector upserts, cache busts, queue jobs, webhook calls)
-- are written to this table within the same PG transaction as the primary write.
-- An outbox worker fans out to other adapters with at-least-once semantics.
CREATE TABLE mnemo_outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN (
                 'vector_upsert', 'vector_delete',
                 'cache_bust', 'cache_set',
                 'queue_job', 'webhook_fire'
               )),
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at   TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT
);
-- Outbox is workspace-scoped but NOT RLS-gated (worker needs cross-workspace access).
-- Application role has INSERT only; worker role has full access.
CREATE INDEX idx_outbox_pending ON mnemo_outbox(created_at)
  WHERE processed_at IS NULL;
CREATE INDEX idx_outbox_workspace ON mnemo_outbox(workspace_id, created_at)
  WHERE processed_at IS NULL;
```

### 2.13 Deletion Log (Resurrection Guard)

`mnemo_deletion_log` is an append-only record of every hard-deleted item (GDPR erasure
or explicit user deletion). The federation layer checks this table before accepting any
incoming `SyncItem` — if the item ID is present here, it is rejected with
`RESURRECTION_BLOCKED`. This prevents a stale federated peer from re-introducing data
that was intentionally destroyed.

The application role has INSERT only on this table — no UPDATE, DELETE, or TRUNCATE.
This mirrors the audit log append-only contract.

```sql
-- §2.13 Deletion Log (Resurrection Guard)
-- Append-only ledger of all hard-deleted item IDs. Consulted before accepting any
-- federated item to prevent resurrection of GDPR-erased content.
CREATE TABLE mnemo_deletion_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL,
  deleted_item_id UUID NOT NULL,  -- UUID of the deleted primitive
  deleted_item_type TEXT NOT NULL, -- primitive kind
  deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deletion_type  TEXT NOT NULL CHECK (deletion_type IN ('soft', 'hard', 'gdpr_erasure', 'federation_tombstone')),
  actor_id       TEXT NOT NULL,
  reason         TEXT,
  item_created_at TIMESTAMPTZ     -- 0068: a deleted fact's creation time (federation tombstones)
);
-- NO RLS on this table — the resurrection guard must work cross-workspace.
-- Application role has INSERT only; never UPDATE or DELETE.
REVOKE UPDATE, DELETE, TRUNCATE ON mnemo_deletion_log FROM mnemo_app_role;
CREATE UNIQUE INDEX idx_deletion_log_item ON mnemo_deletion_log(workspace_id, deleted_item_id);
CREATE INDEX idx_deletion_log_workspace ON mnemo_deletion_log(workspace_id, deleted_at DESC);
```

---

## 3. Relationship Tables

### 3.1 mnemo_relation

Binary typed edges between any two primitives. The 9 verbs are locked — no new verbs without a schema migration.

```sql
CREATE TABLE mnemo_relation (
  id                      TEXT        PRIMARY KEY,
  workspace_id            TEXT        NOT NULL,

  -- Source node
  source_kind             TEXT        NOT NULL CHECK (source_kind IN (
                            'fact', 'decision', 'entity', 'episode',
                            'strategy', 'workflow', 'skill', 'task', 'event', 'reasoning'
                          )),
  source_id               TEXT        NOT NULL,

  -- Target node
  target_kind             TEXT        NOT NULL CHECK (target_kind IN (
                            'fact', 'decision', 'entity', 'episode',
                            'strategy', 'workflow', 'skill', 'task', 'event', 'reasoning'
                          )),
  target_id               TEXT        NOT NULL,

  -- Edge type (9 locked verbs)
  relation                TEXT        NOT NULL CHECK (relation IN (
                            'related',        -- generic association
                            'compatible',     -- A and B are consistent
                            'scoped',         -- A applies within scope of B
                            'conflicts_with', -- A and B are contradictory
                            'supersedes',     -- A replaces B
                            'not_conflict',   -- explicit non-conflict adjudication
                            'derived_from',   -- A was inferred/extracted from B
                            'part_of',        -- A is a component of B
                            'member_of'       -- A belongs to group B
                          )),

  -- Hebbian learning weights (co-recall potentiation)
  hebbian_weight          REAL        NOT NULL DEFAULT 1.0,             -- co-activation strength [0, ∞)
  co_recall_count         INTEGER     NOT NULL DEFAULT 0,               -- times recalled together
  directionality          REAL        NOT NULL DEFAULT 0.0,             -- STDP temporal asymmetry [-1,1]

  -- Judgment
  judgment_status         TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (judgment_status IN ('pending', 'judged', 'dismissed')),
  reason                  TEXT,
  evidence                JSONB,
  confidence              REAL,
  marked_by_user_id       TEXT,
  marked_by_kind          TEXT        NOT NULL DEFAULT 'system'
                            CHECK (marked_by_kind IN ('user', 'agent', 'system', 'llm_judge')),
  marked_by_model         TEXT,
  marked_by_prompt_version TEXT,

  -- Provenance
  provenance              TEXT,                                          -- 'hebbian'|'explicit'|'inferred'
  conversation_id         TEXT,
  superseded_by_relation_id TEXT,

  -- Validity
  valid_from              TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to                TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```typescript
export type PrimitiveKind =
  | "fact"
  | "decision"
  | "entity"
  | "episode"
  | "strategy"
  | "workflow"
  | "skill"
  | "task"
  | "event"
  | "reasoning";

export type RelationVerb =
  | "related"
  | "compatible"
  | "scoped"
  | "conflicts_with"
  | "supersedes"
  | "not_conflict"
  | "derived_from"
  | "part_of"
  | "member_of";

export interface MnemoRelation {
  id: string;
  workspaceId: string;
  sourceKind: PrimitiveKind;
  sourceId: string;
  targetKind: PrimitiveKind;
  targetId: string;
  relation: RelationVerb;
  hebbianWeight: number;
  coRecallCount: number;
  directionality: number;
  judgmentStatus: "pending" | "judged" | "dismissed";
  reason?: string;
  evidence?: Record<string, unknown>;
  confidence?: number;
  markedByUserId?: string;
  markedByKind: "user" | "agent" | "system" | "llm_judge";
  markedByModel?: string;
  markedByPromptVersion?: string;
  provenance?: string;
  conversationId?: string;
  supersededByRelationId?: string;
  validFrom: Date;
  validTo?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 3.2 mnemo_hyperedge

N-ary associations for jointly relevant sets of primitives. Requires at least 3 members.

```sql
CREATE TABLE mnemo_hyperedge (
  id                TEXT        PRIMARY KEY,
  workspace_id      TEXT        NOT NULL,

  -- Members (ordered list of primitive IDs from any table)
  member_ids        TEXT[]      NOT NULL,                                -- GIN-indexed, min 3

  -- Description
  label             TEXT,                                                -- "deployment-failure-scenario"
  description       TEXT,

  -- Retrieval context
  context_query     TEXT,                                                -- query that activates this edge
  context_embedding halfvec(1536),

  -- Strength
  activation_count  INTEGER     NOT NULL DEFAULT 0,
  worth             REAL        NOT NULL DEFAULT 0.5,

  -- Validity
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT min_members CHECK (array_length(member_ids, 1) >= 3)
);
```

---

### 3.3 mnemo_citation

Provenance tracking: which source memory produced a derived memory.

```sql
CREATE TABLE mnemo_citation (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,

  source_kind     TEXT        NOT NULL,                                  -- primitive kind
  source_id       TEXT        NOT NULL,
  derived_kind    TEXT        NOT NULL,
  derived_id      TEXT        NOT NULL,

  method          TEXT        NOT NULL DEFAULT 'extraction'
                    CHECK (method IN (
                      'extraction',    -- LLM extracted derived from source
                      'consolidation', -- merge of multiple sources
                      'inference',     -- logic/composition
                      'manual'         -- agent self-edit
                    )),
  credit_weight   NUMERIC(8,6) NOT NULL DEFAULT 1.0,                   -- TD(λ) eligibility weight (fractional, e.g. 0.85^3 ≈ 0.614)

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. Infrastructure Tables

### 4.1 mnemo_session

```sql
CREATE TABLE mnemo_session (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  agent_id        TEXT,
  user_id         TEXT,
  status          TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'collapsed', 'archived')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  collapsed_at    TIMESTAMPTZ,
  context_snapshot JSONB      NOT NULL DEFAULT '{}',                    -- working memory at collapse
  outcome_rating  TEXT        CHECK (outcome_rating IN ('success', 'failure', 'neutral')),
  fact_count      INTEGER     NOT NULL DEFAULT 0,
  metadata        JSONB       NOT NULL DEFAULT '{}'
);
```

### 4.2 mnemo_query_cache

The §9 L3 cosine≥0.95 query-result cache. This is the post-migration shape — the
one every real database has after `migrate()` — not the `0001` baseline dump;
`0009_unconstrained_halfvec.sql` and `0010_dimension_scoped_hnsw.sql` both alter
this table. See `docs/archive/openspec/p59-query-cache-l3-fix/design.md` for the repair that
made this table's SQL actually executable (it never had before; see that
change's proposal.md for the original breakage).

```sql
CREATE TABLE mnemo_query_cache (
  id                  TEXT         PRIMARY KEY,
  workspace_id        TEXT         NOT NULL,
  query_embedding     halfvec      NOT NULL,                             -- dimensionless, see note (1)
  result_memory_ids   TEXT[]       NOT NULL,                             -- cached primitive IDs
  result_memory_kinds TEXT[]       NOT NULL,
  scope               TEXT,                                              -- 'global' on every write (D9)
  scope_ref           TEXT,                                              -- always NULL on every write (D9)
  agent_id            TEXT,                                              -- always NULL on every write (D9)
  top_k               INTEGER      NOT NULL,                             -- requested result-set size, matched exactly on lookup
  hit_count           INTEGER      NOT NULL DEFAULT 1,
  last_used_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),               -- ≡ created_at; insert-only, see note (3)
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

Notes:

1. `query_embedding` is a **dimensionless** `halfvec` as of `0009` — there is no
   `(n)` constraint. A workspace that changes embedding model writes rows of a
   second dimension into the same table, so every reader MUST guard the distance
   operator with `public.vector_dims(query_embedding) = $dims` before comparing;
   otherwise `halfvec <=> halfvec` raises `different halfvec dimensions N and M`
   on mixed-dimension data.
2. The only indexes are the `id` primary key and `idx_mnemo_qc_ws (workspace_id,
last_used_at DESC)`. The HNSW index that once existed
   (`idx_mnemo_qc_embedding_hnsw`) was dropped by `0009` (it used
   `vector_cosine_ops`, incompatible with the `halfvec` target) and is
   **deliberately not restored** by `0010` — this table is cold-path/low-volume
   and intentionally served by a bounded sequential scan over
   `idx_mnemo_qc_ws`, not an ANN probe.
3. Writes are **insert-only** — there is no upsert, no de-duplication key, and
   no touch-on-hit update of `hit_count`/`last_used_at` on a read. `last_used_at`
   therefore equals `created_at` for every row today, which is what lets reads
   filter on `last_used_at` as a true age predicate (a 5-minute freshness
   window; only `replaceFact`'s workspace-wide bust invalidates rows early).
   There is currently no eviction job, so row count grows unbounded over time —
   an accepted, temporary tradeoff tracked as a fast-follow in
   `docs/archive/BACKLOG.md` (scheduled prune on `created_at`, a row-count
   metric/alert, and — if that fast-follow introduces touch-on-hit — moving
   this freshness predicate from `last_used_at` to `created_at` in the same
   commit).

### 4.3 mnemo_fact_archive

```sql
CREATE TABLE mnemo_fact_archive (
  LIKE mnemo_fact INCLUDING ALL,
  archived_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  archive_reason  TEXT        NOT NULL                                   -- 'decay'|'consolidation'|'manual'
);
```

### 4.4 mnemo_review_queue

```sql
CREATE TABLE mnemo_review_queue (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  primitive_kind  TEXT        NOT NULL,
  primitive_id    TEXT        NOT NULL,
  reason          TEXT        NOT NULL,                                  -- 'low_worth'|'contradiction'|'stale'
  priority        INTEGER     NOT NULL DEFAULT 5,                       -- 1=highest, 10=lowest
  reviewed_at     TIMESTAMPTZ,
  review_outcome  TEXT        CHECK (review_outcome IN ('keep', 'archive', 'merge', 'edit')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.5 mnemo_health

```sql
CREATE TABLE mnemo_health (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  check_name      TEXT        NOT NULL,                                  -- 'embedding_coverage'|'stale_rate'|etc.
  status          TEXT        NOT NULL CHECK (status IN ('ok', 'warn', 'critical')),
  value           REAL,
  message         TEXT,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.6 mnemo_api_keys

```sql
CREATE TABLE mnemo_api_keys (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  key_hash        TEXT        NOT NULL UNIQUE,                          -- bcrypt of raw key
  name            TEXT        NOT NULL,
  scopes          TEXT[]      NOT NULL DEFAULT '{}',
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
```

### 4.7 mnemo_access_policy

```sql
CREATE TABLE mnemo_access_policy (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  agent_id        TEXT        NOT NULL,
  resource        TEXT        NOT NULL,                                  -- 'fact'|'decision'|'*'
  action          TEXT        NOT NULL,                                  -- 'read'|'write'|'delete'|'*'
  effect          TEXT        NOT NULL DEFAULT 'allow'
                    CHECK (effect IN ('allow', 'deny')),
  conditions      JSONB       NOT NULL DEFAULT '{}',                    -- e.g. {scope: 'global'}
  priority        INTEGER     NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.8 mnemo_audit_log

Append-only Merkle-chained audit trail. Partitioned by month for retention management. Full definition in `SECURITY_ARCHITECTURE.md §6.1`; this section documents the column contract for migration tooling.

```sql
CREATE TABLE mnemo_audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID         NOT NULL,
  actor_type   TEXT         NOT NULL CHECK (actor_type IN ('agent','user','system','federation')),
  actor_id     TEXT         NOT NULL,
  action       TEXT         NOT NULL CHECK (action IN (
                               'recall','create','update','delete','hard_delete',
                               'export','self_edit','session_open','session_close',
                               'key_create','key_rotate','key_revoke',
                               'admin_access','federation_sync',
                               'erasure_initiated','erasure_complete',
                               'federation_cert_pin_mismatch','federation_cert_rotated',
                               'plugin_installed','plugin_removed',
                               'workspace_created','workspace_deleted',
                               'rls_policy_changed','mfa_verified','ip_denied'
                             )),
  resource     TEXT         NOT NULL,
  resource_id  TEXT,
  metadata     JSONB,
  ip_address   INET,
  user_agent   TEXT,
  trace_id     TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  merkle_hash  BYTEA,                  -- NULL only for terminal erasure entries (is_terminal = true)
  is_terminal  BOOLEAN      NOT NULL DEFAULT false,

  CONSTRAINT audit_merkle_integrity CHECK (
    (is_terminal = false AND merkle_hash IS NOT NULL) OR
    (is_terminal = true  AND merkle_hash IS NULL)
  )
) PARTITION BY RANGE (created_at);

-- Append-only: trigger raises EXCEPTION on any UPDATE or DELETE attempt.
-- Application role is granted INSERT only (no UPDATE/DELETE/TRUNCATE).
-- See SECURITY_ARCHITECTURE.md §6.1 for full trigger definition.
```

### 4.9 mnemo_prompt_version

```sql
CREATE TABLE mnemo_prompt_version (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  prompt_key      TEXT        NOT NULL,                                  -- 'extraction'|'consolidation'|etc.
  version         INTEGER     NOT NULL,
  content         TEXT        NOT NULL,
  performance_score REAL,                                                -- from A/B testing
  is_active       BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_prompt_version UNIQUE (workspace_id, prompt_key, version)
);
```

### 4.10 mnemo_plugin_state

```sql
CREATE TABLE mnemo_plugin_state (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  plugin_id       TEXT        NOT NULL,
  cursor          TEXT,                                                  -- sync cursor/offset
  last_synced_at  TIMESTAMPTZ,
  error_count     INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT,
  state           JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_plugin_state UNIQUE (workspace_id, plugin_id)
);
```

### 4.11 mnemo_composition_rule

```sql
CREATE TABLE mnemo_composition_rule (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  description     TEXT,
  condition_dsl   JSONB       NOT NULL,                                  -- rule DSL (e.g. {if: ..., then: ...})
  action_dsl      JSONB       NOT NULL,
  priority        INTEGER     NOT NULL DEFAULT 100,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  execution_count INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.12 mnemo_webhook_endpoint

```sql
CREATE TABLE mnemo_webhook_endpoint (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  events          TEXT[]      NOT NULL DEFAULT '{}',                    -- event types to deliver
  secret_hash     TEXT        NOT NULL,                                  -- HMAC signing secret (hashed)
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  failure_count   INTEGER     NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.13 mnemo_encryption_keys

```sql
CREATE TABLE mnemo_encryption_keys (
  id              TEXT        PRIMARY KEY,
  workspace_id    TEXT        NOT NULL,
  key_id          TEXT        NOT NULL UNIQUE,                          -- KMS key reference
  algorithm       TEXT        NOT NULL DEFAULT 'AES-256-GCM',
  purpose         TEXT        NOT NULL,                                  -- 'embeddings'|'metadata'|'all'
  is_primary      BOOLEAN     NOT NULL DEFAULT false,
  rotated_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.14 Multi-tenancy: mnemo_user, mnemo_tenant, mnemo_tenant_member, mnemo_workspace, mnemo_workspace_member

See [MULTI_TENANCY.md](./MULTI_TENANCY.md) for the model these 5 tables implement (roles, the two authority planes, role→scope narrowing) and [API.md §2.14](./API.md#214-multi-tenancy-tenants-workspaces-users-tokens) for the HTTP routes. All 5 live in the `mnemosyne` schema (`packages/adapter-postgres/migrations/baseline/0001_v3_complete_baseline.sql`), unlike most tables in this document which are workspace-scoped `mnemo_*` primitives — these are the tables THAT DEFINE workspace scoping.

```sql
CREATE TABLE mnemosyne.mnemo_user (
  id                  TEXT        PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  email               TEXT        NOT NULL UNIQUE,
  display_name        TEXT,
  personal_tenant_id  TEXT        NOT NULL,                              -- every user has exactly one personal tenant
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mnemosyne.mnemo_tenant (
  id          TEXT        PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  name        TEXT        NOT NULL,
  kind        TEXT        NOT NULL DEFAULT 'organization'
                CHECK (kind IN ('personal', 'organization')),
  plan        TEXT        NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mnemosyne.mnemo_tenant_member (
  tenant_id   TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  role        TEXT        NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member')),
  invited_by  TEXT,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE mnemosyne.mnemo_workspace (
  id              TEXT        PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  name            TEXT        NOT NULL,
  slug            TEXT,
  tenant_id       TEXT        NOT NULL,
  owner_user_id   TEXT,
  visibility      TEXT        NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'public')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mnemosyne.mnemo_workspace_member (
  workspace_id  TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'member'
                  CHECK (role IN ('owner', 'admin', 'write', 'read')),
  invited_by    TEXT,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
```

`mnemo_api_keys` (§4.6) has `key_kind` (`'workspace' | 'user'`), `user_id`, and `tenant_id` columns joining this model to the key system: a `key_kind='workspace'` row is a plain workspace key (no `user_id`); `key_kind='user'` is a `uk_live_*` token bound to `user_id`, resolvable against any workspace that user belongs to via `X-Workspace-Id`.

**RLS policies** (see §6 for the general RLS pattern):

- `mnemo_tenant_member` — read/write scoped by `tenant_id = current_setting('mnemosyne.actor_tenant_id')`. Purely tenant-scoped: any member of a tenant can read all its `tenant_member` rows (not just their own), which is why `requireTenantAdmin()` can check the CALLER's own role without a self-referencing-policy problem.
- `mnemo_workspace` — read requires `tenant_id` match AND (`visibility='public'` OR caller is a workspace member OR caller is `owner_user_id`).
- `mnemo_workspace_member` — the interesting one. Its original policy (`0001_v3_complete_baseline.sql`) had a **self-referential RLS recursion bug**: the `SELECT` policy subqueried `mnemo_workspace_member` itself to check "is the caller a member of this workspace", which under NOSUPERUSER/FORCE RLS throws `"infinite recursion detected in policy for relation \"mnemo_workspace_member\""` unconditionally. Fixed in migration `0012_workspace_member_rls_recursion.sql` via a `SECURITY DEFINER` helper function (`mnemosyne.is_workspace_member(workspace_id, user_id)`) that evaluates the same check through a privileged path, breaking the cycle without weakening the check.
  - A second, narrower gap surfaced while building the user-token provisioning route (S6): a tenant owner/admin minting a token for a user in a workspace they don't personally belong to would get a false "not a member" result, because the `0012` policy only allows reading your OWN row or a workspace you're ALSO a member of — no tenant-admin bypass existed. Fixed in `0022_workspace_member_read_tenant_admin.sql`, adding a third `SECURITY DEFINER` branch (`mnemosyne.is_tenant_admin_for_workspace`) so a tenant owner/admin can read any membership row for a workspace in their own tenant.

---

## 4.9 Contexto de origen: cuál de los cuatro vínculos manda

Hay **cuatro** formas de decir "esto salió de esa sesión". No son intercambiables, y sólo una es
autoritativa. Escrito acá porque la pregunta "¿a cuál le creo?" no tenía respuesta en ningún lado
y las cuatro se leían igual de oficiales.

| Vínculo                                | Integridad               | Quién lo escribe                             | Estado             |
| -------------------------------------- | ------------------------ | -------------------------------------------- | ------------------ |
| `mnemo_fact.episode_id`                | **FK** → `mnemo_episode` | el collapse, vía `linkSessionFactsToEpisode` | **CANÓNICO**       |
| `mnemo_fact.session_id`                | ninguna                  | `remember()`, del body de la request         | correlativo        |
| `mnemo_episode.source_conversation_id` | ninguna                  | el collapse, y `@mnemo-ai/cup`               | correlativo        |
| `mnemo_recall_log.session_id`          | **FK** → `mnemo_session` | `recall-cold`, desde `auth.sessionId`        | válido en su tabla |

**La regla**: para responder "¿de qué contexto salió este fact?", leer `episode_id`. Es el único con
integridad referencial y el único que el recall usa (`preferSourceEpisode`, spec §17).

**Por qué los correlativos no se pueden endurecer** — no es pereza, cada FK que falta rompería algo:

- `fact.session_id` llega del body de `POST /remember` y **nadie lo valida**. Con un FK, un agente
  que mande un id viejo o inventado recibiría un error de constraint y **perdería la escritura** —
  exactamente la clase de fallo que P74 existe para eliminar.
- `episode.source_conversation_id` recibe los `session_id` de **v2** desde `@mnemo-ai/cup`
  (`TypeMapper.ts`), que no tienen fila en `mnemo_session`. Un FK rompería la migración v2→v3.

Por eso esto es una **jerarquía declarada, no una restricción impuesta**. Si en algún momento el
`sessionId` pasa a ser emitido y validado por el servidor —en vez de aceptado del caller— la
primera de las dos deja de aplicar y `fact.session_id` puede recibir su FK.

**Nota de lectura**: `recall-cold.ts` mapea `episode.sourceConversationId` **dentro** del campo que
llama `sessionId` en su vista interna. Es deliberado: en la capa de dominio los dos responden la
misma pregunta. Sólo el almacenamiento los mantiene separados.

## 4.10 `mnemo_prime_ctx` — tabla sin uso, y por qué NO cablearla a ciegas

`mnemo_prime_ctx` existe en el baseline con RLS, FK a `mnemo_session` y un CHECK sobre
`trigger_type` (`periodic|sequential|conditional|entity`). **Cero referencias en el código.**

No es que la feature no exista: la anticipación **está cableada**. `preinjectAnticipation`
(`core/src/session/anticipation-preinject.ts`) se llama desde `routes/session.ts` y stagea el feed
**en Redis**, vía `workingMemory.workSet` con la clave `ANTICIPATION_SLOT`. La tabla era el espejo
durable de ese mismo dato y la implementación tomó otro camino.

**Antes de cablearla** hay que decidir qué problema resuelve que Redis no: persistencia entre
reinicios, auditabilidad del pre-fetch, o análisis histórico de precisión. Si la respuesta es
"ninguno", la tabla se borra con una migración en vez de llenarse. Lo que no conviene es escribir
en ambos lados sin que uno sea autoritativo — que es exactamente la deuda de los cuatro vínculos
descrita en §4.9.

## 5. Indexes

### Vector Search (HNSW)

As of migration `0009_unconstrained_halfvec.sql`, all `halfvec`/`vector` embedding
columns (fact, decision, strategy, skill, reasoning, hyperedge, entity, episode,
reminder, query_cache) are unconstrained — no fixed dimension — so a single
workspace can mix embedding providers/dimensions (e.g. OpenAI 1536 and Bedrock
Titan 1024) on the same column. A plain HNSW index on an unconstrained column
pins the first dimension it sees and rejects inserts of any other dimension, so
migration `0009` drops every fixed-dimension HNSW index that existed under the
old constrained-column baseline.

Migration `0010_dimension_scoped_hnsw.sql` restores indexed cosine search only
on the hot column, `mnemo_fact.embedding`, as dimension-scoped **partial**
expression indexes — one per dimension in production use:

```sql
-- Fact embedding, 1536-dim rows only (OpenAI text-embedding-3-small)
CREATE INDEX CONCURRENTLY idx_mnemo_fact_embedding_hnsw_1536
  ON mnemo_fact
  USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE vector_dims(embedding) = 1536;

-- Fact embedding, 1024-dim rows only (Bedrock Titan / Cohere)
CREATE INDEX CONCURRENTLY idx_mnemo_fact_embedding_hnsw_1024
  ON mnemo_fact
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE vector_dims(embedding) = 1024;
-- Justification: main hot path for similarity search; each partial index
-- covers only rows of its own dimension, so mixed-dimension workspaces coexist
-- and INSERTs of either size succeed. HNSW beats IVFFlat at p99.
```

All other embedding columns (`mnemo_decision.embedding`, `mnemo_strategy.embedding`,
`mnemo_skill.embedding`, `mnemo_reasoning.embedding`,
`mnemo_hyperedge.context_embedding`, `mnemo_entity.embedding`,
`mnemo_episode.embedding`, `mnemo_reminder.condition_embedding`,
`mnemo_query_cache.query_embedding`) intentionally stay unindexed post-`0010`:
they are cold-path or low-volume lookups, and each additional dimension would
multiply the index count per column. Revisit per-column if profiling says
otherwise.

### Full-Text Search (GIN on tsvector)

```sql
CREATE INDEX idx_fact_fts ON mnemo_fact USING gin (text_lemmatized);
CREATE INDEX idx_decision_fts ON mnemo_decision USING gin (text_lemmatized);
-- Justification: full-text (ts_rank_cd) tier-3 recall fallback when vector score is insufficient
```

### GIN on Arrays

```sql
-- Entity aliases — deduplication lookup
CREATE INDEX idx_entity_aliases ON mnemo_entity USING gin (aliases);

-- Episode topics — filter by topic tag
CREATE INDEX idx_episode_topics ON mnemo_episode USING gin (topics);

-- Hyperedge membership — "is this fact in any hyperedge?" reverse lookup
CREATE INDEX idx_hyperedge_members ON mnemo_hyperedge USING gin (member_ids);

-- Task dependency arrays
CREATE INDEX idx_task_blocked_by ON mnemo_task USING gin (blocked_by);
```

### BRIN (time-series / append-heavy)

```sql
-- Audit log — sequential insert, range scans by time
CREATE INDEX idx_audit_log_created_brin ON mnemo_audit_log USING brin (created_at);
-- Justification: audit table is append-only; BRIN is 100x smaller than btree here

-- Event log — immutable, queried by time range
CREATE INDEX idx_event_occurred_brin ON mnemo_event USING brin (occurred_at);
```

### Partial B-tree Indexes

```sql
-- Active facts — the 95% case; filters out merged/forgotten
CREATE INDEX idx_fact_active ON mnemo_fact (workspace_id, updated_at DESC)
  WHERE status = 'active';

-- High-worth facts — governance promotion queries
CREATE INDEX idx_fact_worth_high ON mnemo_fact (workspace_id, worth DESC)
  WHERE status = 'active' AND worth > 0.7;

-- Embedding staleness — re-embedding job queue
CREATE INDEX idx_fact_stale_embedding ON mnemo_fact (workspace_id)
  WHERE embedding_stale = true AND status = 'active';

-- Active decisions only
CREATE INDEX idx_decision_active ON mnemo_decision (workspace_id, updated_at DESC)
  WHERE status = 'active';

-- Real (non-synthetic) episodes for timeline UI
CREATE INDEX idx_episode_real ON mnemo_episode (workspace_id, occurred_at DESC)
  WHERE is_synthetic = false;

-- Pending judgment edges
CREATE INDEX idx_relation_pending ON mnemo_relation (workspace_id, created_at)
  WHERE judgment_status = 'pending';

-- Review queue — unreviewed items by priority
CREATE INDEX idx_review_queue_open ON mnemo_review_queue (workspace_id, priority, created_at)
  WHERE reviewed_at IS NULL;

-- Open tasks
CREATE INDEX idx_task_open ON mnemo_task (workspace_id, priority, due_at)
  WHERE status IN ('pending', 'in_progress', 'blocked');
```

### Standard B-tree

```sql
-- Fact topic_key — upsert lookup
CREATE INDEX idx_fact_topic_key ON mnemo_fact (workspace_id, topic_key)
  WHERE topic_key IS NOT NULL;

-- Entity canonical resolution
CREATE INDEX idx_entity_canonical ON mnemo_entity (workspace_id, canonical_id)
  WHERE canonical_id IS NOT NULL;

-- Episode delta-tree traversal
CREATE INDEX idx_episode_tree ON mnemo_episode (workspace_id, parent_episode_id);

-- Relation graph traversal
CREATE INDEX idx_relation_source ON mnemo_relation (workspace_id, source_kind, source_id);
CREATE INDEX idx_relation_target ON mnemo_relation (workspace_id, target_kind, target_id);

-- Hebbian weight for edge sorting
CREATE INDEX idx_relation_hebbian ON mnemo_relation (workspace_id, hebbian_weight DESC)
  WHERE valid_to IS NULL;

-- Session lookup
CREATE INDEX idx_session_workspace ON mnemo_session (workspace_id, status, started_at DESC);

-- Query cache hash
CREATE INDEX idx_query_cache_lookup ON mnemo_query_cache (workspace_id, query_hash);

-- Reasoning topic_key fast lookup
CREATE INDEX idx_reasoning_topic_key ON mnemo_reasoning (workspace_id, topic_key)
  WHERE topic_key IS NOT NULL;
```

---

## 6. RLS Policies

### Template Policy (Pattern A — FORCE)

```sql
-- Applied to every mnemo_* table. The host application sets
-- mnemosyne.workspace_id before each transaction.

ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

CREATE POLICY {table}_workspace_isolation ON {table}
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
```

### Application Per Table

```sql
-- Core primitives
ALTER TABLE mnemo_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_fact_ws ON mnemo_fact
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_decision_ws ON mnemo_decision
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_episode ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_episode FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_episode_ws ON mnemo_episode
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_entity FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_entity_ws ON mnemo_entity
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_strategy FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_strategy_ws ON mnemo_strategy
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_workflow FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_workflow_ws ON mnemo_workflow
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_skill ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_skill FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_skill_ws ON mnemo_skill
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_task FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_task_ws ON mnemo_task
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_event FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_event_ws ON mnemo_event
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_reasoning ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_reasoning FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_reasoning_ws ON mnemo_reasoning
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

-- Relationship tables
ALTER TABLE mnemo_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_relation FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_relation_ws ON mnemo_relation
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

ALTER TABLE mnemo_hyperedge ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_hyperedge FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_hyperedge_ws ON mnemo_hyperedge
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);

-- Audit log: readable but not writable by application role
ALTER TABLE mnemo_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_audit_log_ws ON mnemo_audit_log
  FOR SELECT USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
-- INSERT is performed by a SECURITY DEFINER trigger function only.
```

### Per-Agent RBAC (via mnemo_access_policy)

The `mnemo_access_policy` table is consulted by the application layer (not PG-native policies) to enforce agent-scoped restrictions within a workspace. Evaluation order: DENY > ALLOW, lower priority number wins.

---

## 7. Materialized Views

### Materialized View Policy

All materialized views in this schema contain data for ALL workspaces. They are NOT
filtered by workspace at refresh time.

**Query requirement**: Every query against a materialized view MUST include
`WHERE workspace_id = $1` to leverage RLS automatically.

**Refresh safety**: Since views contain all workspaces, REFRESH MATERIALIZED VIEW
CONCURRENTLY does not contaminate any single workspace's query results.

**Anti-pattern** (NEVER DO THIS):

```sql
-- WRONG: workspace GUC in materialized view
CREATE MATERIALIZED VIEW mv_entity_summary AS
SELECT ... WHERE workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid;
```

### 7.1 mv_sequential_patterns

Identifies frequently co-recalled primitive pairs in sequence (AB → CD type patterns).

```sql
CREATE MATERIALIZED VIEW mv_sequential_patterns AS
SELECT
  r.workspace_id,
  r.source_kind,
  r.source_id,
  r.target_kind,
  r.target_id,
  r.relation,
  r.co_recall_count,
  r.hebbian_weight,
  row_number() OVER (
    PARTITION BY r.workspace_id
    ORDER BY r.co_recall_count DESC
  ) AS rank
FROM mnemo_relation r
WHERE r.co_recall_count >= 3
  AND r.valid_to IS NULL;

CREATE UNIQUE INDEX mv_sequential_patterns_pk
  ON mv_sequential_patterns (workspace_id, source_id, target_id);

-- NOTE: This view contains ALL workspaces. Queries MUST include
-- WHERE workspace_id = $1. RLS will filter automatically.
-- REFRESH MATERIALIZED VIEW CONCURRENTLY is safe — no single-workspace contamination.
```

### 7.2 mv_periodic_patterns

Tracks primitive activation frequency bucketed by hour-of-day (for time-aware recall bias).

```sql
CREATE MATERIALIZED VIEW mv_periodic_patterns AS
SELECT
  f.workspace_id,
  f.id                        AS primitive_id,
  'fact'                      AS primitive_kind,
  date_trunc('hour', f.last_recalled_at)::TIME AS hour_bucket,
  count(*)                    AS activation_count
FROM mnemo_fact f
WHERE f.last_recalled_at IS NOT NULL
  AND f.status = 'active'
GROUP BY 1, 2, 3, 4;

CREATE INDEX mv_periodic_patterns_ws_hour
  ON mv_periodic_patterns (workspace_id, hour_bucket);

-- NOTE: This view contains ALL workspaces. Queries MUST include
-- WHERE workspace_id = $1. RLS will filter automatically.
-- REFRESH MATERIALIZED VIEW CONCURRENTLY is safe — no single-workspace contamination.
```

### 7.3 mv_confidence_map

Per-workspace snapshot of confidence distribution by primitive kind.

```sql
CREATE MATERIALIZED VIEW mv_confidence_map AS
SELECT
  workspace_id,
  'fact'            AS kind,
  count(*)          AS total,
  avg(confidence)   AS avg_confidence,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY confidence) AS median_confidence,
  sum(CASE WHEN confidence < 0.5 THEN 1 ELSE 0 END) AS low_confidence_count
FROM mnemo_fact
WHERE status = 'active'
GROUP BY workspace_id
UNION ALL
SELECT
  workspace_id,
  'decision',
  count(*),
  avg(confidence),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY confidence),
  sum(CASE WHEN confidence < 0.5 THEN 1 ELSE 0 END)
FROM mnemo_decision
WHERE status = 'active'
GROUP BY workspace_id;

CREATE UNIQUE INDEX mv_confidence_map_pk ON mv_confidence_map (workspace_id, kind);

-- NOTE: This view contains ALL workspaces. Queries MUST include
-- WHERE workspace_id = $1. RLS will filter automatically.
-- REFRESH MATERIALIZED VIEW CONCURRENTLY is safe — no single-workspace contamination.
```

### 7.4 mv_knowledge_gaps

Compares actual primitive distribution against the UCE target (100 of each type per workspace). Used by `mnemo.type.schedule` cron to bias extraction.

```sql
CREATE MATERIALIZED VIEW mv_knowledge_gaps AS
WITH targets AS (
  SELECT unnest(ARRAY[
    'fact','decision','episode','entity','strategy',
    'workflow','skill','task','event','reasoning'
  ]) AS kind,
  100 AS target_count
),
actuals AS (
  SELECT 'fact'      AS kind, workspace_id, count(*) AS actual FROM mnemo_fact     WHERE status = 'active' GROUP BY workspace_id UNION ALL
  SELECT 'decision',           workspace_id, count(*) FROM mnemo_decision  WHERE status = 'active' GROUP BY workspace_id UNION ALL
  SELECT 'episode',            workspace_id, count(*) FROM mnemo_episode             GROUP BY workspace_id UNION ALL
  SELECT 'entity',             workspace_id, count(*) FROM mnemo_entity              GROUP BY workspace_id UNION ALL
  SELECT 'strategy',           workspace_id, count(*) FROM mnemo_strategy  WHERE status = 'active' GROUP BY workspace_id UNION ALL
  SELECT 'workflow',           workspace_id, count(*) FROM mnemo_workflow  WHERE status = 'active' GROUP BY workspace_id UNION ALL
  SELECT 'skill',              workspace_id, count(*) FROM mnemo_skill               GROUP BY workspace_id UNION ALL
  SELECT 'task',               workspace_id, count(*) FROM mnemo_task      WHERE status NOT IN ('completed','cancelled') GROUP BY workspace_id UNION ALL
  SELECT 'event',              workspace_id, count(*) FROM mnemo_event               GROUP BY workspace_id UNION ALL
  SELECT 'reasoning',          workspace_id, count(*) FROM mnemo_reasoning WHERE status = 'active' GROUP BY workspace_id
)
SELECT
  a.workspace_id,
  a.kind,
  a.actual,
  t.target_count,
  GREATEST(0, t.target_count - a.actual) AS gap,
  CASE
    WHEN a.actual = 0 THEN 1.0
    ELSE (t.target_count - a.actual)::REAL / NULLIF(t.target_count, 0)
  END AS gap_fraction
FROM actuals a
JOIN targets t USING (kind);

CREATE UNIQUE INDEX mv_knowledge_gaps_pk ON mv_knowledge_gaps (workspace_id, kind);

-- NOTE: This view contains ALL workspaces. Queries MUST include
-- WHERE workspace_id = $1. RLS will filter automatically.
-- REFRESH MATERIALIZED VIEW CONCURRENTLY is safe — no single-workspace contamination.
```

All materialized views are refreshed by cron (see §8) with `REFRESH MATERIALIZED VIEW CONCURRENTLY`.

---

## 8. Cron Jobs

Managed via `pg_cron` extension (PG) or application-level scheduler (SQLite / embedded).

| Key                          | Schedule          | Operation                                                                                                                                                          |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mnemo.session.collapse`     | `*/5 * * * *`     | Collapse sessions inactive > 30 min. Runs LLM consolidation, updates session.status = 'collapsed', extracts cross-session facts.                                   |
| `mnemo.reasoning.decay`      | `0 3 * * *`       | Archive reasoning rows with worth < 0.2 and last_used_at > 30 days.                                                                                                |
| `mnemo.reasoning.prune`      | `0 2 * * 0`       | Hard-delete pruned reasoning older than 90 days.                                                                                                                   |
| `mnemo.hot.decay`            | `0 * * * *`       | Apply ACT-R activation decay to mnemo_fact.memory_strength (multiply by e^(-d·Δt)).                                                                                |
| `mnemo.hot.rebuild`          | `0 4 * * *`       | Rebuild Redis hot-tier cache from top-1000 facts by memory_strength per workspace.                                                                                 |
| `mnemo.verify.codebase`      | `30 5 * * *`      | Compare code-referencing facts against current repo state. Flag stale as embedding_stale = true and add to review queue.                                           |
| `mnemo.hebbian.normalize`    | `0 1 * * 0`       | Homeostatic normalization: scale all hebbian_weight in a workspace so mean = 1.0 (prevents runaway potentiation).                                                  |
| `mnemo.worth.propagate`      | `0 2 * * *`       | TD(λ) credit propagation: trace provenance DAG backward up to 5 hops from each collapsed session outcome. Update worth_success / worth_failure.                    |
| `mnemo.procedural.evaluate`  | `0 0 * * 1`       | Evaluate prompt evolution: compare active vs. candidate prompt versions on held-out recall tests. Promote if candidate wins by >2%.                                |
| `mnemo.plugin.sync`          | per-plugin config | Sync external sources (GitHub, Slack, Jira) into mnemo_event / mnemo_fact. Update mnemo_plugin_state cursor.                                                       |
| `mnemo.audit.merkle`         | `0 * * * *`       | Compute Merkle chain root over last-hour audit entries. Store root in mnemo_health for tamper detection.                                                           |
| `mnemo.type.schedule`        | `0 6 * * *`       | Refresh mv_knowledge_gaps. Emit extraction bias config to Redis (read by extraction pipeline on next session).                                                     |
| `mnemo.materialized.refresh` | `*/15 * * * *`    | REFRESH MATERIALIZED VIEW CONCURRENTLY for all four mv_* views.                                                                                                    |
| `mnemo.consolidation.gate`   | `0 3 * * 0`       | Gated consolidation: cluster facts with cosine ≥ 0.85, check all 6 gate conditions, merge clusters that pass, archive originals, run post-merge recall regression. |

---

## 9. Migration Strategy

### Numbering Convention

```
packages/core/src/db/migrations/
  0001_initial_schema.sql
  ...
  0051_v2_episodes_first_class.sql
  0052_v3_mnemo_reasoning.sql
  0053_v3_mnemo_session.sql
  0054_v3_mnemo_strategy.sql
  0055_v3_mnemo_workflow.sql
  0056_v3_mnemo_skill.sql
  0057_v3_mnemo_task.sql
  0058_v3_mnemo_event.sql
  0059_v3_mnemo_access_policy.sql
  0060_v3_mnemo_hyperedge.sql
  0061_v3_mnemo_audit_log.sql
  0062_v3_mnemo_prompt_version.sql
  0063_v3_mnemo_plugin_state.sql
  0064_v3_mnemo_webhook_endpoint.sql
  0065_v3_mnemo_composition_rule.sql
  0066_v3_mnemo_encryption_keys.sql
  0067_v3_fact_worth_columns.sql
  0068_v3_fact_session_topic_key.sql
  0069_v3_fact_embedding_stale.sql
  0070_v3_relation_hebbian.sql
  0071_v3_episode_delta_tree.sql
  0072_v3_hnsw_indexes.sql
  0073_v3_partial_indexes.sql
  0074_v3_rls_force.sql
  0075_v3_materialized_views.sql
  0076_v3_cron_jobs.sql
```

### Rules

1. **Zero downtime first**: all new tables and nullable column additions before backfill steps.
2. **One concern per file**: never mix DDL and DML in the same migration.
3. **Idempotent**: use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
4. **Backfill separately**: large backfills run as standalone files with `LIMIT` + `OFFSET` batches.
5. **Generated columns last**: `worth GENERATED ALWAYS AS` requires the dependent counters to exist first (0067 adds `worth_success` + `worth_failure`, then adds `worth` in the same file since they are coupled).
6. **HNSW after data**: HNSW indexes are created after bulk data exists (0072), not inline with table creation, to avoid index build blocking inserts.
7. **RLS after structure**: enable + force RLS only after all columns are confirmed (0074), so partial table states never produce policy errors.

---

## 10. SQLite Compatibility

SQLite mode is used for embedded / offline deployments (e.g. desktop agent, CI test harness). Full PG mode is required for production.

| Feature                      | PG (full)    | SQLite (reduced) | Notes                                                        |
| ---------------------------- | ------------ | ---------------- | ------------------------------------------------------------ |
| All 10 primitive tables      | yes          | yes              | Schema adapted via drizzle sqlite dialect                    |
| `halfvec` / `vector` columns | yes          | no               | Embeddings stored as BLOB (float32 array)                    |
| HNSW indexes                 | yes          | no               | Replaced by brute-force cosine scan in app layer             |
| GIN indexes                  | yes          | no               | Array columns stored as JSON strings; filtered in app layer  |
| BRIN indexes                 | yes          | no               | Replaced by standard btree on created_at                     |
| tsvector / FTS               | yes          | partial          | SQLite FTS5 used; lemmatization skipped                      |
| GENERATED columns            | yes          | yes (3.31+)      | `worth` GENERATED AS supported                               |
| RLS / FORCE                  | yes          | no               | Tenancy enforced via `WHERE workspace_id = ?` in every query |
| Materialized views           | yes          | no               | Replaced by on-demand aggregate queries                      |
| pg_cron                      | yes          | no               | Cron replaced by application-level setTimeout / node-cron    |
| JSONB operators              | yes          | partial          | Basic JSON operators work; GIN on JSONB not available        |
| `mnemo_relation` hebbian     | yes          | yes              | Plain columns — no PG-specific types                         |
| `mnemo_hyperedge`            | yes          | yes              | member_ids stored as JSON string                             |
| `mnemo_audit_log`            | yes          | yes              | Merkle chain computed in app layer                           |
| `mnemo_access_policy`        | yes          | yes              | RBAC evaluated in app layer only                             |
| `mnemo_encryption_keys`      | yes          | yes              | Key references stored; KMS calls in app layer                |
| Transaction isolation        | SERIALIZABLE | SERIALIZABLE     | SQLite WAL mode required                                     |
| Concurrent writers           | yes (MVCC)   | limited          | SQLite write lock; not suitable for multi-process            |

Recommended SQLite usage: single-agent embedded deployments, integration tests, and offline-first clients that sync to PG on reconnect. Multi-agent or multi-workspace production deployments require PG.
