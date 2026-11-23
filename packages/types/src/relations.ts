// Relationship infrastructure types — DATA_MODEL.md §3
// mnemo_relation, mnemo_hyperedge, mnemo_citation

import type { ActorType } from "./provenance.js";
import type { MnemoEntity } from "./primitives.js";
import type { Sensitivity } from "./common.js";

/**
 * The 9 locked relation verbs. This set is CLOSED — do not add values here
 * without a matching SQL migration that updates the CHECK constraint in
 * packages/adapter-postgres/migrations/v3/0001_baseline.sql.
 *
 * Semantics:
 *   "related"        — Generic symmetric link. Use when no more specific verb applies.
 *   "compatible"     — A and B are known to work together (e.g. two tools, two strategies).
 *   "scoped"         — A applies within the scope of B (A is narrower than B).
 *   "conflicts_with" — A and B contradict each other; both cannot be true simultaneously.
 *   "supersedes"     — A replaces B (B is outdated). B should have status "superseded".
 *   "not_conflict"   — Explicit disambiguation: A and B look contradictory but are not.
 *   "derived_from"   — A was extracted, inferred, or synthesised from B.
 *   "part_of"        — A is a structural component of B.
 *   "member_of"      — A belongs to group or category B.
 *
 * Hebbian learning: `weight` on MnemoRelation strengthens when both endpoints
 * are co-recalled in the same query. This drives the activation cascade in stage 4
 * of the recall pipeline (recall-cold.ts).
 */
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

/**
 * Judgment-workflow status (flatten-legacy-dual-core D6.4). Matches the
 * physical `mnemo_relation.judgment_status` column and legacy
 * `core/src/graph/relation.ts`'s `JudgmentStatus`.
 */
export type JudgmentStatus = "pending" | "judged" | "dismissed";

/** Who/what applied a judgment. Matches `mnemo_relation.marked_by_kind`. */
export type MarkerKind = "user" | "agent" | "system" | "llm_judge";

/**
 * Primitive kinds that can be a `mnemo_relation` endpoint — enforced
 * physically by `mnemo_relation_source_kind_check`/`mnemo_relation_target_kind_check`
 * (migration 0045 widened them from the original fact/decision/entity/episode
 * to every non-hyperedge primitive, so strategies, workflows, skills, tasks,
 * events and reasoning can be related and lineage edges can point at them).
 * A hyperedge is itself an n-ary relation and is not a binary endpoint.
 */
export type RelationNodeKind =
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

/** Runtime companion to {@link RelationNodeKind}. */
export const RELATION_NODE_KINDS: readonly RelationNodeKind[] = [
  "fact",
  "decision",
  "entity",
  "episode",
  "strategy",
  "workflow",
  "skill",
  "task",
  "event",
  "reasoning",
];

/**
 * `mnemo_relation` is ONE physical table carrying TWO overlays on the same
 * row (flatten-legacy-dual-core D6.4, verified against
 * `adapter-postgres/src/schema/relations.ts:6-40`):
 *   - Hebbian co-recall learning (`weight`/`coRecallCount`/`directionality`/
 *     `lastCoRecallAt`) — driven by the recall pipeline's STDP updates.
 *   - Judgment workflow (`judgmentStatus`/`reason`/`evidence`/`confidence`/
 *     `markedBy*`/`provenance`/`conversationId`/`supersededByRelationId`/
 *     `validFrom`/`validTo`) — driven by conflict resolution / memory_judge.
 *
 * There is no separate free-form `metadata` field: the physical table has
 * no `metadata` column at all. The previous `MnemoRelation.metadata` was a
 * fiction that silently aliased onto the `evidence` column in
 * `GraphRepository.createRelation` — every relation write (even pure
 * Hebbian ones with no judgment intent) forced `evidence` to a non-null
 * `{}` instead of leaving the judgment overlay's natural unset (`null`)
 * state alone. `evidence` is now the real, correctly-named, nullable field.
 */
export interface MnemoRelation {
  id: string;
  workspaceId: string;

  sourceId: string;
  sourceType: RelationNodeKind;
  targetId: string;
  targetType: RelationNodeKind;

  verb: RelationVerb;
  weight: number; // Hebbian weight [0,1] — updated on co-recall

  /** Timestamp of the last co-recall event — used to compute STDP Δt (Wave Y, §25.3). */
  lastCoRecallAt?: Date;
  /** Number of times both endpoints have been co-recalled together (Hebbian overlay). */
  coRecallCount: number;
  /** Directional STDP bias in [-1, 1] (Hebbian overlay). */
  directionality: number;

  createdAt: Date;
  updatedAt: Date;

  actorId?: string;
  /** The platform account (mnemo_user.id) behind this write, when one exists. */
  userId?: string | null;
  actorType?: ActorType;

  /**
   * Bitemporal validity window. Both columns exist physically on
   * `mnemo_relation` (`valid_from NOT NULL DEFAULT now()`, `valid_to`
   * nullable) — always present, unlike the write-provenance triple above.
   */
  validFrom: Date;
  validTo: Date | null;

