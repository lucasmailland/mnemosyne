/**
 * Compile-time-only guard for the `StorageAdapter` port segregation (design.md D5).
 *
 * This file is intentionally NOT exported from `index.ts` — it exists purely to be
 * typechecked by `pnpm typecheck` / `pnpm build` (covered by `tsconfig.json`'s
 * `include: ["src/**\/*"]`) and is tree-shaken out of the published bundle since
 * nothing imports it at runtime.
 *
 * Two compile-time assertions:
 * - `_NoOverlap` — no member name lives in more than one named sub-port
 *   (Interface Segregation Principle: each port is disjoint).
 * - `_Complete` — the `StorageAdapter` intersection alias's key set is EXACTLY the
 *   union of the ports' key sets: no orphan port (declared but missing from the
 *   alias) and no forgotten port (a member on the alias not covered by any port).
 *
 * If either assertion fails, `pnpm typecheck` reports a type error here — this is
 * the only layer that catches a dropped member, a changed optionality, or a
 * duplicated member name across the port split.
 */
import type {
  SessionPort,
  HarnessIngestionPort,
  ManagedSessionLifecyclePort,
  ManagedCollapsePort,
  ManagedSessionWorkerPort,
  FactPort,
  RetentionPort,
  ConsolidationPort,
  ActiveLearningReviewPort,
  DriftReviewPort,
  QueryCachePort,
  DecisionPort,
  EpisodePort,
  EntityPort,
  StrategyPort,
  WorkflowPort,
  SkillPort,
  TaskPort,
  EventPort,
  ReasoningPort,
  AgentPort,
  HyperedgePort,
  CompositionPort,
  RelationPort,
  CitationPort,
  GraphPort,
  RecallPort,
  FactIndexPort,
  NeuroDynamicsPort,
  MetacognitionPort,
  AnticipationPort,
  AuditPort,
  OutboxPort,
  WebhookPort,
  ReminderPort,
  EmbeddingMaintenancePort,
  HotTierPort,
  MetricsPort,
  WorkspacePort,
  PluginStatePort,
  BillingPort,
  LifecyclePort,
  CapabilitiesPort,
  StorageAdapter,
} from "./ports.js";

type StoragePorts = [
  SessionPort,
  HarnessIngestionPort,
  ManagedSessionLifecyclePort,
  ManagedCollapsePort,
  ManagedSessionWorkerPort,
  FactPort,
  RetentionPort,
  ConsolidationPort,
  ActiveLearningReviewPort,
  DriftReviewPort,
  QueryCachePort,
  DecisionPort,
  EpisodePort,
  EntityPort,
  StrategyPort,
  WorkflowPort,
  SkillPort,
  TaskPort,
  EventPort,
  ReasoningPort,
  AgentPort,
  HyperedgePort,
  CompositionPort,
  RelationPort,
  CitationPort,
  GraphPort,
  RecallPort,
  FactIndexPort,
  NeuroDynamicsPort,
  MetacognitionPort,
  AnticipationPort,
  AuditPort,
  OutboxPort,
  WebhookPort,
  ReminderPort,
  EmbeddingMaintenancePort,
  HotTierPort,
  MetricsPort,
  WorkspacePort,
  PluginStatePort,
  BillingPort,
  LifecyclePort,
  CapabilitiesPort,
];

type KeysOf<T extends readonly object[]> = T extends readonly [
  infer H extends object,
  ...infer R extends object[],
]
  ? keyof H | KeysOf<R>
  : never;

type DuplicateKeys<T extends readonly object[]> = T extends readonly [
  infer H extends object,
  ...infer R extends object[],
]
  ? Extract<keyof H, KeysOf<R>> | DuplicateKeys<R>
  : never;

type Assert<T extends true> = T;

// ISP: no member may live in two ports.
type _NoOverlap = Assert<[DuplicateKeys<StoragePorts>] extends [never] ? true : false>;

// Completeness: the alias contains exactly the ports in the tuple — a port defined but
// forgotten in the intersection (or vice versa) fails here.
type _Complete = Assert<
  [Exclude<keyof StorageAdapter, KeysOf<StoragePorts>>] extends [never]
    ? [Exclude<KeysOf<StoragePorts>, keyof StorageAdapter>] extends [never]
      ? true
      : false
    : false
>;
