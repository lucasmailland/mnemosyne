import { describe, it, expect } from "vitest";
import { generateSyntheticCorpus } from "../synthetic-corpus.js";
import { evaluateQuestion, aggregateResults, type EvalHit } from "../metrics.js";
import { evaluateQualityGate, formatQualityGate } from "../quality-gates.js";

// Lexical baseline retriever: rank corpus facts by word-overlap with the query.
// Stands in for the live recall pipeline so the harness produces a real number
// in CI without Docker or the licensed dataset.
function shingles(t: string): Set<string> {
  return new Set(t.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

describe("§29 synthetic eval harness (end-to-end, no dataset)", () => {
  const K = 10;
  const corpus = generateSyntheticCorpus(30);

  function retrieve(query: string): EvalHit[] {
    const q = shingles(query);
    return corpus.facts
      .map((f) => ({ f, score: overlap(q, shingles(f.text)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, K)
      .map((x, i) => ({ factId: x.f.id, text: x.f.text, rank: i + 1 }));
  }

  it("runs the full pipeline (corpus → retrieve → metrics → gate) and produces a real result", () => {
    const results = corpus.questions.map((qn) => ({
      ...evaluateQuestion(qn.id, retrieve(qn.query), qn.truth, K),
      category: qn.category,
    }));
    const agg = aggregateResults(results, K);

    expect(agg.totalQuestions).toBe(30);
    expect(agg.recallAtK).toBeGreaterThan(0); // the harness actually retrieves
    expect(agg.recallAtK).toBeLessThanOrEqual(1);
    expect(Object.keys(agg.byCategory).length).toBeGreaterThan(0);

    // The gate evaluates the real result; a lexical baseline is not expected to
    // hit the v3.0 bar — what matters is the gate runs and reports honestly.
    const report = evaluateQualityGate({ result: agg });
    expect(typeof report.passed).toBe("boolean");
    expect(report.metrics.recallAtK).toBe(agg.recallAtK);
    expect(formatQualityGate(report)).toContain("Quality gate");
  });

  it("is deterministic — same corpus seed → identical metrics", () => {
    const c2 = generateSyntheticCorpus(30);
    expect(c2.facts).toEqual(corpus.facts);
    expect(c2.questions).toEqual(corpus.questions);
  });
});
