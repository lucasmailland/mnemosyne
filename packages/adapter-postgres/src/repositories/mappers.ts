import * as schema from "../schema/index.js";
import { pgQueryDuration } from "../metrics.js";
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
  MnemoCitation,
  CitationMemoryKind,
  CitationSourceKind,
  OutboxEntry,
  MnemoWebhookEndpoint,
  MnemoWebhookDelivery,
  MnemoReminder,
  MnemoCompositionRule,
  MnemoInferenceLogEntry,
  MnemoFactHash,
  ActorType,
} from "@mnemo-ai/types";

const toActorType = (v: string | null | undefined): ActorType | undefined =>
  (v as ActorType | undefined) ?? undefined;

export function instrumentedQuery<T>(
  queryType: "recall" | "write" | "admin",
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  return fn().then(
    (r) => {
      pgQueryDuration.observe({ query_type: queryType }, (Date.now() - start) / 1000);
      return r;
    },
    (e) => {
      pgQueryDuration.observe({ query_type: queryType }, (Date.now() - start) / 1000);
      throw e;
    }
  );
}

export function mapRowToSession(row: schema.SelectSession): MnemoSession {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId ?? undefined,
    trafficOrigin: row.trafficOrigin as MnemoSession["trafficOrigin"],
    continuityRootId: row.continuityRootId,
    actorId: (row.metadata as Record<string, unknown>)?.actorId as string | undefined,
    status: (row.status ?? "active") as MnemoSession["status"],
    turnCount: ((row as Record<string, unknown>).turnCount as number) ?? 0,
    tokenCount: ((row as Record<string, unknown>).tokenCount as number) ?? 0,
    collapsedAt: row.collapsedAt ?? undefined,
    openedAt: row.startedAt,
    scratch: ((row as Record<string, unknown>).scratch ?? {}) as Record<string, unknown>,
    metadata: row.metadata as Record<string, unknown>,
    label: ((row as Record<string, unknown>).label ?? null) as string | null,
    // Both columns are declared on MnemoSession and were never projected here,
    // so every read returned them as undefined regardless of what the row held.
    // `outcomeRating` had no writer at all until POST /session/:id/feedback
    // started setting it; `activePromptVersionId` IS written at session create
    // and read back by PluginRepository through raw SQL, so the domain object
    // was the only place it went missing.
    outcomeRating: ((row as Record<string, unknown>).outcomeRating ??
      null) as MnemoSession["outcomeRating"],
    activePromptVersionId: ((row as Record<string, unknown>).activePromptVersionId ?? null) as
      string | null,
    sourceHost: row.sourceHost ?? undefined,
    sourceSessionId: row.sourceSessionId,
    sourceClientInstanceId: row.sourceClientInstanceId,
    sourceGeneration: row.sourceGeneration,
    predecessorSessionId: row.predecessorSessionId,
    lastActivityAt: row.lastActivityAt,
    closeKind: row.closeKind as MnemoSession["closeKind"],
    closeRequestedAt: row.closeRequestedAt,
    closeGraceDeadline: row.closeGraceDeadline,
    terminalDigestVersion: row.terminalDigestVersion,
    terminalMessageSetDigest: row.terminalMessageSetDigest,
    terminalMaxEnqueueSequence: row.terminalMaxEnqueueSequence,
    sensitivity: row.sensitivity as MnemoSession["sensitivity"],
    originActorId: row.originActorId,
    originActorType: row.originActorType as MnemoSession["originActorType"],
    originUserId: row.originUserId,
    originSensitivityCeiling:
      row.originSensitivityCeiling as MnemoSession["originSensitivityCeiling"],
    collapseLeaseOwner: row.collapseLeaseOwner,
    collapseLeaseExpiresAt: row.collapseLeaseExpiresAt,
    collapseAttempts: row.collapseAttempts ?? 0,
    collapseNextAttemptAt: row.collapseNextAttemptAt,
    collapseOperationId: row.collapseOperationId,
    captureIncomplete: row.captureIncomplete ?? false,
    captureIncompleteReasons: (row.captureIncompleteReasons ?? []) as string[],
    archiveReason: row.archiveReason,
    archivedAt: row.archivedAt,
    factCount: row.factCount ?? null,
    collapseSummary:
      row.contextSnapshot && Object.keys(row.contextSnapshot as object).length > 0
        ? (row.contextSnapshot as Record<string, unknown>)
        : null,
  };
}

