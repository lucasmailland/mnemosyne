// packages/mnemosyne/src/benchmark/index.ts
//
// v1.1 #29 — LongMemEval benchmark public barrel.
// Re-exports the metrics engine and fixtures so host-side benchmark
// runners can import without touching internal paths.

export {
  evaluateQuestion,
  computeCategoryMetrics,
  aggregateResults,
  formatBenchmarkReport,
  type GroundTruth,
  type EvalHit,
  type QuestionResult,
  type BenchmarkResult,
  type CategoryMetrics,
} from "./metrics";

export {
  BENCHMARK_QUESTIONS,
  getFixture,
  fixturesByCategory,
  type BenchmarkQuestion,
  type BenchmarkFact,
} from "./fixtures";

export {
  evaluateQualityGate,
  compareVersions,
  formatQualityGate,
  V3_QUALITY_TARGETS,
  V1_6_QUALITY_TARGETS,
  type QualityTargets,
  type QualityGateInput,
  type QualityGateReport,
  type VersionComparison,
} from "./quality-gates";

export {
  generateSyntheticCorpus,
  type SyntheticCorpus,
  type CorpusFact,
  type CorpusQuestion,
} from "./synthetic-corpus";
