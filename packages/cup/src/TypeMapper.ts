// CUP v2→v3 TypeMapper (TASK-14001, MIGRATION_CUP.md, AUDIT_REPORT.md MED-18).
//
// Maps ALL 8 v2 `memory_type` values to v3 cognitive primitives.
// Previous implementations only handled 5 — this covers all 8 (MED-18 fix).
//
// Confidence policy (MED-10 fix):
//   Migrated facts start with worthAlpha=1.0, worthBeta=2.0
//   Beta(1,2) mean = 1/3 ≈ 0.33 — below neutral. Facts earn trust through use.
//   This is lower than v2 (which often set confidence=1.0 on import — bad).
//
// Stored as { confidence: MIGRATED_CONFIDENCE, metadata.worthAlpha, metadata.worthBeta }.
// The storage layer can use metadata.worthAlpha/worthBeta to override the DB columns
// directly if it supports it; otherwise confidence=0.33 is the fallback.

import type {
  CreateFactInput,
  CreateEpisodeInput,
  CreateSkillInput,
} from "@mnemo-ai/types";

// ─── V2 type map (all 8 values) ───────────────────────────────────────────────

const V2_TO_V3_TYPE_MAP = {
  episodic: "episode",
  semantic: "fact",
  procedural: "skill",
  working: "fact",      // → fact with short validTo (72h)
  contextual: "episode", // → episode with low confidence
  factual: "fact",
  relational: "fact",   // → fact + relation if entity field present
  preference: "fact",   // → fact with tags: ['preference']
} as const;

export type V2MemoryType = keyof typeof V2_TO_V3_TYPE_MAP;
export type V3PrimitiveType = (typeof V2_TO_V3_TYPE_MAP)[V2MemoryType];

// ─── V2 memory shape (minimal, accepting extra fields) ────────────────────────

