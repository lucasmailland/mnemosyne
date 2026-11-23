import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { SENSITIVITY_ORDER, factStatementHash } from "@mnemo-ai/types";
import type {
  ManagedCollapsePort,
  ManagedCollapseCommitResult,
  ManagedCollapseCandidate,
  ManagedPreparedCollapsePlan,
  Sensitivity,
  StorageAdapter,
  CreateFactInput,
} from "@mnemo-ai/types";
import * as schema from "../schema/index.js";
import type { DrizzleClient } from "./types.js";

type Tx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];
type Input = Parameters<ManagedCollapsePort["commitManagedCollapse"]>[0];
type TopicPredecessor = {
  id: string;
  sensitivity: Sensitivity;
  revision_count: number;
  scope: CreateFactInput["scope"] | null;
  scope_ref: string | null;
  scope_owner: string | null;
  topic_key: string;
  metadata: Record<string, unknown>;
};
async function lockTopic(
  tx: Tx,
  workspaceId: string,
  kind: "fact" | "decision",
  topicKey: string
): Promise<TopicPredecessor | undefined> {
  const table = kind === "fact" ? sql`mnemosyne.mnemo_fact` : sql`mnemosyne.mnemo_decision`;
  const scope = kind === "fact" ? sql`scope` : sql`NULL::text`;
  const found =
    await tx.execute(sql`SELECT id,sensitivity,revision_count,scope_ref,scope_owner,topic_key,metadata,${scope} AS scope FROM ${table}
    WHERE workspace_id=${workspaceId} AND lower(btrim(topic_key))=${topicKey.trim().toLowerCase()}
      AND status='active' AND valid_to IS NULL FOR UPDATE`);
  if (found.length > 1) throw new Error("Ambiguous managed topic identity");
  const predecessor = found[0] as TopicPredecessor | undefined;
  if (predecessor && Object.hasOwn(predecessor.metadata ?? {}, "__mnemoConsolidationPending"))
    throw new Error("Managed topic is awaiting consolidation");
  return predecessor;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function ceiling(...values: Sensitivity[]): Sensitivity {
  if (values.some((value) => !Object.hasOwn(SENSITIVITY_ORDER, value)))
    throw new Error("Invalid managed sensitivity");
  return values.reduce((a, b) => (SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b] ? a : b));
}

/** Every delegated repository receives this transaction, never the connection pool. */
export class ManagedCollapseRepository implements ManagedCollapsePort {
  constructor(
    private readonly db: DrizzleClient,
    private readonly scoped: (tx: Tx) => StorageAdapter
  ) {}

