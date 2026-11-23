// in-memory/composition.ts — InMemoryStorageAdapter's Compositionality port
// methods. decompose-inmemory-storage-adapter Batch B9a (design.md Module Map
// row 19) ships 8 of this module's 9 methods; Batch B9b adds the 9th
// (`materialiseInference`, the Cross-Domain Inventory's 4-collection case —
// facts, outbox, inferences, compositionRules — shipped separately per
// design.md's explicit flag). Bodies moved verbatim from
// InMemoryStorageAdapter.ts — the only edit is `this.<field>` →
// `state.<field>` (design.md D7 move-only rule).

import type {
  CreateCompositionRuleInput,
  UpdateCompositionRuleInput,
  CompositionRuleFilter,
  AppendInferenceInput,
  MaterialiseInferenceInput,
  InferenceLogFilter,
} from "../../ports.js";
import type { MnemoCompositionRule, MnemoInferenceLogEntry, MnemoFact } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate, withoutPendingMarker } from "./support.js";

export async function createCompositionRule(
  state: InMemoryStorageState,
  input: CreateCompositionRuleInput
): Promise<MnemoCompositionRule> {
  const id = uuid();
  const rule: MnemoCompositionRule = {
    id,
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description,
    conditionDsl: input.conditionDsl,
    actionDsl: input.actionDsl,
    priority: input.priority ?? 100,
    isActive: input.isActive ?? true,
    executionCount: 0,
    createdBy: input.createdBy,
    source: input.source ?? "manual",
    metadata: input.metadata ?? {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  state.compositionRules.set(id, rule);
  return rule;
}

export async function getCompositionRule(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoCompositionRule | null> {
  const rule = state.compositionRules.get(id);
  return rule && rule.workspaceId === workspaceId ? rule : null;
}

export async function updateCompositionRule(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  input: UpdateCompositionRuleInput
): Promise<MnemoCompositionRule> {
  const rule = state.compositionRules.get(id);
  if (!rule || rule.workspaceId !== workspaceId) throw new Error(`CompositionRule ${id} not found`);
  const updated = { ...rule, ...input, updatedAt: new Date() };
  state.compositionRules.set(id, updated);
  return updated;
}

export async function queryCompositionRules(
  state: InMemoryStorageState,
  filter: CompositionRuleFilter
): Promise<PaginatedResult<MnemoCompositionRule>> {
  let items = Array.from(state.compositionRules.values()).filter(
    (r) => r.workspaceId === filter.workspaceId
  );
  if (filter.isActive !== undefined) items = items.filter((r) => r.isActive === filter.isActive);
  if (filter.source) items = items.filter((r) => r.source === filter.source);
  items.sort((a, b) => b.priority - a.priority);
  return paginate(items, filter.offset, filter.limit);
}

export async function bumpCompositionExecution(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const rule = state.compositionRules.get(id);
  if (!rule || rule.workspaceId !== workspaceId) return;
  state.compositionRules.set(id, {
    ...rule,
    executionCount: rule.executionCount + 1,
    updatedAt: new Date(),
  });
}

export async function ensureBuiltinCompositionRules(
  _state: InMemoryStorageState,
  _workspaceId: string
): Promise<void> {
  // No-op: InMemory adapter has no template table; tests that need composition
  // rules should seed them directly via createCompositionRule().
}

export async function appendInference(
  state: InMemoryStorageState,
  input: AppendInferenceInput
): Promise<MnemoInferenceLogEntry> {
  const entry: MnemoInferenceLogEntry = {
    id: uuid(),
    workspaceId: input.workspaceId,
    ruleId: input.ruleId,
    inputFactIds: input.inputFactIds,
    derivedKind: input.derivedKind,
    derivedId: input.derivedId,
    confidence: input.confidence,
    rationale: input.rationale,
    triggeredByQuery: input.triggeredByQuery,
    conversationId: input.conversationId,
    createdAt: new Date(),
  };
  state.inferences.push(entry);
  return entry;
}

export async function materialiseInference(
  state: InMemoryStorageState,
  input: MaterialiseInferenceInput
): Promise<{ id: string }> {
  // Real in-memory behaviour mirroring CompositionRepository.materialiseInference:
  // insert a derived fact, append an inference-log entry pointing at it, and
  // bump the rule's execution count — all synchronously (no tx needed here).
  const now = new Date();
  const factId = uuid();
  const fact: MnemoFact = {
    id: factId,
    workspaceId: input.workspaceId,
    agentId: undefined,
    actorId: undefined,
    scope: input.fact.scope as MnemoFact["scope"],
    scopeRef: undefined,
    scopeOwner: `workspace:${input.workspaceId}`,
    statement: input.fact.statement,
    subject: input.fact.subject,
    kind: input.fact.kind as MnemoFact["kind"],
    confidence: 0.7,
    relevance: 0.8,
    hitCount: 0,
    worthSuccess: 0,
    worthFailure: 0,
    worthAlpha: 2,
    worthBeta: 2,
    worth: 0.5,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    attribution: input.fact.attribution as MnemoFact["attribution"],
    sourceMessageIds: [],
    linkedMemoryIds: [],
    revisionCount: 1,
    protocolVersion: "3.0",
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: input.fact.sensitivity,
    validFrom: now,
    embeddingStale: true,
    createdAt: now,
    updatedAt: now,
    // A derived fact must never carry a forged pending-consolidation marker.
    metadata: withoutPendingMarker(input.fact.metadata ?? {}),
  };
  state.facts.set(fact.id, fact);
  state.outbox.push({
    id: uuid(),
    workspaceId: input.workspaceId,
    eventType: "vector_upsert",
    payload: { id: factId, kind: "fact", statement: input.fact.statement },
    createdAt: now,
    attempts: 0,
  });
  state.inferences.push({
    id: uuid(),
    workspaceId: input.workspaceId,
    ruleId: input.ruleId,
    inputFactIds: input.inferenceLog.inputFactIds,
    derivedKind: input.inferenceLog.derivedKind,
    derivedId: factId,
    confidence: input.inferenceLog.confidence,
    rationale: input.inferenceLog.rationale,
    triggeredByQuery: input.inferenceLog.triggeredByQuery,
    conversationId: input.inferenceLog.conversationId,
    createdAt: now,
  });
  const rule = state.compositionRules.get(input.ruleId);
  if (rule && rule.workspaceId === input.workspaceId) {
    state.compositionRules.set(input.ruleId, {
      ...rule,
      executionCount: rule.executionCount + 1,
      updatedAt: now,
    });
  }
  return { id: factId };
}

export async function queryInferences(
  state: InMemoryStorageState,
  filter: InferenceLogFilter
): Promise<PaginatedResult<MnemoInferenceLogEntry>> {
  let items = state.inferences.filter((e) => e.workspaceId === filter.workspaceId);
  if (filter.ruleId) items = items.filter((e) => e.ruleId === filter.ruleId);
  if (filter.derivedId) items = items.filter((e) => e.derivedId === filter.derivedId);
  if (filter.since) items = items.filter((e) => e.createdAt > filter.since!);
  items = [...items].reverse();
  return paginate(items, filter.offset, filter.limit);
}
