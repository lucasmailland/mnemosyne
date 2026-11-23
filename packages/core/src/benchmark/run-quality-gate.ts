/**
 * packages/core/src/benchmark/run-quality-gate.ts
 *
 * §29 quality gate CI entrypoint. Uses the synthetic corpus with a perfect
 * oracle retriever (returns the exact truth facts, rank 1–K) so the gate is
 * guaranteed to pass on correct code, and fails the build if any gate logic
 * or threshold is broken.
 *
 * Usage:  pnpm --filter @mnemo-ai/core bench:quality
 */

import { generateSyntheticCorpus } from "./synthetic-corpus.js";
import { evaluateQuestion, aggregateResults, type EvalHit } from "./metrics.js";
import { evaluateQualityGate, formatQualityGate } from "./quality-gates.js";

const K = 10;
const corpus = generateSyntheticCorpus(50);

// Perfect oracle: return the truth facts in rank order.
function retrieve(truthFactIds: string[]): EvalHit[] {
  return truthFactIds.slice(0, K).map((factId, i) => ({
    factId,
    text: corpus.facts.find((f) => f.id === factId)?.text ?? "",
    rank: i + 1,
  }));
}

const results = corpus.questions.map((qn) => ({
  ...evaluateQuestion(qn.id, retrieve(qn.truth.factIds), qn.truth, K),
  category: qn.category,
}));

const agg = aggregateResults(results, K);
const report = evaluateQualityGate({ result: agg });

console.log(formatQualityGate(report));

if (!report.passed) {
  console.error("\nQuality gate FAILED. See failures above.");
  process.exit(1);
}

console.log("\nQuality gate passed.");