  async commitManagedCollapse(input: Input): Promise<ManagedCollapseCommitResult> {
    const { workspaceId, sessionId, operationId, generation, leaseOwner, plan } = input;
    if (
      plan.status === "retryable" ||
      !operationId ||
      !leaseOwner ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      plan.workspaceId !== workspaceId ||
      plan.sessionId !== sessionId ||
      plan.generation !== generation ||
      plan.operationId !== operationId
    )
      throw new Error("Invalid managed collapse plan identity");
    return this.db.transaction(async (tx) => {
      const membership = (
        await tx.execute(sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`)
      )[0];
      if (membership?.m) await tx.execute(sql`SET LOCAL ROLE app_user`);
      else {
        const role = (
          await tx.execute(
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )[0];
        if (!role || role.rolsuper || role.rolbypassrls)
          throw new Error("Unsafe managed database role");
      }
      await tx.execute(sql`SET LOCAL search_path TO mnemosyne, public`);
      await tx.execute(
        sql`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('mnemosyne.workspace_id', ${workspaceId}, true)`
      );
      // Share the ingestion/quiescence fence, including ordering-sensitive lineage work.
      await tx
        .insert(schema.harnessWorkspaceControlTable)
        .values({ workspaceId })
        .onConflictDoNothing();
      await tx.execute(
        sql`SELECT workspace_id FROM mnemosyne.mnemo_harness_workspace_control WHERE workspace_id = ${workspaceId} FOR UPDATE`
      );
      const session = (
        await tx
          .select()
          .from(schema.sessionTable)
          .where(
            and(
              eq(schema.sessionTable.workspaceId, workspaceId),
              eq(schema.sessionTable.id, sessionId)
            )
          )
          .for("update")
      )[0];
      if (!session || !session.sourceHost || session.sourceGeneration !== generation)
        throw new Error("Managed session unavailable");
      const operations = await tx
        .select()
        .from(schema.managedCollapseOperationTable)
        .where(
          and(
            eq(schema.managedCollapseOperationTable.workspaceId, workspaceId),
            eq(schema.managedCollapseOperationTable.sessionId, sessionId),
            eq(schema.managedCollapseOperationTable.sourceGeneration, generation)
          )
        )
        .for("update");
      const operation = operations[0];
      if (operation && operation.operationId !== operationId)
        throw new Error("Managed operation identity conflict");
      if (operation?.status === "committed") return operation.result as ManagedCollapseCommitResult;
      // This statement executes after all fence/session/operation lock waits.
      const live = (
        await tx.execute(sql`SELECT id FROM mnemosyne.mnemo_session
        WHERE workspace_id=${workspaceId} AND id=${sessionId} AND status='collapse_pending'
          AND collapse_lease_owner=${leaseOwner} AND collapse_lease_expires_at>clock_timestamp()`)
      )[0];
      if (!live) throw new Error("Managed collapse lease was lost");
      const provenance = plan.provenance;
      if (
        provenance.actorId !== session.originActorId ||
        provenance.actorType !== session.originActorType ||
        (provenance.userId ?? null) !== session.originUserId ||
        provenance.sensitivityCeiling !== session.originSensitivityCeiling ||
        plan.sensitivity !== session.sensitivity
      )
        throw new Error("Managed provenance mismatch");
      ceiling(plan.sensitivity, provenance.sensitivityCeiling);
      if (SENSITIVITY_ORDER[plan.sensitivity] > SENSITIVITY_ORDER[provenance.sensitivityCeiling])
        throw new Error("Managed sensitivity ceiling violation");
      const liveTurns = await tx
        .select({ sourceMessageId: schema.sessionTurnTable.sourceMessageId })
        .from(schema.sessionTurnTable)
        .where(
          and(
            eq(schema.sessionTurnTable.workspaceId, workspaceId),
            eq(schema.sessionTurnTable.sessionId, sessionId),
            sql`${schema.sessionTurnTable.retractedAt} IS NULL`
          )
        );
      const sourceIds = new Set(liveTurns.map((turn) => turn.sourceMessageId));
      const validateSupport = (ids: string[]) => {
        if (
          !Array.isArray(ids) ||
          ids.some((id) => typeof id !== "string" || !sourceIds.has(id)) ||
          new Set(ids).size !== ids.length
        )
          throw new Error("Invalid managed extraction support");
      };
      validateSupport(plan.sourceMessageIds);
      if (plan.status === "prepared" && sourceIds.size > 0 && plan.sourceMessageIds.length === 0)
        throw new Error("Prepared collapse has no source support");
      if (!operation)
        await tx.insert(schema.managedCollapseOperationTable).values({
          operationId,
          workspaceId,
          sessionId,
          sourceGeneration: generation,
          leaseOwner,
          status: "prepared",
        });
      const storage = this.scoped(tx);
      let result: ManagedCollapseCommitResult;
      const mapped = new Map<string, string>();
      if (plan.status === "prepared") {
        validateSupport(plan.episode.sourceMessageIds);
        if (sourceIds.size > 0 && plan.episode.sourceMessageIds.length === 0)
          throw new Error("Episode has no source support");
        const ids = new Set([plan.episode.id]);
        for (const candidate of plan.candidates) {
          if (ids.has(candidate.id)) throw new Error("Duplicate managed candidate identity");
          ids.add(candidate.id);
          validateSupport(candidate.sourceMessageIds);
          if (candidate.sourceMessageIds.length === 0)
            throw new Error("Candidate has no source support");
          if (candidate.input.workspaceId !== workspaceId)
            throw new Error("Candidate workspace mismatch");
        }
        result = await this.persistPrepared(
          tx,
          storage,
          input,
          plan,
          session.predecessorSessionId,
          mapped
        );
      } else {
        result = { status: "archived", operationId, sessionId, reason: plan.reason };
        await this.corrections(tx, workspaceId, sessionId, operationId, new Map());
      }
      const candidateIds = new Set(
        plan.status === "prepared" ? plan.candidates.map((candidate) => candidate.id) : []
      );
      const remap = (value: unknown): unknown => {
        if (typeof value === "string")
          return mapped.get(value) ?? (candidateIds.has(value) ? undefined : value);
        if (Array.isArray(value)) return value.map(remap).filter((entry) => entry !== undefined);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .map(([key, entry]) => [key, remap(entry)])
              .filter(([, entry]) => entry !== undefined)
          );
        return value;
      };
      const effects = [
        ...plan.postCommitEffects.filter(
          (effect) => !candidateIds.has(effect.targetId) || mapped.has(effect.targetId)
        ),
        {
          effectKind: "lifecycle_event",
          targetKind: "session",
          targetId: sessionId,
          payload: { event: `session.${result.status}`, ...result },
        },
        {
          effectKind: "metrics",
          targetKind: "session",
          targetId: sessionId,
          payload: { status: result.status },
        },
        {
          effectKind: "redis_cleanup",
          targetKind: "session",
          targetId: sessionId,
          payload: { sessionId },
        },
      ];
      for (const effect of effects)
        await tx
          .insert(schema.managedCollapseEffectTable)
          .values({
            workspaceId,
            collapseOperationId: operationId,
            effectKind: effect.effectKind,
            targetKind: effect.targetKind,
            targetId: mapped.get(effect.targetId) ?? effect.targetId,
            payload: { ...(remap(effect.payload) as Record<string, unknown>), operationId },
          })
          .onConflictDoNothing();
      const terminal = result.status;
      const summary =
        result.status === "collapsed" && plan.status === "prepared"
          ? result.rejectedCount > 0
            ? {
                outcome: "completed",
                discoveries: [],
                keyDecisions: [],
                nextSteps: [],
                relevantEntities: [],
                episodeId: result.episodeId,
              }
            : { ...plan.summary, episodeId: result.episodeId }
          : {};
      const updated = await tx.execute(sql`UPDATE mnemosyne.mnemo_session SET status=${terminal},
        collapsed_at=CASE WHEN ${terminal}='collapsed' THEN clock_timestamp() ELSE collapsed_at END,
        archived_at=CASE WHEN ${terminal}='archived' THEN clock_timestamp() ELSE NULL END,
        archive_reason=${result.status === "archived" ? result.reason : null},
        fact_count=${result.status === "collapsed" ? result.factIds.length : 0},
        context_snapshot=${JSON.stringify(summary)}::jsonb,
        metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ collapseSummary: summary })}::jsonb,
        collapse_operation_id=${operationId}, collapse_lease_owner=NULL, collapse_lease_expires_at=NULL,
        collapse_next_attempt_at=NULL
        WHERE workspace_id=${workspaceId} AND id=${sessionId} AND source_generation=${generation}
          AND status='collapse_pending' AND collapse_lease_owner=${leaseOwner}
          AND collapse_lease_expires_at>clock_timestamp() RETURNING id`);
      if (updated.length !== 1) throw new Error("Managed collapse lease was lost");
      await tx
        .update(schema.managedCollapseOperationTable)
        .set({ status: "committed", result, leaseOwner, committedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(schema.managedCollapseOperationTable.operationId, operationId),
            eq(schema.managedCollapseOperationTable.workspaceId, workspaceId)
          )
        );
      return result;
    });
  }

  private async persistPrepared(
    tx: Tx,
    storage: StorageAdapter,
    input: Input,
    plan: ManagedPreparedCollapsePlan,
    predecessorSessionId: string | null,
    mapped: Map<string, string>
  ): Promise<Extract<ManagedCollapseCommitResult, { status: "collapsed" }>> {
    const { workspaceId, sessionId, operationId } = input;
    const origin = {
      actorId: plan.provenance.actorId,
      actorType: plan.provenance.actorType,
      userId: plan.provenance.userId,
      workspaceId,
    };
    const limit = plan.provenance.sensitivityCeiling;
    const stamp = (sourceMessageIds: string[], sensitivity: Sensitivity) => ({
      collapseOperationId: operationId,
      sourceMessageIds,
      sensitivity,
      sensitivityCeiling: limit,
      sessionId,
      ...origin,
    });
    const provenance = async (
      kind: string,
      id: string,
      support: string[],
      sensitivity: Sensitivity,
      candidateHash?: string,
      rejectionReason?: string
    ) => {
      await tx.insert(schema.extractionProvenanceTable).values({
        workspaceId,
        collapseOperationId: operationId,
        sessionId,
        primitiveKind: kind,
        primitiveId: id,
        sourceMessageIds: support,
        originActorId: origin.actorId,
        originActorType: origin.actorType,
        originUserId: origin.userId,
        sensitivity,
        sensitivityCeiling: limit,
        candidateHash,
        rejectionReason,
      });
    };
    const rejected = new Set<string>();
    const correctionTargets = await tx.execute(sql`SELECT DISTINCT p.primitive_kind,p.primitive_id
      FROM mnemosyne.mnemo_harness_retraction r JOIN mnemosyne.mnemo_extraction_provenance p
        ON p.workspace_id=r.workspace_id AND p.session_id=r.predecessor_session_id
        AND r.source_message_id=ANY(p.source_message_ids)
      WHERE r.workspace_id=${workspaceId} AND r.session_id=${sessionId} AND p.rejection_reason IS NULL`);
    const correctionIds = new Set(
      correctionTargets.map((row) => `${row.primitive_kind}:${row.primitive_id}`)
    );
    const replacementCandidates = new Map<
      string,
      { candidateHash: string; sourceMessageIds: string[] }
    >();
    const accepted: Array<{
      candidate: ManagedCollapseCandidate;
      sensitivity: Sensitivity;
      predecessor?: TopicPredecessor;
    }> = [];
    for (const candidate of plan.candidates) {
      let sensitivity = ceiling(
        plan.sensitivity,
        candidate.sensitivity,
        candidate.input.sensitivity ?? candidate.sensitivity
      );
      let predecessor: TopicPredecessor | undefined;
      const topicKey =
        candidate.topicKey ??
        ("topicKey" in candidate.input ? candidate.input.topicKey : undefined);
      if (topicKey && candidate.kind !== "strategy") {
        predecessor = await lockTopic(tx, workspaceId, candidate.kind, topicKey);
        if (predecessor) sensitivity = ceiling(sensitivity, predecessor.sensitivity);
      }
      if (SENSITIVITY_ORDER[sensitivity] > SENSITIVITY_ORDER[limit]) {
        rejected.add(candidate.id);
        await provenance(
          candidate.kind,
          digest(candidate.id),
          [],
          sensitivity,
          digest(candidate.input),
          "sensitivity_ceiling"
        );
      } else if (predecessor && correctionIds.has(`${candidate.kind}:${predecessor.id}`)) {
        // Corrections propose knowledge changes for review; they never close a current source.
        rejected.add(candidate.id);
        replacementCandidates.set(`${candidate.kind}:${predecessor.id}`, {
          candidateHash: digest(candidate.input),
          sourceMessageIds: candidate.sourceMessageIds,
        });
        await provenance(
          candidate.kind,
          digest(candidate.id),
          candidate.sourceMessageIds,
          sensitivity,
          digest(candidate.input),
          "source_retracted"
        );
      } else accepted.push({ candidate, sensitivity, predecessor });
    }
    for (const candidate of plan.rejectedCandidates)
      await provenance(
        candidate.kind,
        digest(candidate.id),
        [],
        candidate.requestedSensitivity,
        candidate.contentHash,
        candidate.reason
      );
    const sessionFacts = await tx
      .select({ id: schema.factTable.id, sensitivity: schema.factTable.sensitivity })
      .from(schema.factTable)
      .where(
        and(
          eq(schema.factTable.workspaceId, workspaceId),
          eq(schema.factTable.sessionId, sessionId),
          sql`${schema.factTable.episodeId} IS NULL`
        )
      )
      .for("update");
    const linkable = sessionFacts.filter(
      (fact) => SENSITIVITY_ORDER[fact.sensitivity as Sensitivity] <= SENSITIVITY_ORDER[limit]
    );
    let episodeSensitivity = ceiling(
      plan.sensitivity,
      plan.episode.sensitivity,
      plan.episode.input.sensitivity ?? plan.episode.sensitivity,
      ...accepted.map((entry) => entry.sensitivity),
      ...linkable.map((fact) => fact.sensitivity as Sensitivity)
    );
    const redactEnrichment = rejected.size > 0 || plan.rejectedCandidates.length > 0;
    let parentId = redactEnrichment ? undefined : plan.episode.input.parentEpisodeId;
    const ancestors = new Set<string>();
    while (parentId) {
      if (ancestors.has(parentId) || ancestors.size >= 100)
        throw new Error("Invalid delta episode chain");
      ancestors.add(parentId);
      const parent = (
        await tx
          .select({
            parentEpisodeId: schema.episodeTable.parentEpisodeId,
            sensitivity: schema.episodeTable.sensitivity,
          })
          .from(schema.episodeTable)
          .where(
            and(
              eq(schema.episodeTable.workspaceId, workspaceId),
              eq(schema.episodeTable.id, parentId)
            )
          )
          .for("update")
      )[0];
      if (!parent) throw new Error("Delta episode parent unavailable");
      episodeSensitivity = ceiling(episodeSensitivity, parent.sensitivity as Sensitivity);
      parentId = parent.parentEpisodeId ?? undefined;
    }
    if (SENSITIVITY_ORDER[episodeSensitivity] > SENSITIVITY_ORDER[limit])
      throw new Error("Episode sensitivity ceiling violation");
    const episode = await storage.createEpisode({
      ...(redactEnrichment
        ? {
            title: "Managed session",
            narrative: "Extraction completed; some candidates require review.",
            occurredAt: plan.episode.input.occurredAt,
          }
        : plan.episode.input),
      ...origin,
      sensitivity: episodeSensitivity,
      sourceConversationId: sessionId,
      linkedFactIds: [],
      metadata: {
        ...(redactEnrichment ? {} : plan.episode.input.metadata),
        managedExtraction: stamp(plan.episode.sourceMessageIds, episodeSensitivity),
      },
    });
    mapped.set(plan.episode.id, episode.id);
    await provenance("episode", episode.id, plan.episode.sourceMessageIds, episodeSensitivity);
    const factIds: string[] = [],
      decisionIds: string[] = [],
      strategyIds: string[] = [];
    for (const entry of accepted.sort(
      (a, b) =>
        (a.candidate.kind === "strategy" ? 1 : 0) - (b.candidate.kind === "strategy" ? 1 : 0)
    )) {
      const { candidate } = entry;
      let { sensitivity, predecessor } = entry;
      const topicKey =
        candidate.topicKey ??
        ("topicKey" in candidate.input ? candidate.input.topicKey : undefined);
      if (candidate.kind !== "strategy" && topicKey) {
        predecessor = await lockTopic(tx, workspaceId, candidate.kind, topicKey);
        if (predecessor) sensitivity = ceiling(sensitivity, predecessor.sensitivity);
      }
      const transitionAt = new Date(
        String(
          (
            await tx.execute(sql`SELECT date_trunc('milliseconds',clock_timestamp())::text AS now`)
          )[0]!.now
        )
      );
      if (predecessor && candidate.kind !== "strategy") {
        const table =
          candidate.kind === "fact" ? sql`mnemosyne.mnemo_fact` : sql`mnemosyne.mnemo_decision`;
        await tx.execute(sql`UPDATE ${table} SET status=${candidate.kind === "fact" ? "forgotten" : "superseded"}, valid_to=${transitionAt.toISOString()}::timestamptz, updated_at=${transitionAt.toISOString()}::timestamptz
          WHERE workspace_id=${workspaceId} AND id=${predecessor.id} AND status='active' AND valid_to IS NULL`);
      }
      const metadata = {
        ...candidate.input.metadata,
        managedExtraction: stamp(candidate.sourceMessageIds, sensitivity),
      };
      let id: string;
      if (candidate.kind === "fact") {
        const fact = await storage.createFact({
          ...candidate.input,
          ...origin,
          sensitivity,
          metadata,
          validFrom: transitionAt,
          validTo: undefined,
          scope: predecessor?.scope ?? candidate.input.scope,
          scopeRef: predecessor ? (predecessor.scope_ref ?? undefined) : candidate.input.scopeRef,
          scopeOwner: predecessor
            ? (predecessor.scope_owner ?? undefined)
            : candidate.input.scopeOwner,
          topicKey: predecessor?.topic_key ?? candidate.topicKey ?? candidate.input.topicKey,
          sessionId,
          episodeId: episode.id,
          sourceMessageIds: candidate.sourceMessageIds,
          extractionSource: "collapse",
          // Asked for with the row, never patched onto it afterwards: mnemo_outbox
          // grants mnemo_app_role SELECT/INSERT only (0001 baseline), so an UPDATE
          // here fails with 42501 under the non-bypass role withMnemoTx installs.
          // A successor indexes at its own revision, which the block below also
          // writes to mnemo_fact.revision_count.
          vectorJob: {
            indexLsh: true,
            operationId,
            revision: predecessor ? predecessor.revision_count + 1 : 1,
          },
        });
        id = fact.id;
        factIds.push(id);
        await storage.upsertFactHash({
          workspaceId,
          factId: id,
          statementHash: factStatementHash(candidate.input.statement, candidate.input.subject),
        });
      } else if (candidate.kind === "decision") {
        const decision = await storage.createDecision({
          ...candidate.input,
          ...origin,
          sensitivity,
          metadata,
          validFrom: transitionAt,
          scopeRef: predecessor ? (predecessor.scope_ref ?? undefined) : candidate.input.scopeRef,
          scopeOwner: predecessor
            ? (predecessor.scope_owner ?? undefined)
            : candidate.input.scopeOwner,
          topicKey: predecessor?.topic_key ?? candidate.topicKey ?? candidate.input.topicKey,
          conversationId: sessionId,
        });
        id = decision.id;
        decisionIds.push(id);
      } else {
        const relatedFacts: string[] = [];
        for (const target of candidate.input.relatedFacts ?? []) {
          if (rejected.has(target)) continue;
          const relatedId = mapped.get(target) ?? target;
          const related = (
            await tx
              .select({ sensitivity: schema.factTable.sensitivity })
              .from(schema.factTable)
              .where(
                and(
                  eq(schema.factTable.workspaceId, workspaceId),
                  eq(schema.factTable.id, relatedId)
                )
              )
              .for("update")
          )[0];
          if (
            !related ||
            SENSITIVITY_ORDER[related.sensitivity as Sensitivity] > SENSITIVITY_ORDER[sensitivity]
          )
            throw new Error("Strategy fact support unavailable");
          relatedFacts.push(relatedId);
        }
        const strategy = await storage.createStrategy({
          ...candidate.input,
          ...origin,
          sensitivity,
          metadata,
          validFrom: transitionAt,
          relatedFacts,
        });
        id = strategy.id;
        strategyIds.push(id);
      }
      mapped.set(candidate.id, id);
      await provenance(candidate.kind, id, candidate.sourceMessageIds, sensitivity);
      if (predecessor && candidate.kind !== "strategy") {
        const table =
          candidate.kind === "fact" ? sql`mnemosyne.mnemo_fact` : sql`mnemosyne.mnemo_decision`;
        await tx.execute(
          sql`UPDATE ${table} SET revision_count=${predecessor.revision_count + 1} WHERE workspace_id=${workspaceId} AND id=${id}`
        );
        if (candidate.kind === "decision")
          await tx
            .update(schema.decisionTable)
            .set({ supersededById: id })
            .where(
              and(
                eq(schema.decisionTable.workspaceId, workspaceId),
                eq(schema.decisionTable.id, predecessor.id)
              )
            );
        if (candidate.kind === "fact") {
          await tx.execute(sql`UPDATE mnemosyne.mnemo_fact successor SET
            worth_success=previous.worth_success, worth_failure=previous.worth_failure,
            worth_alpha=previous.worth_alpha, worth_beta=previous.worth_beta,
            memory_strength=previous.memory_strength, memory_stability=previous.memory_stability,
            pinned=previous.pinned, canonical=previous.canonical
            FROM mnemosyne.mnemo_fact previous WHERE successor.workspace_id=${workspaceId}
              AND previous.workspace_id=${workspaceId} AND successor.id=${id} AND previous.id=${predecessor.id}`);
        }
        await storage.createRelation({
          ...origin,
          sourceId: id,
          sourceType: candidate.kind,
          targetId: predecessor.id,
          targetType: candidate.kind,
          verb: "supersedes",
        });
        if (candidate.kind === "fact") {
          await tx
            .delete(schema.factLshTable)
            .where(
              and(
                eq(schema.factLshTable.workspaceId, workspaceId),
                eq(schema.factLshTable.factId, predecessor.id)
              )
            );
          await tx
            .delete(schema.factHashTable)
            .where(
              and(
                eq(schema.factHashTable.workspaceId, workspaceId),
                eq(schema.factHashTable.factId, predecessor.id)
              )
            );
        }
        await tx.insert(schema.outboxTable).values({
          workspaceId,
          eventType: "vector_delete",
          payload: { id: predecessor.id, kind: candidate.kind },
        });
      }
    }
    const resolveFact = async (id: string): Promise<string | null> => {
      if (rejected.has(id)) return null;
      const actual = mapped.get(id) ?? id;
      const fact = (
        await tx
          .select({ id: schema.factTable.id, sensitivity: schema.factTable.sensitivity })
          .from(schema.factTable)
          .where(
            and(eq(schema.factTable.workspaceId, workspaceId), eq(schema.factTable.id, actual))
          )
          .for("update")
      )[0];
      if (!fact || SENSITIVITY_ORDER[fact.sensitivity as Sensitivity] > SENSITIVITY_ORDER[limit])
        throw new Error("Managed fact target unavailable");
      return actual;
    };
    for (const relation of plan.relations) {
      const sourceId = await resolveFact(relation.sourceId),
        targetId = await resolveFact(relation.targetId);
      if (sourceId && targetId)
        await storage.createRelation({ ...relation, ...origin, sourceId, targetId });
    }
    for (const hyperedge of plan.hyperedges) {
      const members = await Promise.all(hyperedge.memberIds.map(resolveFact));
      if (members.every((id): id is string => id !== null))
        await storage.createHyperedge({ ...hyperedge, ...origin, memberIds: members });
    }
    for (const worth of plan.worthUpdates) {
      const id = await resolveFact(worth.factId);
      if (id) await storage.updateWorth(id, workspaceId, "fact", worth.delta);
    }
    for (const fact of linkable)
      await tx
        .update(schema.factTable)
        .set({ episodeId: episode.id })
        .where(
          and(eq(schema.factTable.workspaceId, workspaceId), eq(schema.factTable.id, fact.id))
        );
    await tx
      .update(schema.episodeTable)
      .set({ linkedFactIds: [...new Set([...factIds, ...linkable.map((fact) => fact.id)])] })
      .where(
        and(
          eq(schema.episodeTable.workspaceId, workspaceId),
          eq(schema.episodeTable.id, episode.id)
        )
      );
    await storage.incrementWorkspaceModeCounters?.(workspaceId, {
      factCount: factIds.length,
      sessionCount: 1,
    });
    if (plan.counters.reflectionAgentId)
      await storage.incrementSessionsSinceReflection?.(
        workspaceId,
        plan.counters.reflectionAgentId
      );
    await tx
      .delete(schema.queryCacheTable)
      .where(eq(schema.queryCacheTable.workspaceId, workspaceId));
    await tx.insert(schema.outboxTable).values({
      workspaceId,
      eventType: "cache_bust",
      payload: { pattern: `mnemo:${workspaceId}:*` },
    });
    // The workspace fence serializes both completion orders. Never rewrite episodes.
    const lineage =
      await tx.execute(sql`SELECT predecessor.id AS predecessor_episode, successor.id AS successor_episode
      FROM mnemosyne.mnemo_session s JOIN mnemosyne.mnemo_episode successor
        ON successor.workspace_id=s.workspace_id AND successor.source_conversation_id=s.id
      JOIN mnemosyne.mnemo_episode predecessor ON predecessor.workspace_id=s.workspace_id
        AND predecessor.source_conversation_id=s.predecessor_session_id
      WHERE s.workspace_id=${workspaceId} AND (s.id=${sessionId} OR s.predecessor_session_id=${sessionId})`);
    for (const link of lineage) {
      const present =
        await tx.execute(sql`SELECT id FROM mnemosyne.mnemo_relation WHERE workspace_id=${workspaceId}
        AND source_id=${String(link.successor_episode)} AND target_id=${String(link.predecessor_episode)} AND relation='derived_from'`);
      if (!present.length)
        await storage.createRelation({
          ...origin,
          sourceId: String(link.successor_episode),
          sourceType: "episode",
          targetId: String(link.predecessor_episode),
          targetType: "episode",
          verb: "derived_from",
        });
    }
    await this.corrections(tx, workspaceId, sessionId, operationId, replacementCandidates);
    return {
      status: "collapsed",
      operationId,
      sessionId,
      episodeId: episode.id,
      factIds,
      decisionIds,
      strategyIds,
      rejectedCount: rejected.size + plan.rejectedCandidates.length,
    };
  }

  private async corrections(
    tx: Tx,
    workspaceId: string,
    sessionId: string,
    operationId: string,
    replacements: Map<string, { candidateHash: string; sourceMessageIds: string[] }>
  ): Promise<void> {
    const supports =
      await tx.execute(sql`SELECT DISTINCT p.primitive_kind,p.primitive_id,p.source_message_ids,r.source_message_id
      FROM mnemosyne.mnemo_harness_retraction r JOIN mnemosyne.mnemo_extraction_provenance p
        ON p.workspace_id=r.workspace_id AND p.session_id=r.predecessor_session_id
        AND r.source_message_id=ANY(p.source_message_ids)
      WHERE r.workspace_id=${workspaceId} AND r.session_id=${sessionId}
        AND p.rejection_reason IS NULL AND p.primitive_kind IN ('fact','decision','strategy')`);
    for (const support of supports) {
      const kind = String(support.primitive_kind);
      const table =
        kind === "fact"
          ? sql`mnemosyne.mnemo_fact`
          : kind === "decision"
            ? sql`mnemosyne.mnemo_decision`
            : sql`mnemosyne.mnemo_strategy`;
      const current = await tx.execute(sql`SELECT id FROM ${table} WHERE workspace_id=${workspaceId}
        AND id=${String(support.primitive_id)} AND status='active' AND valid_to IS NULL FOR UPDATE`);
      if (!current.length) continue;
      await tx.insert(schema.reviewItemTable).values({
        workspaceId,
        primitiveId: String(support.primitive_id),
        primitiveKind: kind,
        reason: "managed_source_retracted",
        detail: {
          operationId,
          sessionId,
          sourceMessageId: support.source_message_id,
          replacementCandidate: replacements.get(`${kind}:${support.primitive_id}`),
          candidate:
            Array.isArray(support.source_message_ids) && support.source_message_ids.length === 1
              ? "withdrawal"
              : "review",
          mixedSource:
            Array.isArray(support.source_message_ids) && support.source_message_ids.length > 1,
        },
      });
    }
  }
}