export interface V2Memory {
  id: string;
  workspace_id: string;
  agent_id?: string;
  actor_id?: string;
  session_id?: string;
  memory_type: string;
  content: string;
  subject?: string;
  confidence?: number;
  entity_id?: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

// ─── Mapped output ────────────────────────────────────────────────────────────

export interface MappedFact {
  type: "fact";
  input: CreateFactInput;
  /** For "relational" type with entity_id — create a relation after inserting the fact. */
  pendingRelation?: { entityId: string };
}

export interface MappedEpisode {
  type: "episode";
  input: CreateEpisodeInput;
}

export interface MappedSkill {
  type: "skill";
  input: CreateSkillInput;
}

export type MappedItem = MappedFact | MappedEpisode | MappedSkill;

// ─── Confidence policy (MED-10 fix) ──────────────────────────────────────────

const MIGRATED_CONFIDENCE = 1 / 3; // Beta(1,2) mean — below neutral
const MIGRATED_WORTH_ALPHA = 1.0;
const MIGRATED_WORTH_BETA = 2.0;
const WORKING_MEMORY_TTL_HOURS = 72;

// ─── Mapper ───────────────────────────────────────────────────────────────────

/**
 * Map a v2 memory record to a v3 primitive creation input.
 *
 * @param v2 - The v2 memory row.
 * @returns A typed mapped item ready to pass to the appropriate `storage.create*()` method.
 * @throws If `v2.memory_type` is not one of the 8 known types.
 */
export function mapV2Memory(v2: V2Memory): MappedItem {
  const v2Type = v2.memory_type as V2MemoryType;

  if (!(v2Type in V2_TO_V3_TYPE_MAP)) {
    throw new Error(
      `Unknown v2 memory_type: "${v2.memory_type}". Expected one of: ${Object.keys(V2_TO_V3_TYPE_MAP).join(", ")}`,
    );
  }

  const v3Type = V2_TO_V3_TYPE_MAP[v2Type];

  switch (v3Type) {
    case "fact":
      return mapToFact(v2, v2Type);

    case "episode":
      return mapToEpisode(v2, v2Type);

    case "skill":
      return mapToSkill(v2);

    default: {
      const _exhaustive: never = v3Type;
      throw new Error(`Unhandled v3 type: ${_exhaustive}`);
    }
  }
}

// ─── Per-type mappers ─────────────────────────────────────────────────────────

function mapToFact(v2: V2Memory, v2Type: V2MemoryType): MappedFact {
  // B6.35: a v2 record may never carry the reserved pending-consolidation marker
  // into a migrated v3 fact — only the consolidation repository may attach it.
  // Strip it from the source metadata before spreading in the CUP provenance.
  const { __mnemoConsolidationPending: _pending, ...safeV2Metadata } =
    (v2.metadata ?? {}) as Record<string, unknown>;
  const baseInput: CreateFactInput = {
    workspaceId: v2.workspace_id,
    agentId: v2.agent_id,
    actorId: v2.actor_id,
    sessionId: v2.session_id,
    scope: "global",
    statement: v2.content,
    subject: v2.subject ?? "general",
    kind: "other",
    confidence: MIGRATED_CONFIDENCE,
    extractionSource: "cup_migration_v2",
    metadata: {
      ...safeV2Metadata,
      v2Id: v2.id,
      v2MemoryType: v2Type,
      worthAlpha: MIGRATED_WORTH_ALPHA,
      worthBeta: MIGRATED_WORTH_BETA,
    },
  };

  // Type-specific overrides
  switch (v2Type) {
    case "working":
      // Short TTL — working memory decays quickly
      baseInput.validTo = new Date(
        new Date(v2.created_at).getTime() + WORKING_MEMORY_TTL_HOURS * 3600 * 1000,
      );
      break;

    case "preference":
      baseInput.kind = "preference";
      baseInput.tags = ["preference"];
      break;

    case "relational":
      // entity_id handled via pendingRelation below
      if (v2.entity_id) {
        baseInput.entityId = v2.entity_id;
      }
      break;
  }

  const result: MappedFact = { type: "fact", input: baseInput };

  // Relational: signal the caller to also create a relation
  if (v2Type === "relational" && v2.entity_id) {
    result.pendingRelation = { entityId: v2.entity_id };
  }

  return result;
}

function mapToEpisode(v2: V2Memory, v2Type: V2MemoryType): MappedEpisode {
  const episodeInput: CreateEpisodeInput = {
    workspaceId: v2.workspace_id,
    agentId: v2.agent_id,
    title: v2.subject ?? v2.content.slice(0, 80),
    narrative: v2.content,
    occurredAt: new Date(v2.created_at),
    sourceConversationId: v2.session_id,
    // contextual episodes have low confidence — mark as synthetic to avoid
    // inflating the episode quality score
    isSynthetic: v2Type === "contextual",
    metadata: {
      ...v2.metadata,
      v2Id: v2.id,
      v2MemoryType: v2Type,
      migratedConfidence: v2.confidence ?? MIGRATED_CONFIDENCE,
    },
  };

  return { type: "episode", input: episodeInput };
}

function mapToSkill(v2: V2Memory): MappedSkill {
  const skillInput: CreateSkillInput = {
    workspaceId: v2.workspace_id,
    name: v2.subject ?? v2.content.slice(0, 80),
    promptTemplate: v2.content,
    metadata: {
      ...v2.metadata,
      v2Id: v2.id,
      v2MemoryType: "procedural",
      v2AgentId: v2.agent_id,
      migratedConfidence: v2.confidence ?? MIGRATED_CONFIDENCE,
    },
  };

  return { type: "skill", input: skillInput };
}

/**
 * Convenience: map an array of v2 memories, collecting errors without stopping.
 * Returns mapped items and any failures with the original v2 record.
 */
export function mapV2MemoryBatch(v2Records: V2Memory[]): {
  mapped: MappedItem[];
  failed: Array<{ v2: V2Memory; error: string }>;
} {
  const mapped: MappedItem[] = [];
  const failed: Array<{ v2: V2Memory; error: string }> = [];

  for (const v2 of v2Records) {
    try {
      mapped.push(mapV2Memory(v2));
    } catch (err) {
      failed.push({ v2, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { mapped, failed };
}
