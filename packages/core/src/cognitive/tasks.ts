/**
 * Task state machine guard + auto-extraction (spec §18).
 *
 * Cardinal rule: zero infrastructure imports.
 * All I/O flows through the injected StorageAdapter port.
 */
import type { MnemoTask, StorageAdapter } from "@mnemo-ai/types";

// ─── State machine ────────────────────────────────────────────────────────────

export type TaskStatus = MnemoTask["status"];

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["blocked", "completed", "delegated", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  delegated: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTaskTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus
  ) {
    super(`Illegal task transition: ${from} → ${to}`);
    this.name = "IllegalTaskTransitionError";
  }
}

export function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  if (!isValidTransition(from, to)) throw new IllegalTaskTransitionError(from, to);
}

// ─── Auto-extraction types ────────────────────────────────────────────────────

export type AutoExtractStorage = Pick<
  StorageAdapter,
  "createStrategy" | "createFact" | "createEpisode" | "createRelation" | "createEvent"
>;

export interface AutoExtractResult {
  strategyId: string | null;
  factId: string | null;
  episodeId: string;
  /** F26: id of the "task.completed" MnemoEvent emitted on completion (spec §18). */
  eventId: string;
}

// ─── Rule-based auto-extract on completion ────────────────────────────────────

/**
 * When a task completes:
 *  - lessonsLearned → MnemoStrategy (procedural memory) + derived_from relation
 *  - outcome        → MnemoFact (semantic memory)       + derived_from relation
 *  - Always creates a linking MnemoEpisode
 *
 * Returns null if neither outcome nor lessonsLearned is populated (no-op).
 */
export async function autoExtractOnCompletion(
  storage: AutoExtractStorage,
  task: MnemoTask
): Promise<AutoExtractResult | null> {
  const hasLesson = !!task.lessonsLearned?.trim();
  const hasOutcome = !!task.outcome?.trim();
  if (!hasLesson && !hasOutcome) return null;

  let strategyId: string | null = null;
  let factId: string | null = null;

  if (hasLesson) {
    const strat = await storage.createStrategy({
      workspaceId: task.workspaceId,
      trigger: task.title,
      action: task.lessonsLearned!.trim(),
      context: `Auto-extracted from completed task ${task.id}`,
      metadata: { source: "task_auto_extract", taskId: task.id },
    });
    strategyId = strat.id;
    // flatten-legacy-dual-core D6.4 discovery: "strategy"/"task" are NOT in
    // `RelationNodeKind` ("fact"|"decision"|"entity"|"episode") and the
    // physical `mnemo_relation_source_kind_check`/`..._target_kind_check`
    // CHECK constraints would reject this INSERT against real Postgres — a
    // pre-existing, unrelated latent bug this PR's type-widening surfaced
    // at compile time (D1 model-matches-physical-truth), not introduced by
    // it. Out of 9c's scope (types/mappers/GraphRepository only, no
    // behavior change); flagged for a follow-up change. Cast preserves the
    // exact prior runtime behavior (still throws at the DB layer today).
    await storage.createRelation({
      workspaceId: task.workspaceId,
      sourceId: strat.id,
      sourceType: "strategy" as never,
      targetId: task.id,
      targetType: "task" as never,
      verb: "derived_from",
    });
  }

  if (hasOutcome) {
    const fact = await storage.createFact({
      workspaceId: task.workspaceId,
      scope: "global", // task outcomes are workspace-shared by default
      statement: task.outcome!.trim(),
      subject: task.title,
      kind: "other", // task completion outcomes don't map cleanly to a specific kind
      attribution: "inferred", // system-derived from task completion
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      metadata: { source: "task_auto_extract", taskId: task.id },
    });
    factId = fact.id;
    // Same D6.4 discovery as the strategy relation above: "task" is not a
    // valid `RelationNodeKind` target — pre-existing latent bug, out of
    // scope for this PR, cast preserves current (broken) runtime behavior.
    await storage.createRelation({
      workspaceId: task.workspaceId,
      sourceId: fact.id,
      sourceType: "fact",
      targetId: task.id,
      targetType: "task" as never,
      verb: "derived_from",
    });
  }

  const episode = await storage.createEpisode({
    workspaceId: task.workspaceId,
    title: `Completed: ${task.title}`,
    narrative: [
      `Task "${task.title}" completed.`,
      hasOutcome ? `Outcome: ${task.outcome!.trim()}` : "",
      hasLesson ? `Lesson: ${task.lessonsLearned!.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    occurredAt: task.completedAt ?? new Date(),
    linkedFactIds: factId ? [factId] : [],
    metadata: {
      source: "task_auto_extract",
      taskId: task.id,
      strategyId,
      factId,
    },
  });

  // F26 (spec §18 example): emit an immutable MnemoEvent marking completion, in
  // addition to the richer linking Episode above. type="agent" because the
  // completion is recorded by the agent runtime, not an external system.
  const event = await storage.createEvent({
    workspaceId: task.workspaceId,
    type: "agent",
    name: "task.completed",
    description: hasOutcome
      ? `Task "${task.title}" completed. Outcome: ${task.outcome!.trim()}`
      : `Task "${task.title}" completed.`,
    occurredAt: task.completedAt ?? new Date(),
    source: "task_auto_extract",
    relatedEntities: task.relatedEntities ?? [],
    metadata: {
      source: "task_auto_extract",
      taskId: task.id,
      strategyId,
      factId,
      episodeId: episode.id,
    },
  });

  return { strategyId, factId, episodeId: episode.id, eventId: event.id };
}
