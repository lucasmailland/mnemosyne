// packages/core/src/benchmark/synthetic-corpus.ts
//
// §29 — deterministic synthetic eval corpus, so the quality harness produces a
// REAL number in CI without the (licensed, out-of-repo) LongMemEval dataset.
// Swap this generator for the official loader once the dataset is available; the
// metrics engine + gate (metrics.ts / quality-gates.ts) are unchanged either way.
//
// Pure + deterministic (no Math.random / Date.now) — same input → same corpus,
// which is required for a stable regression gate.

import type { GroundTruth } from "./metrics.js";

export interface CorpusFact {
  id: string;
  text: string;
}

export interface CorpusQuestion {
  id: string;
  category: string;
  query: string;
  truth: GroundTruth;
}

export interface SyntheticCorpus {
  facts: CorpusFact[];
  questions: CorpusQuestion[];
}

const CATEGORIES = [
  "single-session-user",
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
  "preference",
] as const;

// Small deterministic vocabulary so questions share enough lexical signal with
// their ground-truth fact for a lexical baseline retriever to be meaningful.
const SUBJECTS = ["deploy", "database", "auth", "cache", "billing", "search", "pipeline", "session"];
const PREDICATES = ["uses", "requires", "prefers", "defaults to", "is limited to", "depends on"];
const OBJECTS = ["blue-green rollout", "postgres 17", "argon2 hashing", "redis lru", "stripe metering", "hnsw vectors", "github actions", "a 24h ttl"];

/**
 * Generate a deterministic corpus of `n` facts and `n` questions (one per fact,
 * round-robin over categories). Each question's ground truth is its source fact;
 * a distractor variant is included to exercise precision.
 */
export function generateSyntheticCorpus(n = 50): SyntheticCorpus {
  const facts: CorpusFact[] = [];
  const questions: CorpusQuestion[] = [];

  for (let i = 0; i < n; i++) {
    const s = SUBJECTS[i % SUBJECTS.length]!;
    const p = PREDICATES[i % PREDICATES.length]!;
    const o = OBJECTS[i % OBJECTS.length]!;
    const factId = `f${i}`;
    const statement = `The ${s} ${p} ${o}.`;
    facts.push({ id: factId, text: statement });

    // A distractor fact (same subject, different object) to make precision matter.
    const distractObj = OBJECTS[(i + 1) % OBJECTS.length]!;
    facts.push({ id: `d${i}`, text: `The ${s} also mentions ${distractObj} historically.` });

    questions.push({
      id: `q${i}`,
      category: CATEGORIES[i % CATEGORIES.length]!,
      query: `What does the ${s} ${p}?`,
      truth: { factIds: [factId], acceptedAnswers: [o] },
    });
  }

  return { facts, questions };
}
