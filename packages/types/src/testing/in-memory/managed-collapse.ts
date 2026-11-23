import type { ManagedCollapsePort, StorageAdapter } from "../../ports.js";
import type { InMemoryStorageState } from "./state.js";
import type { Sensitivity } from "../../common.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import { sha256Hex } from "../../harness.js";
import { factStatementHash } from "../../fact-hash.js";
import { uuid } from "./support.js";

const queues = new WeakMap<InMemoryStorageState, Promise<unknown>>();
function fingerprint(state: InMemoryStorageState): string {
  return JSON.stringify(state, (_key, value: unknown) =>
    value instanceof Map ? [...value.entries()] : value
  );
}
/** The fake uses an isolated snapshot and an optimistic fence for concurrent non-managed writes. */
export function atomicManaged<T>(
  state: InMemoryStorageState,
  apply: (snapshot: InMemoryStorageState) => Promise<T>
): Promise<T> {
  const previous = queues.get(state) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const before = fingerprint(state);
      const snapshot = structuredClone(state);
      const result = await apply(snapshot);
      if (fingerprint(state) !== before)
        throw new Error("Concurrent storage mutation; retry managed collapse");
      Object.assign(state, snapshot);
      return structuredClone(result);
    });
  queues.set(state, run);
  void run
    .finally(() => {
      if (queues.get(state) === run) queues.delete(state);
    })
    .catch(() => undefined);
  return run;
}