export function mapRowToFact(row: schema.SelectFact): MnemoFact {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId ?? undefined,
    actorId: row.actorId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scope: row.scope as MnemoFact["scope"],
    scopeRef: row.scopeRef ?? undefined,
    scopeOwner: row.scopeOwner ?? undefined,
    statement: row.statement,
    subject: row.subject,
    kind: row.kind as MnemoFact["kind"],
    // mnemo_fact.confidence is physically `real` — already a native number
    // from postgres.js, no parseFloat needed (see facts.ts's Slice 1 comment).
    confidence: row.confidence,
    relevance: row.relevance,
    hitCount: row.hitCount,
    lastRecalledAt: row.lastRecalledAt ?? undefined,
    worthSuccess: parseFloat(row.worthSuccess as string),
    worthFailure: parseFloat(row.worthFailure as string),
    worthAlpha: parseFloat(row.worthAlpha as string),
    worthBeta: parseFloat(row.worthBeta as string),
    worth: parseFloat((row.worth ?? "0.5") as string),
    memoryType: (row.memoryType ?? "semantic") as MnemoFact["memoryType"],
    memoryStrength: row.memoryStrength,
    memoryStability: row.memoryStability,
    lastStrengthUpdate: row.lastStrengthUpdate ?? undefined,
    attribution: row.attribution as MnemoFact["attribution"],
    attributedTo: (row.attributedTo as MnemoFact["attributedTo"]) ?? undefined,
    sourceMessageIds: row.sourceMessageIds ?? [],
    linkedMemoryIds: row.linkedMemoryIds ?? [],
    sessionId: row.sessionId ?? undefined,
    extractionSource: row.extractionSource ?? undefined,
    topicKey: row.topicKey ?? undefined,
    revisionCount: row.revisionCount,
    protocolVersion: row.protocolVersion,
    entityId: row.entityId ?? undefined,
    episodeId: row.episodeId ?? undefined,
    status: row.status as MnemoFact["status"],
    pinned: row.pinned,
    canonical: row.canonical ?? false,
    sensitivity: (row.sensitivity ?? "internal") as MnemoFact["sensitivity"],
    mergedIntoId: row.mergedIntoId ?? undefined,
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    embedding: row.embedding ? new Float32Array(row.embedding) : undefined,
    embeddingModel: row.embeddingModel ?? undefined,
    embeddingStale: row.embeddingStale,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToDecision(row: schema.SelectDecision): MnemoDecision {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId ?? undefined,
    actorId: row.actorId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    conversationId: row.conversationId ?? undefined,
    scopeOwner: row.scopeOwner ?? undefined,
    scopeRef: row.scopeRef ?? undefined,
    kind: row.kind as MnemoDecision["kind"],
    title: row.title,
    body: row.body,
    topicKey: row.topicKey ?? undefined,
    revisionCount: row.revisionCount,
    normalizedHash: row.normalizedHash,
    status: row.status as MnemoDecision["status"],
    supersededById: row.supersededById ?? undefined,
    decidedByUserId: row.decidedByUserId ?? undefined,
    confidence: row.confidence ?? undefined,
    sensitivity: (row.sensitivity ?? "internal") as MnemoDecision["sensitivity"],
    embeddingModel: row.embeddingModel ?? undefined,
    embeddingStale: row.embeddingStale,
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToEpisode(row: schema.SelectEpisode): MnemoEpisode {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId ?? undefined,
    agentId: row.agentId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scopeOwner: row.scopeOwner ?? undefined,
    title: row.title,
    narrative: row.narrative,
    occurredAt: row.occurredAt,
    durationMinutes: row.durationMinutes ?? undefined,
    participants: row.participants ?? [],
    topics: row.topics ?? [],
    linkedFactIds: row.linkedFactIds ?? [],
    parentEpisodeId: row.parentEpisodeId ?? undefined,
    deltaContent: row.deltaContent ?? undefined,
    isRoot: row.isRoot,
    depth: row.depth,
    isSynthetic: row.isSynthetic,
    sourceConversationId: row.sourceConversationId ?? undefined,
    sensitivity: (row.sensitivity ?? "internal") as MnemoEpisode["sensitivity"],
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToEntity(row: schema.SelectEntity): MnemoEntity {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId ?? undefined,
    agentId: row.agentId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    linkedUserId: row.linkedUserId ?? undefined,
    scopeOwner: row.scopeOwner ?? undefined,
    name: row.name,
    kind: row.kind as MnemoEntity["kind"],
    aliases: row.aliases ?? [],
    canonicalId: row.canonicalId ?? undefined,
    description: row.description ?? undefined,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    mentionCount: row.mentionCount,
    sensitivity: (row.sensitivity ?? "internal") as MnemoEntity["sensitivity"],
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToStrategy(row: schema.SelectStrategy): MnemoStrategy {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId ?? undefined,
    actorId: row.actorId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scopeOwner: row.scopeOwner ?? undefined,
    scopeRef: row.scopeRef ?? undefined,
    trigger: row.trigger,
    action: row.action,
    context: row.context ?? undefined,
    relatedFacts: row.relatedFacts ?? [],
    memoryType: "procedural" as const,
    attribution: (row.attribution ?? "inferred") as MnemoStrategy["attribution"],
    successCount: row.successCount,
    failureCount: row.failureCount,
    worth: row.worth ?? 0.5,
    supersedesId: row.supersedesId ?? undefined,
    status: row.status as MnemoStrategy["status"],
    sensitivity: (row.sensitivity ?? "internal") as MnemoStrategy["sensitivity"],
    embeddingModel: row.embeddingModel ?? undefined,
    embeddingStale: row.embeddingStale,
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToWorkflow(row: schema.SelectWorkflow): MnemoWorkflow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId ?? undefined,
    agentId: row.agentId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scopeOwner: row.scopeOwner ?? undefined,
    scopeRef: row.scopeRef ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    steps: (row.steps ?? []) as MnemoWorkflow["steps"],
    avgDurationMs: row.avgDurationMs,
    successRate: row.successRate,
    worth: row.worth ?? 0.5,
    executionCount: row.executionCount,
    lastExecutedAt: row.lastExecutedAt ?? undefined,
    version: row.version,
    previousVersionId: row.previousVersionId ?? undefined,
    status: row.status as MnemoWorkflow["status"],
    sensitivity: (row.sensitivity ?? "internal") as MnemoWorkflow["sensitivity"],
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToSkill(row: schema.SelectSkill): MnemoSkill {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId ?? undefined,
    agentId: row.agentId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scopeOwner: row.scopeOwner ?? undefined,
    name: row.name,
    promptTemplate: row.promptTemplate,
    variables: row.variables ?? [],
    requiredContext: row.requiredContext ?? [],
    qualityScore: row.qualityScore,
    worth: row.worth ?? 0.5,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ?? undefined,
    sensitivity: (row.sensitivity ?? "internal") as MnemoSkill["sensitivity"],
    embeddingModel: row.embeddingModel ?? undefined,
    embeddingStale: row.embeddingStale,
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToTask(row: schema.SelectTask): MnemoTask {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId ?? undefined,
    agentId: row.agentId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scopeOwner: row.scopeOwner ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as MnemoTask["status"],
    priority: row.priority as MnemoTask["priority"],
    assignedTo: row.assignedTo,
    delegatedBy: row.delegatedBy ?? undefined,
    delegatedAt: row.delegatedAt ?? undefined,
    blockedBy: row.blockedBy ?? [],
    subtaskIds: row.subtaskIds ?? [],
    parentTaskId: row.parentTaskId ?? undefined,
    relatedFacts: row.relatedFacts ?? [],
    relatedEntities: row.relatedEntities ?? [],
    sessionId: row.sessionId ?? undefined,
    outcome: row.outcome ?? undefined,
    lessonsLearned: row.lessonsLearned ?? undefined,
    sensitivity: (row.sensitivity ?? "internal") as MnemoTask["sensitivity"],
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    dueAt: row.dueAt ?? undefined,
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToEvent(row: schema.SelectEvent): MnemoEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId ?? undefined,
    actorId: row.actorId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scopeOwner: row.scopeOwner ?? undefined,
    type: row.type as MnemoEvent["type"],
    name: row.name,
    description: row.description,
    occurredAt: row.occurredAt,
    durationS: row.durationS ?? undefined,
    source: row.source,
    relatedEntities: row.relatedEntities ?? [],
    annotations: (row.annotations ?? []) as MnemoEvent["annotations"],
    sensitivity: (row.sensitivity ?? "internal") as MnemoEvent["sensitivity"],
    createdAt: row.createdAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToReasoning(row: schema.SelectReasoning): MnemoReasoning {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId ?? undefined,
    actorId: row.actorId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    scopeOwner: row.scopeOwner ?? undefined,
    question: row.question,
    chain: (row.chain ?? []) as MnemoReasoning["chain"],
    conclusion: row.conclusion,
    successCount: row.successCount,
    failureCount: row.failureCount,
    worth: row.worth ?? 0.5,
    topicKey: row.topicKey ?? undefined,
    embeddingModel: row.embeddingModel ?? undefined,
    embeddingStale: row.embeddingStale,
    status: row.status as MnemoReasoning["status"],
    sensitivity: (row.sensitivity ?? "internal") as MnemoReasoning["sensitivity"],
    lastUsedAt: row.lastUsedAt ?? undefined,
    usageCount: row.usageCount,
    validFrom: row.validFrom,
    validTo: row.validTo ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export function mapRowToRelation(row: schema.SelectRelation): MnemoRelation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    sourceType: row.sourceKind as MnemoRelation["sourceType"],
    targetId: row.targetId,
    targetType: row.targetKind as MnemoRelation["targetType"],
    verb: row.relation as MnemoRelation["verb"],
    weight: row.hebbianWeight,
    lastCoRecallAt: row.lastCoRecallAt ?? undefined,
    coRecallCount: row.coRecallCount,
    directionality: row.directionality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    actorId: row.actorId ?? undefined,
    userId: row.userId ?? undefined,
    actorType: toActorType(row.actorType),
    // flatten-legacy-dual-core D6.4 — the full judgment-workflow overlay,
    // widening PR11's subset (validFrom/validTo/judgmentStatus/reason/
    // confidence/markedByKind/markedByUserId) to every physical column,
    // including the `metadata`→`evidence` bugfix (relations.ts's
    // MnemoRelation doc comment).
    validFrom: row.validFrom,
    validTo: row.validTo,
    judgmentStatus: row.judgmentStatus as MnemoRelation["judgmentStatus"],
    reason: row.reason,
    evidence: row.evidence as Record<string, unknown> | null,
    confidence: row.confidence,
    markedByKind: row.markedByKind as MnemoRelation["markedByKind"],
    markedByUserId: row.markedByUserId,
    markedByModel: row.markedByModel,
    markedByPromptVersion: row.markedByPromptVersion,
    provenance: row.provenance,
    conversationId: row.conversationId,
    supersededByRelationId: row.supersededByRelationId,
  };
}

export function mapRowToCitation(row: schema.SelectCitation): MnemoCitation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    memoryKind: row.memoryKind as CitationMemoryKind,
    memoryId: row.memoryId,
    sourceKind: row.sourceKind as CitationSourceKind,
    sourceId: row.sourceId,
    extractorModel: row.extractorModel,
    extractorPromptVersion: row.extractorPromptVersion,
    judgeModel: row.judgeModel,
    judgeRelationId: row.judgeRelationId,
    evidenceExcerpt: row.evidenceExcerpt,
    createdAt: row.createdAt,
  };
}

export function mapRowToOutbox(row: schema.SelectOutbox | Record<string, unknown>): OutboxEntry {
  // claimOutbox uses tx.execute() (raw SQL) which returns snake_case column names
  // from postgres.js, while db.select() returns camelCase via Drizzle schema mapping.
  // Support both so the mapper works regardless of which query path produced the row.
  const r = row as Record<string, unknown>;
  return {
    id: r["id"] as string,
    workspaceId: (r["workspaceId"] ?? r["workspace_id"]) as string,
    eventType: (r["eventType"] ?? r["event_type"]) as OutboxEntry["eventType"],
    payload: (r["payload"] ?? {}) as Record<string, unknown>,
    createdAt: (r["createdAt"] ?? r["created_at"]) as Date,
    claimedAt: (r["claimedAt"] ?? r["claimed_at"] ?? undefined) as Date | undefined,
    processedAt: (r["processedAt"] ?? r["processed_at"] ?? undefined) as Date | undefined,
    attempts: r["attempts"] as number,
    lastError: (r["lastError"] ?? r["last_error"] ?? undefined) as string | undefined,
  };
}

export function mapRowToWebhookEndpoint(row: schema.SelectWebhookEndpoint): MnemoWebhookEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    events: row.events ?? [],
    secretHash: row.secretHash,
    isActive: row.isActive,
    description: row.description ?? null,
    failureCount: row.failureCount ?? 0,
    disabledAt: row.disabledAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapRowToWebhookDelivery(row: schema.SelectWebhookDelivery): MnemoWebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    workspaceId: row.workspaceId,
    eventType: row.eventType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as MnemoWebhookDelivery["status"],
    responseStatus: row.responseStatus ?? null,
    responseBody: row.responseBody ?? null,
    attempt: row.attempt,
    deliveredAt: row.deliveredAt ?? null,
    nextAttemptAt: row.nextAttemptAt ?? null,
    createdAt: row.createdAt,
  };
}

export function mapRowToReminder(row: schema.SelectReminder): MnemoReminder {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    content: row.content,
    condition: row.condition,
    triggerAt: row.triggerAt ?? null,
    status: row.status as MnemoReminder["status"],
    conditionEmbedding: row.conditionEmbedding
      ? Array.from(row.conditionEmbedding as unknown as number[])
      : null,
    triggeredAt: row.triggeredAt ?? null,
    dismissedAt: row.dismissedAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    actorId: row.actorId ?? undefined,
    userId: row.userId ?? null,
    actorType: toActorType(row.actorType),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, "0");
}

export function compositionRuleRowToDomain(
  row: typeof schema.compositionRuleTable.$inferSelect
): MnemoCompositionRule {
  const out: MnemoCompositionRule = {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    conditionDsl: row.conditionDsl,
    actionDsl: row.actionDsl,
    priority: row.priority,
    isActive: row.isActive,
    executionCount: row.executionCount,
    source: (row.source ?? "manual") as MnemoCompositionRule["source"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.description !== null && row.description !== undefined) out.description = row.description;
  if (row.createdBy !== null && row.createdBy !== undefined) out.createdBy = row.createdBy;
  return out;
}

export function inferenceRowToDomain(
  row: typeof schema.inferenceLogTable.$inferSelect
): MnemoInferenceLogEntry {
  const out: MnemoInferenceLogEntry = {
    id: row.id,
    workspaceId: row.workspaceId,
    ruleId: row.ruleId,
    inputFactIds: row.inputFactIds,
    confidence: parseFloat(row.confidence as string),
    createdAt: row.createdAt,
  };
  if (row.derivedKind !== null && row.derivedKind !== undefined) out.derivedKind = row.derivedKind;
  if (row.derivedId !== null && row.derivedId !== undefined) out.derivedId = row.derivedId;
  if (row.rationale !== null && row.rationale !== undefined) out.rationale = row.rationale;
  if (row.triggeredByQuery !== null && row.triggeredByQuery !== undefined)
    out.triggeredByQuery = row.triggeredByQuery;
  if (row.conversationId !== null && row.conversationId !== undefined)
    out.conversationId = row.conversationId;
  return out;
}

export function factHashRowToDomain(row: typeof schema.factHashTable.$inferSelect): MnemoFactHash {
  return {
    workspaceId: row.workspaceId,
    statementHash: row.statementHash,
    factId: row.factId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    seenCount: row.seenCount,
  };
}

export function hyperedgeRowToDomain(
  row: typeof schema.hyperedgeTable.$inferSelect
): MnemoHyperedge {
  const out: MnemoHyperedge = {
    id: row.id,
    workspaceId: row.workspaceId,
    memberIds: row.memberIds,
    activationCount: row.activationCount,
    worth: row.worth ?? 0.5,
    validFrom: row.validFrom,
    createdAt: row.createdAt,
  };
  if (row.label !== null && row.label !== undefined) out.label = row.label;
  if (row.description !== null && row.description !== undefined) out.description = row.description;
  if (row.contextQuery !== null && row.contextQuery !== undefined)
    out.contextQuery = row.contextQuery;
  if (row.validTo !== null && row.validTo !== undefined) out.validTo = row.validTo;
  if (row.actorId !== null && row.actorId !== undefined) out.actorId = row.actorId;
  if (row.userId !== null && row.userId !== undefined) out.userId = row.userId;
  if (row.actorType !== null && row.actorType !== undefined)
    out.actorType = toActorType(row.actorType);
  return out;
}
