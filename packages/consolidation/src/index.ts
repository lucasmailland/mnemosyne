export { runConsolidationGate } from "./ConsolidationGate.js";
export type { GateFact, GateInput, GateResult, FailedCondition } from "./ConsolidationGate.js";
export { validateMergedFact } from "./ReplayValidator.js";
export type {
  ReplayResult,
  ReplayValidatorContext,
  ValidatorLLM,
  ValidatorRecall,
  ValidatorStorage,
} from "./ReplayValidator.js";
export { classifyFactPair } from "./SemanticClassifier.js";
export type { SemanticClass, ClassifyFactPairResult } from "./SemanticClassifier.js";
export {
  startConsolidationScheduler,
  runConsolidationTick,
  CONSOLIDATION_SYSTEM_ACTOR,
} from "./scheduler.js";
export type {
  SchedulerContext,
  SchedulerHandle,
  SchedulerTickResult,
  SchedulerStorage,
  ClusterMergeResult,
} from "./scheduler.js";
export {
  createScopedConflictCheckHandler,
  SCOPED_CONFLICT_JOB,
  SCOPED_CONFLICT_MAX_PAIRS,
} from "./scoped-conflict-check.js";
export type {
  ScopedConflictJobData,
  ScopedConflictStorage,
  ScopedConflictCheckContext,
} from "./scoped-conflict-check.js";
export { loadLinkedFactIds } from "./relation-memo.js";
export type { RelationLookupStorage } from "./relation-memo.js";
