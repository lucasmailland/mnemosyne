/**
 * §34.8 Queue Backpressure & Job Shedding (pure — no adapter imports).
 * pg-boss: lower number = higher priority.
 */
export type Priority = 1 | 2 | 3 | 4;
export const JOB_PRIORITY = { critical: 1, high: 2, medium: 3, low: 4 } as const;

const JOB_TIERS: Record<string, Priority> = {
  // Bare keys (used by pg-boss workers)
  "session.collapse": 1,
  "reasoning.resolve": 1,
  "embed.fact": 2,
  "worth.propagate": 2,
  "governance.propagate": 2,
  consolidation: 3,
  dedup: 3,
  prune: 3,
  "anticipate.mine": 4,
  "metacognition.refresh": 4,
  "audit.merkle": 4,
  scoped_semantic_conflict_check: 4,
  // mnemo.* prefixed keys (used by the cron registry)
  "mnemo.session.collapse": 1,
  "mnemo.embed.migration": 2,
  "mnemo.governance.propagate": 2,
  "mnemo.hot.rebuild": 3,
  "mnemo.reasoning.prune": 3,
  "mnemo.composition.validate": 3,
  "mnemo.reasoning.decay": 3,
  "mnemo.semantic.decay": 3,
  "mnemo.procedural.decay": 3,
  "mnemo.hot.decay": 3,
  "mnemo.verify.codebase": 3,
  "mnemo.hebbian.normalize": 3,
  "mnemo.anticipate.mine": 4,
  "mnemo.metacognition.refresh": 4,
  "mnemo.audit.merkle": 4,
  "mnemo.audit.merkle.publish": 4,
  "mnemo.type.schedule": 4,
  "mnemo.task.stale": 4,
  "mnemo.procedural.evaluate": 4,
  "mnemo.idempotency.reap": 4,
  "mnemo.webhook.deliver": 4,
  "mnemo.workspace.graduate": 4,
};

export function priorityOf(jobName: string): Priority {
  return JOB_TIERS[jobName] ?? JOB_PRIORITY.medium;
}

export interface ShedState {
  stage: 0 | 1 | 2 | 3;
  paused: Set<Priority>;
}

const ENTER = { 1: 0.7, 2: 0.85, 3: 0.95 } as const;
const HYST = 0.1;
const PAUSED_AT: Record<0 | 1 | 2 | 3, Priority[]> = { 0: [], 1: [4], 2: [3, 4], 3: [2, 3, 4] };

export function decideShed(poolUtil: number, prev: ShedState): ShedState {
  let target: 0 | 1 | 2 | 3 = 0;
  if (poolUtil >= ENTER[3]) target = 3;
  else if (poolUtil >= ENTER[2]) target = 2;
  else if (poolUtil >= ENTER[1]) target = 1;

  if (target < prev.stage) {
    const holdAt = prev.stage as 1 | 2 | 3;
    if (poolUtil >= ENTER[holdAt] - HYST) {
      target = prev.stage;
    } else if (prev.stage > 1 && poolUtil >= ENTER[(prev.stage - 1) as 1 | 2 | 3] - HYST) {
      target = (prev.stage - 1) as 0 | 1 | 2 | 3;
    }
  }

  return { stage: target, paused: new Set(PAUSED_AT[target]) };
}

export function isPaused(state: ShedState, priority: Priority): boolean {
  return state.paused.has(priority);
}
