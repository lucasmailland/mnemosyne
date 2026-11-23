/** Managed preparation: all domain writes are represented as transaction or durable effect intents. */
import {
  SENSITIVITY_ORDER,
  managedCollapseOperationId,
  factStatementHash,
  sha256Hex,
  parseActorRef,
  type AuthContext,
  type MnemoSession,
  type SessionTurn,
  type Sensitivity,
  type ManagedCollapsePlan,
  type ManagedPreparedCollapsePlan,
  type ManagedCollapseCandidate,
  type ManagedCollapsePlanBase,
  type ManagedPostCommitEffect,
  type ActorRef,
} from "@mnemo-ai/types";
import type { CoreContext } from "../cognitive/context.js";
import {
  buildCollapsePrompt,
  conversationalTurnsForRecurrence,
  coerceDecisionKind,
  coerceFactKind,
  coerceOutcome,
  computePE,
  countPinnedTurns,
  normalizeExtractedText,
  requirePinSatisfied,
  resolveTopicKeyCollisions,
  type CollapsePolicy,
} from "./collapse.js";
import { parseJsonReply } from "../llm/parse-json-reply.js";
import { recurrenceSignal } from "../cognitive/recmem.js";
import { extractionBiasHint } from "../cognitive/knowledge-scheduler.js";
import { computeDeltaEpisodeLink } from "../cognitive/delta-episode.js";
import { gatesFor } from "../cognitive/learningMode.js";
import {
  computeOutcome,
  explicitSignal,
  heuristicSignal,
  taskCompletionSignal,
  type OutcomeSignal,
} from "../cognitive/outcome-signal.js";

export interface PrepareManagedCollapseInput {
  /** Snapshot read under the claim fence. Commit revalidates its operation and lease. */
  session: MnemoSession;
  turns: SessionTurn[];
  policy?: CollapsePolicy;
  collapseHint?: string;
  learningMode?: boolean;
  /** Advisory metadata only. Commit always resolves the current topic under lock. */
  existingTopics?: Array<{
    kind: "fact" | "decision";
    id: string;
    topicKey: string;
    sensitivity: Sensitivity;
  }>;
}

type RawCandidate = Record<string, unknown> & { sourceMessageIds: string[]; topicKey?: string };
interface ParsedSummary {
  goal?: string;
  outcome?: string;
  facts: RawCandidate[];
  decisions: RawCandidate[];
  strategies: RawCandidate[];
  discoveries?: string[];
  nextSteps?: string[];
  relevantEntities?: string[];
  keyDecisions?: string[];
}

/** Stable JSON for extraction values, including fractional confidence. Harness wire
 * canonicalJson deliberately permits only integer numbers and is unsuitable here. */
/**
 * P153: the first copy of an exact repetition is the one resolveTopicKeyCollisions
 * keeps, so it must carry every copy's supporting messages. Dropping the others'
 * sourceMessageIds would make a later retraction of one of them look like a
 * single-source withdrawal, or miss the surviving primitive altogether.
 */
function unionRepeatSources(
  items: RawCandidate[],
  identityOf: (item: RawCandidate) => string
): RawCandidate[] {
  const firstByIdentity = new Map<string, number>();
  const merged: RawCandidate[] = [];
  for (const item of items) {
    const identity = normalizeExtractedText(identityOf(item));
    const at = firstByIdentity.get(identity);
    if (at === undefined) {
      firstByIdentity.set(identity, merged.length);
      merged.push(item);
      continue;
    }
    const first = merged[at]!;
    const sources = [...new Set([...first.sourceMessageIds, ...item.sourceMessageIds])];
    merged[at] = { ...first, sourceMessageIds: sources };
  }
  return merged;
}

function candidateJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      );
    }
    return item;
  });
}