  /**
   * Judgment-workflow overlay (flatten-legacy-dual-core D6.4) — all fields
   * already exist physically on `mnemo_relation` and are already modeled by
   * the Drizzle `relationTable` object. Required (not optional) because the
   * physical columns are always present with real defaults on every row,
   * even for pure-Hebbian relations that were never judged
   * (`judgmentStatus: "pending"`, everything else `null`).
   */
  judgmentStatus: JudgmentStatus;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  confidence: number | null;
  markedByUserId: string | null;
  markedByKind: MarkerKind;
  markedByModel: string | null;
  markedByPromptVersion: string | null;
  provenance: string | null;
  conversationId: string | null;
  supersededByRelationId: string | null;
}

/** Memory primitive a citation can attach to. */
export type CitationMemoryKind = "fact" | "decision" | "entity" | "episode";

/** Where a citation's source span came from. */
export type CitationSourceKind =
  "message" | "document" | "tool_call" | "llm_extraction" | "user_edit" | "agent_save" | "imported";

/**
 * flatten-legacy-dual-core PR9e (design.md D6.5): the previous declaration
 * (`sourceId`/`sourceType`/`derivedId`/`derivedType`/`citationType`/
 * `confidence`) never matched the physical `mnemosyne.mnemo_citation` table
 * at all — reconciled to the real columns (`memory_kind`/`memory_id`/
 * `source_kind`/`source_id`/`extractor_model`/`extractor_prompt_version`/
 * `judge_model`/`judge_relation_id`/`evidence_excerpt`/`created_at`), same
 * shape the legacy `core/src/citation/store.ts`'s `Citation` and
 * `core/src/db/schema/citation.ts` already carry, and the same wire shape
 * `server/src/routes/citations.ts`'s `CitationSchema` already validates.
 */
export interface MnemoCitation {
  id: string;
  workspaceId: string;

  memoryKind: CitationMemoryKind;
  memoryId: string;

  sourceKind: CitationSourceKind;
  sourceId: string | null;

  extractorModel: string | null;
  extractorPromptVersion: string | null;
  judgeModel: string | null;
  judgeRelationId: string | null;
  evidenceExcerpt: string | null;

  createdAt: Date;
}

/** Filter for {@link MnemoCitation} reads (`StorageAdapter.listCitations`). */
export interface CitationFilter {
  workspaceId: string;
  memoryKind?: CitationMemoryKind;
  memoryId?: string;
  limit?: number;
  /**
   * flatten-legacy-dual-core PR9h (design.md D6.5 "Export") — additive
   * offset-pagination field. `listCitations` clamps `limit` to 500/call
   * (`CitationRepository.ts`); the pure-core `exportWorkspace` projection
   * (packages/core/src/cognitive/export/) needs to walk past that per-call
   * cap up to its own 100k row cap, and `CitationFilter` had no way to page
   * beyond the first 500 rows before this field existed. `GET /citations`
   * (routes/citations.ts) never sets this — its own public `limit` query
   * param is already capped at 500, so the field defaults to `0` there.
   */
  offset?: number;
}

/**
 * flatten-legacy-dual-core PR9f (design.md D6.5 "Graph — assembly-in-adapter,
 * traversal-in-core"): the Memory Graph's node kinds. Mirrors legacy
 * `core/src/graph/types.ts`'s `GraphEntityKind`-adjacent `kind` discriminant.
 */
export type GraphNodeKind = "entity" | "episode" | "decision";

/** Filter for {@link GraphSnapshot} assembly (`StorageAdapter.getGraphSnapshot`). */
export interface GraphSnapshotFilter {
  workspaceId: string;
  /** Restrict to this entity + its 1-hop neighbourhood. Omit for the full canonical view. */
  focusEntityId?: string;
  /** Overlay precomputed semantic-neighbor (kNN) edges onto the graph. */
  includeSemantic?: boolean;
  /**
   * Add an episode → entity edge (relation "mentions", provenance "episode_facts") for every
   * entity one of the episode's visible linked facts is about. Derived, never stored.
   */
  includeMentions?: boolean;
  /** Bitemporal point-in-time reconstruction — reproduces the graph as it stood at this instant. */
  asOf?: Date;
  /**
   * The caller's sensitivity ceiling. When set, entities, episodes, decisions
   * and facts above it are left out: no node, no edge or semantic edge drawn
   * from them, and no count in `factCount`. Omit for every tier.
   */
  maxSensitivity?: Sensitivity;
}

/** A node in the Memory Graph — an entity, episode, or active decision. */
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  entityKind?: MnemoEntity["kind"];
  label: string;
  description?: string | null;
  mentionCount: number;
  factCount: number;
  avgMemoryStrength: number;
  createdAt: Date;
}

/** An edge in the Memory Graph — a typed relation (or semantic-neighbor overlay) between two nodes. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  confidence: number;
  provenance: string | null;
}

/** Adapter-assembled Memory Graph snapshot — mirrors legacy `buildGraphQuery` (`graph/query.ts`). */
export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    entityCount: number;
    episodeCount: number;
    decisionCount: number;
    relationCount: number;
  };
}
