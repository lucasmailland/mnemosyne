import type {
  MnemoTask,
  MnemoEvent,
  MnemoReasoning,
  MnemoHyperedge,
  MnemoEntity,
  MnemoRelation,
} from "@mnemo-ai/types";

/**
 * Converts a MnemoEntity domain object (with Date fields) to an HTTP wire
 * shape (ISO strings) matching routes/entities.ts's EntitySchema. Used by the
 * link-user/unlink-user handlers, which call deps.storage directly (not the
 * legacy core client, whose narrower interface doesn't forward
 * linkedUserId/sensitivity changes) — so, unlike @mnemo-ai/core's
 * entityToWire, this reflects the entity's real stored sensitivity rather
 * than a hardcoded default (CORE-2).
 *
 * `mentionCount` comes from `countEntityMentions` under the caller's ceiling:
 * the stored `mention_count` column is never maintained, so it is not sent.
 */
export function entityToWire(row: MnemoEntity, mentionCount: number) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    kind: row.kind,
    aliases: row.aliases,
    canonicalId: row.canonicalId ?? null,
    description: row.description ?? null,
    sensitivity: row.sensitivity,
    metadata: row.metadata,
    linkedUserId: row.linkedUserId ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    mentionCount,
    // P120: the bitemporal pair travels to the caller. Without it an archived
    // row reads exactly like a live one — `forget` closes the interval and the
    // API said nothing about it. `hyperedge`, `relation` and `reasoning` in
    // this same file already carried it, which is why there was no design
    // reason for the ones that did not.
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Converts a MnemoTask domain object (with Date fields) to an HTTP wire shape (ISO strings).
 * Used by task routes to serialize task rows for API responses.
 */
export function taskToWire(row: MnemoTask) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assignedTo,
    delegatedBy: row.delegatedBy,
    parentTaskId: row.parentTaskId,
    blockedBy: row.blockedBy,
    subtaskIds: row.subtaskIds,
    relatedFacts: row.relatedFacts,
    relatedEntities: row.relatedEntities,
    sessionId: row.sessionId,
    outcome: row.outcome,
    lessonsLearned: row.lessonsLearned,
    delegatedAt: row.delegatedAt ? row.delegatedAt.toISOString() : undefined,
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
    dueAt: row.dueAt ? row.dueAt.toISOString() : undefined,
    sensitivity: row.sensitivity,
    // P120: the bitemporal pair travels to the caller. Without it an archived
    // row reads exactly like a live one — `forget` closes the interval and the
    // API said nothing about it. `hyperedge`, `relation` and `reasoning` in
    // this same file already carried it, which is why there was no design
    // reason for the ones that did not.
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    metadata: row.metadata,
  };
}

/**
 * Converts a MnemoEvent domain object (with Date fields) to an HTTP wire shape (ISO strings).
 * Events are immutable, so there is no updatedAt field.
 * Used by event routes to serialize event rows for API responses.
 */
export function eventToWire(row: MnemoEvent) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    name: row.name,
    description: row.description,
    occurredAt: row.occurredAt.toISOString(),
    durationS: row.durationS,
    source: row.source,
    relatedEntities: row.relatedEntities,
    annotations: row.annotations.map((a) => ({
      author: a.author,
      content: a.content,
      // B4.1 discovery: `annotations` round-trips through a JSONB column, so
      // Postgres/Drizzle deserializes `at` back as a plain ISO string, not a
      // `Date` instance, even though `MnemoEvent`'s type declares it as
      // `Date` — `a.at.toISOString()` throws on that real runtime shape
      // (never previously exercised end-to-end: no prior integration test
      // called POST /events/:id/annotations against a real DB). Handle both
      // so this stays correct if the type/storage layer is later fixed to
      // genuinely return a Date.
      at: a.at instanceof Date ? a.at.toISOString() : a.at,
    })),
    sensitivity: row.sensitivity,
    createdAt: row.createdAt.toISOString(),
    metadata: row.metadata,
  };
}

/**
 * Converts a MnemoHyperedge domain object (with Date fields) to an HTTP wire shape (ISO strings).
 * contextEmbedding is excluded from the wire shape (internal storage concern, not exposed via API).
 * Used by hyperedge routes to serialize hyperedge rows for API responses.
 */
export function hyperedgeToWire(row: MnemoHyperedge) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    memberIds: row.memberIds,
    label: row.label,
    description: row.description,
    contextQuery: row.contextQuery,
    activationCount: row.activationCount,
    worth: row.worth,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Converts a MnemoRelation domain object (with Date fields, `sourceType`/
 * `targetType`/`verb` field names) to routes/relations.ts's wire shape
 * (`sourceKind`/`targetKind`/`relation`, ISO-string dates) — flatten-legacy-
 * dual-core PR9d port off the legacy `CoreLike` client. The domain object also carries Hebbian
 * co-recall internals (`weight`/`coRecallCount`/`directionality`/
 * `lastCoRecallAt`) that are intentionally excluded here, matching the
 * legacy `CoreLike.listRelations`/`createRelation`/`patchRelation` wire shape
 * this route has always returned (RelationSchema).
 */
export function relationToWire(row: MnemoRelation) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceKind: row.sourceType,
    sourceId: row.sourceId,
    targetKind: row.targetType,
    targetId: row.targetId,
    relation: row.verb,
    judgmentStatus: row.judgmentStatus,
    reason: row.reason,
    evidence: row.evidence,
    confidence: row.confidence,
    markedByUserId: row.markedByUserId,
    markedByKind: row.markedByKind,
    markedByModel: row.markedByModel,
    markedByPromptVersion: row.markedByPromptVersion,
    provenance: row.provenance,
    conversationId: row.conversationId,
    supersededByRelationId: row.supersededByRelationId,
    actorId: row.actorId ?? null,
    userId: row.userId ?? null,
    actorType: row.actorType ?? null,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Converts a MnemoReasoning domain object (with Date fields) to an HTTP wire shape (ISO strings).
 * The `worth` field is generated/read-only — this mapper surfaces whatever value the adapter stored.
 * Embedding vectors are excluded from the wire shape (stored separately in vector DB).
 * Used by reasoning routes to serialize reasoning rows for API responses.
 */
export function reasoningToWire(row: MnemoReasoning) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    question: row.question,
    chain: row.chain,
    conclusion: row.conclusion,
    successCount: row.successCount,
    failureCount: row.failureCount,
    worth: row.worth,
    topicKey: row.topicKey,
    // embeddingStale intentionally excluded — storage-layer flag, not a wire concern
    status: row.status,
    sensitivity: row.sensitivity,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : undefined,
    usageCount: row.usageCount,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    metadata: row.metadata,
  };
}