export async function commitManagedCollapse(
  state: InMemoryStorageState,
  storage: StorageAdapter,
  input: Parameters<ManagedCollapsePort["commitManagedCollapse"]>[0]
) {
  const { plan, workspaceId, sessionId, operationId, generation, leaseOwner } = input;
  if (
    plan.status === "retryable" ||
    plan.workspaceId !== workspaceId ||
    plan.sessionId !== sessionId ||
    plan.operationId !== operationId ||
    plan.generation !== generation
  )
    throw new Error("Invalid managed operation identity");
  const session = [...state.harnessSessions.values()].find(
    (s) => s.workspaceId === workspaceId && s.id === sessionId && s.generation === generation
  );
  if (!session) throw new Error("Managed session not found");
  const replay = state.managedOperations.get(operationId);
  if (replay) {
    if (
      replay.workspaceId !== workspaceId ||
      replay.sessionId !== sessionId ||
      replay.generation !== generation
    )
      throw new Error("Operation identity conflict");
    return structuredClone(replay.result);
  }
  const checkLease = () => {
    if (
      session.status !== "collapse_pending" ||
      session.leaseOwner !== leaseOwner ||
      !session.leaseExpiresAt ||
      session.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new Error("Stale managed lease");
  };
  checkLease();
  if (session.collapseOperationId && session.collapseOperationId !== operationId)
    throw new Error("Operation identity conflict");
  const corrected = new Set<string>();
  for (const retraction of state.harnessRetractions.filter(
    (r) => r.workspaceId === workspaceId && r.sessionId === sessionId
  )) {
    for (const source of state.managedProvenance.filter(
      (p) =>
        p.workspaceId === workspaceId &&
        p.sessionId === retraction.predecessorSessionId &&
        p.sourceMessageIds.includes(retraction.sourceMessageId) &&
        !p.rejectionReason
    )) {
      const primitive =
        source.primitiveKind === "fact"
          ? state.facts.get(source.primitiveId)
          : source.primitiveKind === "decision"
            ? state.decisions.get(source.primitiveId)
            : source.primitiveKind === "strategy"
              ? state.strategies.get(source.primitiveId)
              : undefined;
      if (
        !primitive ||
        primitive.workspaceId !== workspaceId ||
        primitive.status !== "active" ||
        primitive.validTo
      )
        continue;
      corrected.add(primitive.id);
      state.reviewItems.push({
        workspaceId,
        primitiveId: source.primitiveId,
        primitiveKind: source.primitiveKind,
        reason: "managed_source_retracted",
        detail: {
          sourceMessageId: retraction.sourceMessageId,
          correctionSessionId: sessionId,
          mixedSource: source.sourceMessageIds.length > 1,
          candidate: source.sourceMessageIds.length > 1 ? "review" : "withdrawal",
        },
        createdAt: new Date(),
      });
    }
  }
  if (plan.status === "archive") {
    if (
      !(await storage.finalizeManagedArchive?.({
        workspaceId,
        sessionId,
        leaseOwner,
        operationId,
        reason: plan.reason,
      }))
    )
      throw new Error("Archive lease lost");
    const result = { status: "archived" as const, operationId, sessionId, reason: plan.reason };
    state.managedOperations.set(operationId, { workspaceId, sessionId, generation, result });
    return result;
  }
  const live = new Set(
    state.harnessTurns
      .filter((t) => t.workspaceId === workspaceId && t.sessionId === sessionId && !t.retracted)
      .map((t) => t.sourceMessageId)
  );
  const support = (ids: string[]) => {
    if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !live.has(id)))
      throw new Error("Invalid managed source support");
  };
  support(plan.sourceMessageIds);
  support(plan.episode.sourceMessageIds);
  const seen = new Set<string>([plan.episode.id]);
  for (const candidate of plan.candidates) {
    if (seen.has(candidate.id)) throw new Error("Duplicate candidate ID");
    seen.add(candidate.id);
    support(candidate.sourceMessageIds);
  }
  const max = (...tiers: Sensitivity[]) => {
    if (tiers.some((t) => !Object.hasOwn(SENSITIVITY_ORDER, t)))
      throw new Error("Invalid sensitivity");
    return tiers.reduce((a, b) => (SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b] ? a : b));
  };
  const provenance = {
    workspaceId,
    actorId: session.provenance.actorId,
    actorType: session.provenance.actorType,
    userId: session.provenance.userId ?? undefined,
  };
  const ceiling = session.provenance.sensitivityCeiling;
  const record = (
    kind: string,
    id: string,
    ids: string[],
    sensitivity: Sensitivity,
    extra: Record<string, unknown> = {}
  ) =>
    state.managedProvenance.push({
      workspaceId,
      sessionId,
      operationId,
      primitiveKind: kind,
      primitiveId: id,
      sourceMessageIds: [...ids],
      ...session.provenance,
      sensitivity,
      ...extra,
    });
  const findPrior = (candidate: (typeof plan.candidates)[number]) =>
    candidate.kind === "fact"
      ? [...state.facts.values()].find(
          (f) =>
            candidate.topicKey &&
            f.workspaceId === workspaceId &&
            f.status === "active" &&
            f.topicKey === candidate.topicKey
        )
      : candidate.kind === "decision"
        ? [...state.decisions.values()].find(
            (d) =>
              candidate.topicKey &&
              d.workspaceId === workspaceId &&
              d.status === "active" &&
              d.topicKey?.trim().toLowerCase() === candidate.topicKey.trim().toLowerCase()
          )
        : undefined;
  let scrub = plan.rejectedCandidates.length > 0;
  let episodeSensitivity = max(session.sensitivity, plan.episode.sensitivity);
  for (const candidate of plan.candidates) {
    const prior = findPrior(candidate);
    if (prior?.metadata?.__mnemoConsolidationPending)
      throw new Error("Topic consolidation pending");
    const sensitivity = max(
      session.sensitivity,
      candidate.sensitivity,
      candidate.input.sensitivity ?? "public",
      prior?.sensitivity ?? "public"
    );
    if (SENSITIVITY_ORDER[sensitivity] > SENSITIVITY_ORDER[ceiling]) scrub = true;
    else episodeSensitivity = max(episodeSensitivity, sensitivity);
  }
  if (SENSITIVITY_ORDER[episodeSensitivity] > SENSITIVITY_ORDER[ceiling])
    throw new Error("Episode exceeds ceiling");
  let parentId = scrub ? undefined : plan.episode.input.parentEpisodeId;
  const visited = new Set<string>();
  while (parentId) {
    const parent = state.episodes.get(parentId);
    if (
      visited.has(parentId) ||
      !parent ||
      parent.workspaceId !== workspaceId ||
      SENSITIVITY_ORDER[parent.sensitivity] > SENSITIVITY_ORDER[episodeSensitivity]
    )
      throw new Error("Unsafe delta parent");
    visited.add(parentId);
    parentId = parent.parentEpisodeId;
  }
  const episodeInput = scrub
    ? {
        workspaceId,
        title: "Managed session",
        narrative: "Extraction completed with candidates withheld by sensitivity policy.",
        occurredAt: new Date(),
      }
    : plan.episode.input;
  const safeSummary = scrub
    ? {
        outcome: "completed",
        discoveries: [],
        nextSteps: [],
        relevantEntities: [],
        keyDecisions: [],
      }
    : plan.summary;
  const episode = await storage.createEpisode({
    ...episodeInput,
    ...provenance,
    sensitivity: episodeSensitivity,
    sourceConversationId: sessionId,
    linkedFactIds: [],
    metadata: {
      ...episodeInput.metadata,
      sourceMessageIds: plan.episode.sourceMessageIds,
      collapseOperationId: operationId,
    },
  });
  // PostgreSQL uses mepi_ IDs; keep the managed fake's public result consistent.
  const oldEpisodeId = episode.id;
  episode.id = `mepi_${uuid().replaceAll("-", "").slice(0, 24)}`;
  state.episodes.delete(oldEpisodeId);
  state.episodes.set(episode.id, episode);
  for (const job of state.outbox) if (job.payload.id === oldEpisodeId) job.payload.id = episode.id;
  const ids = new Map<string, string>([[plan.episode.id, episode.id]]);
  const factIds: string[] = [],
    decisionIds: string[] = [],
    strategyIds: string[] = [];
  let rejectedCount = plan.rejectedCandidates.length;
  for (const rejected of plan.rejectedCandidates)
    record(rejected.kind, rejected.id, [], rejected.requestedSensitivity, {
      candidateHash: rejected.contentHash,
      rejectionReason: rejected.reason,
      topicKey: rejected.topicKey,
    });
  for (const candidate of plan.candidates) {
    const prior = findPrior(candidate);
    if (prior && corrected.has(prior.id)) {
      const review = state.reviewItems.find(
        (r) =>
          r.workspaceId === workspaceId &&
          r.primitiveId === prior.id &&
          r.reason === "managed_source_retracted"
      );
      if (review)
        review.detail = {
          ...review.detail,
          replacementCandidateHash: sha256Hex(JSON.stringify(candidate.input)),
          replacementSourceMessageIds: candidate.sourceMessageIds,
        };
      continue;
    }
    const sensitivity = max(
      session.sensitivity,
      candidate.sensitivity,
      candidate.input.sensitivity ?? "public",
      prior?.sensitivity ?? "public"
    );
    if (SENSITIVITY_ORDER[sensitivity] > SENSITIVITY_ORDER[ceiling]) {
      rejectedCount++;
      record(candidate.kind, candidate.id, [], sensitivity, {
        candidateHash: sha256Hex(JSON.stringify(candidate.input)),
        rejectionReason: "sensitivity_ceiling",
        topicKey: candidate.topicKey,
      });
      continue;
    }
    let id: string;
    if (candidate.kind === "fact") {
      const fact = await storage.createFact({
        ...candidate.input,
        ...provenance,
        sensitivity,
        sessionId,
        sourceMessageIds: candidate.sourceMessageIds,
        episodeId: episode.id,
        topicKey: candidate.topicKey,
        extractionSource: "collapse",
      });
      id = fact.id;
      factIds.push(id);
      if (prior && state.facts.has(prior.id)) {
        const previous = state.facts.get(prior.id)!;
        previous.status = "forgotten";
        previous.validTo = new Date();
        previous.updatedAt = new Date();
        for (const key of [
          "scope",
          "scopeRef",
          "scopeOwner",
          "worthAlpha",
          "worthBeta",
          "worthSuccess",
          "worthFailure",
          "worth",
          "pinned",
          "canonical",
          "memoryType",
          "memoryStrength",
          "memoryStability",
        ] as const)
          Object.assign(fact, { [key]: previous[key] });
        fact.revisionCount = previous.revisionCount + 1;
        state.factLsh.delete(`${workspaceId}:${previous.id}`);
        state.queryCache = state.queryCache.filter((c) => c.workspaceId !== workspaceId);
        const hash = factStatementHash(fact.statement, fact.subject);
        state.factHashes.set(`${workspaceId}:${hash}`, {
          workspaceId,
          statementHash: hash,
          factId: id,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          seenCount: 1,
        });
      }
    } else if (candidate.kind === "decision") {
      const decision = await storage.createDecision({
        ...candidate.input,
        ...provenance,
        sensitivity,
        topicKey: candidate.topicKey,
      });
      id = decision.id;
      decisionIds.push(id);
      if (prior && state.decisions.has(prior.id)) {
        const previous = state.decisions.get(prior.id)!;
        previous.status = "superseded";
        previous.validTo = new Date();
        previous.supersededById = id;
        decision.revisionCount = previous.revisionCount + 1;
        decision.scopeOwner = previous.scopeOwner;
      }
    } else {
      const strategy = await storage.createStrategy({
        ...candidate.input,
        ...provenance,
        sensitivity,
      });
      id = strategy.id;
      strategyIds.push(id);
    }
    ids.set(candidate.id, id);
    record(candidate.kind, id, candidate.sourceMessageIds, sensitivity);
    if (prior && candidate.kind !== "strategy") {
      await storage.createRelation({
        workspaceId,
        sourceType: candidate.kind,
        targetType: candidate.kind,
        sourceId: id,
        targetId: prior.id,
        verb: "supersedes",
      });
      state.outbox.push({
        id: uuid(),
        workspaceId,
        eventType: "vector_delete",
        payload: { id: prior.id, kind: candidate.kind },
        createdAt: new Date(),
        processedAt: undefined,
        attempts: 0,
      });
    }
  }
  for (const relation of plan.relations) {
    const sourceId = ids.get(relation.sourceId),
      targetId = ids.get(relation.targetId);
    if (sourceId && targetId)
      await storage.createRelation({
        workspaceId,
        sourceId,
        targetId,
        sourceType: "fact",
        targetType: "fact",
        verb: relation.verb,
      });
  }
  for (const hyperedge of plan.hyperedges) {
    const memberIds = hyperedge.memberIds.flatMap((id) => ids.get(id) ?? []);
    if (memberIds.length >= 3)
      await storage.createHyperedge({
        memberIds,
        label: hyperedge.label,
        description: hyperedge.description,
        ...provenance,
      });
  }
  for (const update of plan.worthUpdates) {
    const id = ids.get(update.factId) ?? update.factId;
    const fact = state.facts.get(id);
    if (
      fact &&
      fact.workspaceId === workspaceId &&
      SENSITIVITY_ORDER[fact.sensitivity] <= SENSITIVITY_ORDER[ceiling]
    )
      await storage.updateWorth(id, workspaceId, "fact", update.delta);
  }
  const linked = [...state.facts.values()].filter(
    (f) =>
      f.workspaceId === workspaceId &&
      f.sessionId === sessionId &&
      f.status === "active" &&
      SENSITIVITY_ORDER[f.sensitivity] <= SENSITIVITY_ORDER[episodeSensitivity]
  );
  for (const fact of linked) if (!fact.episodeId) fact.episodeId = episode.id;
  episode.linkedFactIds = linked.map((f) => f.id);
  record("episode", episode.id, plan.episode.sourceMessageIds, episodeSensitivity);
  for (const current of state.harnessSessions.values()) {
    if (current.workspaceId !== workspaceId || !current.predecessorSessionId) continue;
    const child =
      current.id === sessionId
        ? episode
        : [...state.episodes.values()].find(
            (e) => e.workspaceId === workspaceId && e.sourceConversationId === current.id
          );
    const parent = [...state.episodes.values()].find(
      (e) =>
        e.workspaceId === workspaceId && e.sourceConversationId === current.predecessorSessionId
    );
    if (
      child &&
      parent &&
      ![...state.relations.values()].some(
        (r) =>
          r.workspaceId === workspaceId &&
          r.sourceId === child.id &&
          r.targetId === parent.id &&
          r.verb === "derived_from"
      )
    )
      await storage.createRelation({
        workspaceId,
        sourceType: "episode",
        targetType: "episode",
        sourceId: child.id,
        targetId: parent.id,
        verb: "derived_from",
      });
  }
  await storage.incrementWorkspaceModeCounters!(workspaceId, {
    factCount: factIds.length,
    sessionCount: 1,
  });
  if (plan.counters.reflectionAgentId)
    await storage.incrementSessionsSinceReflection(workspaceId, plan.counters.reflectionAgentId);
  for (const effect of plan.postCommitEffects) {
    const targetId = ids.get(effect.targetId) ?? effect.targetId;
    if (seen.has(effect.targetId) && !ids.has(effect.targetId)) continue;
    if (
      !state.managedCollapseEffects.some(
        (e) =>
          e.operationId === operationId &&
          e.effectKind === effect.effectKind &&
          e.targetId === targetId
      )
    )
      state.managedCollapseEffects.push({
        workspaceId,
        operationId,
        sessionId,
        effectKind: effect.effectKind,
        targetKind: effect.targetKind,
        targetId,
        payload: effect.payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        completedAt: null,
        lastError: null,
      });
  }
  checkLease();
  session.status = "collapsed";
  session.collapsedAt = new Date();
  session.collapseOperationId = operationId;
  session.leased = false;
  session.leaseOwner = null;
  session.leaseExpiresAt = null;
  session.collapseNextAttemptAt = null;
  const row = state.sessions.get(sessionId)!;
  row.status = "collapsed";
  row.collapsedAt = session.collapsedAt;
  row.metadata = {
    ...row.metadata,
    factCount: factIds.length,
    contextSnapshot: { ...safeSummary, episodeId: episode.id },
  };
  const result = {
    status: "collapsed" as const,
    operationId,
    sessionId,
    episodeId: episode.id,
    factIds,
    decisionIds,
    strategyIds,
    rejectedCount,
  };
  state.managedOperations.set(operationId, { workspaceId, sessionId, generation, result });
  return result;
}