/** Content-derived operation-local IDs are stable on retry and valid UUIDs for primitive tables. */
function stableId(operationId: string, kind: string, value: unknown): string {
  const hex = sha256Hex(candidateJson([operationId, kind, value]));
  if (kind === "episode") return `mepi_${hex.slice(0, 24)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function optionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
function validateSummary(value: unknown, live: Set<string>): ParsedSummary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_extraction");
  const obj = value as Record<string, unknown>;
  for (const key of ["goal", "outcome"])
    if (!optionalText(obj[key])) throw new Error("invalid_extraction");
  for (const key of ["discoveries", "nextSteps", "relevantEntities", "keyDecisions"]) {
    if (
      obj[key] !== undefined &&
      (!Array.isArray(obj[key]) || !(obj[key] as unknown[]).every(text))
    )
      throw new Error("invalid_extraction");
  }
  for (const kind of ["facts", "decisions", "strategies"]) {
    if (!Array.isArray(obj[kind])) throw new Error("invalid_extraction");
    for (const candidate of obj[kind] as unknown[]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        throw new Error("invalid_extraction");
      const c = candidate as Record<string, unknown>;
      if (
        !Array.isArray(c.sourceMessageIds) ||
        c.sourceMessageIds.length === 0 ||
        !c.sourceMessageIds.every((id) => typeof id === "string" && live.has(id))
      )
        throw new Error("invalid_extraction");
      for (const field of kind === "facts"
        ? ["content"]
        : kind === "decisions"
          ? ["title", "body"]
          : ["trigger", "action"])
        if (!text(c[field])) throw new Error("invalid_extraction");
      for (const field of ["topicKey", "subject", "context", "kind"])
        if (!optionalText(c[field])) throw new Error("invalid_extraction");
      if (
        c.confidence !== undefined &&
        (typeof c.confidence !== "number" ||
          !Number.isFinite(c.confidence) ||
          c.confidence < 0 ||
          c.confidence > 1)
      )
        throw new Error("invalid_extraction");
    }
  }
  return obj as unknown as ParsedSummary;
}
function effects(
  base: ManagedCollapsePlanBase,
  status: "collapsed" | "archived",
  reason?: string
): ManagedPostCommitEffect[] {
  return [
    {
      effectKind: "session_buffer_cleanup",
      targetKind: "session",
      targetId: base.sessionId,
      payload: {},
    },
    {
      effectKind: "bus_delivery",
      targetKind: "session",
      targetId: base.sessionId,
      payload: { status, ...(reason ? { reason } : {}) },
    },
    {
      effectKind: "webhook_delivery",
      targetKind: "session",
      targetId: base.sessionId,
      payload: { status, ...(reason ? { reason } : {}) },
    },
  ];
}

export async function prepareManagedCollapse(
  input: PrepareManagedCollapseInput,
  ctx: CoreContext,
  auth: AuthContext
): Promise<ManagedCollapsePlan> {
  const { session, policy = {} } = input;
  const turns = input.turns
    .filter((t) => (t.role === "user" || t.role === "assistant") && !t.retractedAt)
    .sort((a, b) => a.turnIndex - b.turnIndex);
  const identity = {
    operationId: managedCollapseOperationId(session),
    workspaceId: session.workspaceId,
    sessionId: session.id,
    generation: session.sourceGeneration ?? -1,
    sourceMessageIds: turns.flatMap((t) => (t.sourceMessageId ? [t.sourceMessageId] : [])),
  };
  const retry = (
    reason:
      | "invalid_session"
      | "invalid_provenance"
      | "llm_unavailable"
      | "invalid_extraction"
      | "preparation_unavailable"
  ): ManagedCollapsePlan => ({ ...identity, status: "retryable", reason });
  if (
    !session.sourceHost ||
    session.status !== "collapse_pending" ||
    !identity.operationId ||
    identity.generation < 0 ||
    auth.workspaceId !== session.workspaceId ||
    turns.some(
      (t) =>
        t.workspaceId !== session.workspaceId || t.sessionId !== session.id || !t.sourceMessageId
    ) ||
    new Set(identity.sourceMessageIds).size !== turns.length
  )
    return retry("invalid_session");
  const actor = session.originActorId ? parseActorRef(session.originActorId) : null;
  const expectedNamespace = { agent: "key", user: "user", system: "system", federation: "peer" };
  if (
    !actor ||
    !session.originActorType ||
    actor.namespace !== expectedNamespace[session.originActorType] ||
    !session.sensitivity ||
    !(session.sensitivity in SENSITIVITY_ORDER) ||
    !session.originSensitivityCeiling ||
    !(session.originSensitivityCeiling in SENSITIVITY_ORDER)
  )
    return retry("invalid_provenance");
  const sensitivity = session.sensitivity;
  const ceiling = session.originSensitivityCeiling;
  if (
    SENSITIVITY_ORDER[sensitivity] > SENSITIVITY_ORDER[ceiling] ||
    (auth.maxSensitivity && SENSITIVITY_ORDER[sensitivity] > SENSITIVITY_ORDER[auth.maxSensitivity])
  )
    return retry("invalid_provenance");
  const effectiveCeiling =
    auth.maxSensitivity && SENSITIVITY_ORDER[auth.maxSensitivity] < SENSITIVITY_ORDER[ceiling]
      ? auth.maxSensitivity
      : ceiling;
  const base: ManagedCollapsePlanBase = {
    ...identity,
    sensitivity,
    provenance: {
      actorId: session.originActorId as ActorRef,
      actorType: session.originActorType,
      userId: session.originUserId ?? null,
      sensitivityCeiling: effectiveCeiling,
    },
  };
  const archive = (
    reason: "empty_session" | "incomplete_exchange" | "no_pin" | "low_recurrence_signal"
  ): ManagedCollapsePlan => ({
    ...base,
    status: "archive",
    reason,
    postCommitEffects: effects(base, "archived", reason),
  });
  if (turns.length === 0) return archive("empty_session");
  if (turns.length === 1) return archive("incomplete_exchange");
  if (!requirePinSatisfied(policy.mode === "hybrid" || policy.requirePin === true, turns))
    return archive("no_pin");
  if (!ctx.llm) return retry("llm_unavailable");
  try {
    if (session.closeKind !== "authoritative" && ctx.embed.semantic !== false) {
      const embeddings = await ctx.embed.embed(turns.map((t) => t.content));
      const signal = recurrenceSignal(embeddings);
      const conversational = new Set(conversationalTurnsForRecurrence(turns));
      const conversationEmbeddings = embeddings.filter((_, i) => conversational.has(turns[i]!));
      ctx.logger.info("managed collapse: recurrence signal by content origin", {
        operation: "managed_collapse.recmem_origin",
        sessionId: session.id,
        turnCount: turns.length,
        conversationalTurnCount: conversational.size,
        sustainedSignal: signal,
        conversationalSignal:
          conversationEmbeddings.length >= 2 ? recurrenceSignal(conversationEmbeddings) : null,
      });
      if (signal < (policy.recurrenceThreshold ?? 0.6) && policy.skipLlmIfBelowThreshold !== false)
        return archive("low_recurrence_signal");
    }
  } catch {
    return retry("preparation_unavailable");
  }
  let bias = "";
  try {
    bias = extractionBiasHint(await ctx.storage.getKnowledgeDistribution(session.workspaceId));
  } catch {
    /* Optional read-only scheduling enrichment. */
  }
  // JSON-encoded identities cannot be confused with prompt delimiters. Every output must cite a live ID.
  const prompt =
    buildCollapsePrompt(turns, input.collapseHint) +
    bias +
    "\nFor every fact, decision and strategy include sourceMessageIds: a non-empty array containing ONLY the supporting message IDs below. Do not cite unrelated messages.\nSOURCE MESSAGE IDENTITIES:\n" +
    turns
      .map((t) =>
        JSON.stringify({
          turnIndex: t.turnIndex,
          sourceMessageId: t.sourceMessageId,
          hint: t.hint,
          pinned: t.pinned === true,
        })
      )
      .join("\n");
  let output: Awaited<ReturnType<NonNullable<CoreContext["llm"]>["generate"]>>;
  try {
    output = await ctx.llm.generate({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2048,
      temperature: 0.1,
      task: "summary",
    });
  } catch {
    return retry("llm_unavailable");
  }
  let summary: ParsedSummary;
  try {
    summary = validateSummary(
      parseJsonReply<unknown>(output.content, "managed-collapse.summary"),
      new Set(identity.sourceMessageIds)
    );
    // P153: settle identity across the whole extraction before topic lookup or stable IDs.
    const factIdentity = (fact: RawCandidate) =>
      factStatementHash(
        normalizeExtractedText(fact.content as string),
        (fact.subject as string | undefined) ?? "general"
      );
    const decisionIdentity = (decision: RawCandidate) => `${decision.title}\n${decision.body}`;
    summary.facts = resolveTopicKeyCollisions(
      unionRepeatSources(summary.facts, factIdentity),
      factIdentity
    );
    summary.decisions = resolveTopicKeyCollisions(
      unionRepeatSources(summary.decisions, decisionIdentity),
      decisionIdentity
    );
  } catch {
    return retry("invalid_extraction");
  }
  // Coercion logs never include arbitrary model output on the managed path.
  const safeCtx = { ...ctx, logger: { ...ctx.logger, warn: () => undefined } };
  const outcome = coerceOutcome(summary.outcome, safeCtx) ?? "";
  const usageTokens = output.tokensUsed.input + output.tokensUsed.output;
  const candidates: ManagedCollapseCandidate[] = [];
  const rejected: ManagedPreparedCollapsePlan["rejectedCandidates"] = [];
  let modeRow: Awaited<ReturnType<NonNullable<CoreContext["storage"]["getWorkspaceMode"]>>> = null;
  try {
    modeRow = (await ctx.storage.getWorkspaceMode?.(session.workspaceId)) ?? null;
  } catch {
    /* Conservative learning defaults. */
  }
  const gates = gatesFor(modeRow ? { ...modeRow, workspaceId: session.workspaceId } : null);
  const worthEnabled = input.learningMode === undefined ? gates.worthUpdates : !input.learningMode;
  try {
    const perTurnKeys =
      policy.mode === "hybrid" &&
      policy.hybridPolicy?.collapseSkipsExisting !== false &&
      ctx.storage.listSessionTopicKeysBySource
        ? new Set(
            await ctx.storage.listSessionTopicKeysBySource(
              session.workspaceId,
              session.id,
              "per_turn"
            )
          )
        : new Set<string>();
    for (const kind of ["fact", "decision", "strategy"] as const) {
      if (
        (kind === "fact" && policy.extractFacts === false) ||
        (kind === "decision" && policy.extractDecisions === false) ||
        (kind === "strategy" && policy.extractStrategies === false)
      )
        continue;
      for (const extracted of summary[
        kind === "fact" ? "facts" : kind === "decision" ? "decisions" : "strategies"
      ]) {
        const topicKey =
          typeof extracted.topicKey === "string" && extracted.topicKey
            ? extracted.topicKey
            : undefined;
        const support = [...new Set(extracted.sourceMessageIds)].sort();
        const id = stableId(identity.operationId, kind, {
          ...extracted,
          sourceMessageIds: support,
        });
        const prior = input.existingTopics?.find(
          (t) =>
            t.kind === kind &&
            topicKey !== undefined &&
            (kind === "decision"
              ? t.topicKey.trim().toLowerCase() === topicKey.trim().toLowerCase()
              : t.topicKey === topicKey)
        );
        const inherited =
          prior && SENSITIVITY_ORDER[prior.sensitivity] > SENSITIVITY_ORDER[sensitivity]
            ? prior.sensitivity
            : sensitivity;
        if (SENSITIVITY_ORDER[inherited] > SENSITIVITY_ORDER[effectiveCeiling]) {
          rejected.push({
            id,
            kind,
            topicKey,
            requestedSensitivity: inherited,
            contentHash: sha256Hex(candidateJson(extracted)),
            reason: "sensitivity_ceiling",
          });
          continue;
        }
        if (
          kind === "fact" &&
          ((topicKey && perTurnKeys.has(topicKey)) ||
            (await computePE(ctx, extracted.content as string, session.workspaceId)) <
              ctx.config.surpriseThreshold)
        )
          continue;
        const common = {
          workspaceId: session.workspaceId,
          agentId: session.agentId,
          actorId: base.provenance.actorId,
          actorType: base.provenance.actorType,
          userId: base.provenance.userId,
          sensitivity: inherited,
          metadata: {
            operationId: identity.operationId,
            sourceMessageIds: support,
            sensitivityCeiling: effectiveCeiling,
          },
        };
        const shared = {
          id,
          sourceMessageIds: support,
          sensitivity: inherited,
          topicKey,
          ...(prior ? { predecessorId: prior.id } : {}),
        };
        if (candidates.some((c) => c.id === id)) continue;
        if (kind === "fact")
          candidates.push({
            ...shared,
            kind,
            input: {
              ...common,
              scope: "global",
              kind: coerceFactKind(extracted.kind as string | undefined, safeCtx),
              statement: extracted.content as string,
              subject: (extracted.subject as string) ?? "general",
              confidence: (extracted.confidence as number) ?? 0.8,
              topicKey,
              sessionId: session.id,
              extractionSource: "collapse",
              sourceMessageIds: support,
            },
          });
        else if (kind === "decision")
          candidates.push({
            ...shared,
            kind,
            input: {
              ...common,
              kind: coerceDecisionKind(extracted.kind as string | undefined, safeCtx),
              title: extracted.title as string,
              body: extracted.body as string,
              topicKey,
              conversationId: session.id,
            },
          });
        else
          candidates.push({
            ...shared,
            kind,
            input: {
              ...common,
              trigger: extracted.trigger as string,
              action: extracted.action as string,
              context: extracted.context as string | undefined,
            },
          });
      }
    }
  } catch {
    return retry("preparation_unavailable");
  }
  // A rejected candidate can be repeated verbatim in narrative fields. Drop model-generated
  // narrative metadata on any ceiling rejection, leaving only a safe completion context.
  const narrativeSummary = rejected.length
    ? {
        goal: "Session collapse",
        discoveries: [],
        nextSteps: [],
        relevantEntities: [],
        keyDecisions: [],
      }
    : summary;
  const narrative = [
    narrativeSummary.goal ? `Goal: ${narrativeSummary.goal}` : null,
    `Outcome: ${outcome}`,
    narrativeSummary.discoveries?.length
      ? `Discoveries: ${narrativeSummary.discoveries.join("; ")}`
      : null,
  ]
    .filter((s): s is string => s !== null)
    .join("\n");
  const factIds = candidates.filter((c) => c.kind === "fact").map((c) => c.id);
  const episodeId = stableId(identity.operationId, "episode", session.id);
  let delta: Awaited<ReturnType<typeof computeDeltaEpisodeLink>> = {};
  // Reuse DELTAMEM through a read-only wrapper. Validate the entire ancestor chain
  // before reconstructing it so a stricter parent cannot lower classification here.
  try {
    const original = ctx.storage;
    const storage = new Proxy(original, {
      get(target, property) {
        if (property === "reconstructEpisode")
          return async (id: string, workspaceId: string) => {
            const visited = new Set<string>();
            let current: string | undefined = id;
            while (current) {
              if (visited.has(current) || visited.size >= 100)
                throw new Error("invalid_delta_chain");
              visited.add(current);
              const parent = await original.getEpisode(current, workspaceId);
              if (
                !parent ||
                parent.workspaceId !== workspaceId ||
                !(parent.sensitivity in SENSITIVITY_ORDER) ||
                SENSITIVITY_ORDER[parent.sensitivity] > SENSITIVITY_ORDER[sensitivity]
              )
                throw new Error("invalid_delta_classification");
              current = parent.parentEpisodeId;
            }
            return original.reconstructEpisode(id, workspaceId);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    delta = await computeDeltaEpisodeLink({ ...ctx, storage }, session.workspaceId, narrative);
  } catch {
    /* Optional delta enrichment: preserve a root episode on failure. */
  }
  const relations: ManagedPreparedCollapsePlan["relations"] = [];
  for (let i = 0; i < factIds.length; i++)
    for (let j = i + 1; j < factIds.length; j++)
      relations.push({
        id: stableId(identity.operationId, "relation", [factIds[i], factIds[j]]),
        sourceId: factIds[i]!,
        targetId: factIds[j]!,
        sourceType: "fact",
        targetType: "fact",
        verb: "related",
      });
  const hyperedges: ManagedPreparedCollapsePlan["hyperedges"] = [];
  let hyperedgeTokens = 0;
  if (factIds.length >= 3) {
    try {
      const out = await ctx.llm.generate({
        messages: [
          {
            role: "user",
            content:
              "Return a JSON array of groups of 3 or more distinct fact INDICES that form a single n-ary relation. Return [] if none.\n" +
              candidates
                .filter((c) => c.kind === "fact")
                .map((c, i) => JSON.stringify({ index: i, content: c.input.statement }))
                .join("\n"),
          },
        ],
        maxTokens: 256,
        temperature: 0,
        task: "summary",
      });
      hyperedgeTokens = out.tokensUsed.input + out.tokensUsed.output;
      const groups = parseJsonReply<unknown>(out.content, "managed-collapse.groups");
      if (Array.isArray(groups))
        for (const group of groups) {
          if (
            !Array.isArray(group) ||
            group.some((i) => !Number.isInteger(i) || i < 0 || i >= factIds.length)
          )
            continue;
          const memberIds = [...new Set((group as number[]).map((i) => factIds[i]!))].sort();
          if (memberIds.length < 3) continue;
          const id = stableId(identity.operationId, "hyperedge", memberIds);
          if (!hyperedges.some((h) => h.id === id))
            hyperedges.push({
              id,
              memberIds,
              label: "auto-consolidated",
              description: "Auto-extracted n-ary relation during session consolidation",
            });
        }
    } catch {
      /* Optional inference; no domain effect has occurred. */
    }
  }
  const worthUpdates: ManagedPreparedCollapsePlan["worthUpdates"] = [];
  if (worthEnabled && factIds.length) {
    const signals: OutcomeSignal[] = [];
    const coerced = coerceOutcome(outcome || undefined, safeCtx);
    if (coerced) signals.push(explicitSignal(coerced));
    try {
      const tasks = await ctx.storage.listTasksForSession?.(session.workspaceId, session.id);
      if (tasks?.length) {
        const signal = taskCompletionSignal(
          tasks.length,
          tasks.filter((t) => t.status === "completed").length
        );
        if (signal) signals.push(signal);
      }
    } catch {
      /* Optional read signal. */
    }
    signals.push(
      heuristicSignal({
        endedWithThanks: /\b(thank(s| you)|cheers|perfect|awesome|great|appreciate)\b/.test(
          turns.at(-1)?.content.toLowerCase() ?? ""
        ),
        repeatedQuestion:
          turns.length >= 4 &&
          turns.filter((t) => t.role === "user" && t.content.includes("?")).length >=
            Math.ceil(turns.length * 0.5),
        manyTurnsNoResolve: turns.length > 20 && outcome !== "resolved",
        shortAndStopped: turns.length <= 3,
      })
    );
    const score = computeOutcome(signals);
    for (const factId of factIds)
      worthUpdates.push({ factId, delta: { success: score, failure: 1 - score, creditWeight: 1 } });
  }
  const postCommitEffects = effects(base, "collapsed");
  postCommitEffects.push(
    { effectKind: "governance", targetKind: "session", targetId: session.id, payload: { outcome } },
    {
      effectKind: "graduation",
      targetKind: "workspace",
      targetId: session.workspaceId,
      payload: {},
    },
    {
      effectKind: "anticipation_telemetry",
      targetKind: "session",
      targetId: session.id,
      payload: { agentId: session.agentId, factIds },
    },
    {
      effectKind: "llm_usage_telemetry",
      targetKind: "session",
      targetId: session.id,
      payload: {
        provider: ctx.llm.id,
        model: output.model,
        inputTokens: output.tokensUsed.input,
        outputTokens: output.tokensUsed.output,
        hyperedgeTokens,
        costUSD: output.costUSD,
      },
    }
  );
  if (session.agentId)
    postCommitEffects.push({
      effectKind: "reflection",
      targetKind: "agent",
      targetId: session.agentId,
      payload: {},
    });
  for (const { factId, delta: worthDelta } of worthUpdates)
    postCommitEffects.push({
      effectKind: "td_credit",
      targetKind: "fact",
      targetId: factId,
      payload: { sessionId: session.id, delta: worthDelta },
    });
  if (gates.hotTier)
    for (const factId of factIds)
      postCommitEffects.push({
        effectKind: "hot_tier_promotion",
        targetKind: "fact",
        targetId: factId,
        payload: {},
      });
  return {
    ...base,
    status: "prepared",
    candidates,
    rejectedCandidates: rejected,
    episode: {
      id: episodeId,
      sourceMessageIds: identity.sourceMessageIds,
      sensitivity,
      input: {
        workspaceId: session.workspaceId,
        agentId: session.agentId,
        actorId: base.provenance.actorId,
        actorType: base.provenance.actorType,
        userId: base.provenance.userId,
        sensitivity,
        title: narrativeSummary.goal ?? "Session collapse",
        narrative,
        occurredAt: session.closeRequestedAt ?? session.lastActivityAt ?? session.openedAt,
        linkedFactIds: factIds,
        topics: narrativeSummary.relevantEntities ?? [],
        sourceConversationId: session.id,
        ...delta,
        metadata: {
          operationId: identity.operationId,
          sourceMessageIds: identity.sourceMessageIds,
          sensitivityCeiling: effectiveCeiling,
        },
      },
    },
    linkSessionFacts: true,
    ...(session.predecessorSessionId ? { predecessorSessionId: session.predecessorSessionId } : {}),
    relations,
    hyperedges,
    worthUpdates,
    counters: {
      factCount: factIds.length,
      sessionCount: 1,
      ...(session.agentId ? { reflectionAgentId: session.agentId } : {}),
    },
    summary: {
      goal: narrativeSummary.goal,
      outcome,
      discoveries: narrativeSummary.discoveries ?? [],
      nextSteps: narrativeSummary.nextSteps ?? [],
      relevantEntities: narrativeSummary.relevantEntities ?? [],
      keyDecisions: narrativeSummary.keyDecisions ?? [],
      turnsProcessed: turns.length,
      pinsUsed: countPinnedTurns(turns),
      llmTokensUsed: usageTokens + hyperedgeTokens,
      collapseReason: session.closeKind ?? "provisional",
      episodeId,
    },
    indexJobs: candidates.flatMap((c) =>
      c.kind === "fact" || c.kind === "decision"
        ? [{ eventType: "vector_upsert" as const, targetKind: c.kind, targetId: c.id }]
        : []
    ),
    postCommitEffects,
  };
}
