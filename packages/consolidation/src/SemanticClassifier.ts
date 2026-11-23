// Semantic classifier for consolidation deep mode (gap1-consolidate) and the
// write-time scoped conflict check.
//
// Classifies a pair of facts as DUPLICATE, CONTRADICTION, or COMPATIBLE. The
// implementation lives in `@mnemo-ai/core` so the write path (remember) shares
// the same prompt and parser; this module re-exports it under its historical
// path.
//
// LIFECYCLE-14: a failed call or an unreadable reply now REJECTS with
// `FactPairClassificationError` instead of returning a non-confident
// COMPATIBLE. Deep mode persists COMPATIBLE as `not_conflict` and never
// reclassifies the pair, so the old fallback turned a model outage into
// permanent judgments. The scheduler's catch branch (skip, no merge, no
// relation) is the path a failure now takes.

export { classifyFactPair, FactPairClassificationError } from "@mnemo-ai/core/cognitive";
export type {
  SemanticClass,
  ClassifyFactPairResult,
  FactPairClassifierLLM,
} from "@mnemo-ai/core/cognitive";
