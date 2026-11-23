/**
 * BENCH-1 — recall relevance regression gate.
 *
 * The 2026-10-17 evaluation measured default recall at 21–37% top-1 while raw
 * bge-m3 cosine over the same memories scored 92%, and agent tasks at 11/40
 * against 39/40 for pure cosine. This test replays those corpora through the
 * real recall facade (hot → pointer → cold, default `auto` mode) with the
 * evaluation's own bge-m3 vectors (frozen in ../relevance/vectors.json) and
 * fails when relevance regresses.
 *
 * Measured on the pipeline before WP-3, with this same harness: recall top-1
 * 7/62 and hit@5 7/62 on the first pass, decisions 0/8 in the top 5, no
 * negative ever flagged; agentsim 7/40 then 5/40 correct in the top 3.
 *
 * MNEMO_BENCH_REPORT=1 prints the measured numbers.
 * See ../relevance/harness.ts for what it can and cannot prove.
 */
import { describe, it, expect } from "vitest";
import {
  BENCH_AUTH,
  BENCH_WORKSPACE,
  buildWorkspace,
  correctAt,
  cosineCeiling,
  runAll,
  score,
  seedCoRecallHyperedges,
  type BenchWorkspace,
} from "../relevance/harness.js";

const report = (label: string, value: unknown) => {
  if (process.env.MNEMO_BENCH_REPORT) console.log(`[bench] ${label} ${JSON.stringify(value)}`);
};

/** What the evaluator's hot.py did: hammer one broad query to warm its facts. */
async function hammer(ws: BenchWorkspace, times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await ws.core.recall(
      {
        workspaceId: BENCH_WORKSPACE,
        text: "Eos observability Grafana Prometheus Loki Tempo retention",
        limit: 3,
      },
      BENCH_AUTH
    );
  }
}

describe("BENCH-1 fixture", () => {
  it("reproduces the evaluation's cosine ceiling on the recall corpus", async () => {
    const ws = await buildWorkspace("recall");
    const ceiling = score(ws, cosineCeiling(ws));
    report("recall ceiling", ceiling);
    expect(ceiling.positives).toBe(62);
    expect(ceiling.negatives).toBe(21);
    // offline.py measured hit@1 .919 (57/62) and hit@5 .984 (61/62).
    expect(ceiling.hit1).toBe(57);
    expect(ceiling.hit5).toBe(61);
    expect(ceiling.decisionQueries).toBe(8);
  });

  it("reproduces the evaluation's cosine oracle on the agentsim corpus", async () => {
    const ws = await buildWorkspace("agentsim");
    const at3 = correctAt(ws, cosineCeiling(ws), 3);
    report("agentsim ceiling@3", at3);
    expect(ws.corpus.queries).toHaveLength(40);
    // oracle.mjs: 39/40 correct in the top 3; its one miss is the trap Q31.
    expect(at3).toBe(39);
  });
});

describe("BENCH-1 default recall tracks the cosine ceiling", () => {
  it("recall corpus, first pass and warmed pass (RECALL-1, RECALL-2, RECALL-4)", async () => {
    const ws = await buildWorkspace("recall");
    const firstOutcomes = await runAll(ws);
    const first = score(ws, firstOutcomes);

    // Warm the workspace the way the evaluation did: every result set becomes
    // a co-recall hyperedge, then one broad query is recalled twelve times.
    await seedCoRecallHyperedges(ws, firstOutcomes);
    await hammer(ws);
    const warmedOutcomes = await runAll(ws);
    const warmed = score(ws, warmedOutcomes);
    report("recall first pass", first);
    report("recall warmed pass", warmed);

    // Ceiling: 57/62 top-1, 61/62 in the top 5. Measured: 56 and 61, then 57 and 61.
    expect(first.hit1).toBeGreaterThanOrEqual(54);
    expect(first.hit5).toBeGreaterThanOrEqual(60);
    expect(warmed.hit1).toBeGreaterThanOrEqual(54);
    expect(warmed.hit5).toBeGreaterThanOrEqual(60);
    // Use must not erode relevance (it went 11% → 13% top-1 before; the
    // server measured 21% → 37% → drifting with what was recalled last).
    expect(warmed.hit1).toBeGreaterThanOrEqual(first.hit1 - 1);
    // RECALL-4: every decision answer in the default top 5 (was 0/8).
    expect(first.decisionHit5).toBe(8);
    expect(warmed.decisionHit5).toBe(8);
    // Supersede and forget stay airtight.
    expect(first.staleInTop10).toBe(0);
    expect(warmed.staleInTop10).toBe(0);
    // RECALL-2: hyperedge co-members are hints, never hits — every hit the
    // vector pipeline serves carries the cosine it was ranked on.
    for (const o of warmedOutcomes) {
      for (const hit of o.hits) expect(hit.similarity, `${o.query.id} ${hit.id}`).toBeDefined();
    }
  });

  it("agentsim corpus: future-session tasks, twice (AGENTSIM-1)", async () => {
    const ws = await buildWorkspace("agentsim");
    // memory_recall's default limit is 5.
    const first = await runAll(ws, { limit: 5 });
    const second = await runAll(ws, { limit: 5 });
    const result = {
      firstAt3: correctAt(ws, first, 3),
      firstAt1: correctAt(ws, first, 1),
      secondAt3: correctAt(ws, second, 3),
    };
    report("agentsim", result);
    // Ceiling 39/40 (the trap Q31 has no right answer). Measured: 39, 37, 39.
    expect(result.firstAt3).toBeGreaterThanOrEqual(37);
    expect(result.firstAt1).toBeGreaterThanOrEqual(35);
    expect(result.secondAt3).toBeGreaterThanOrEqual(37);
  });
});

describe("BENCH-1 'nothing relevant' (RECALL-3, AGENTSIM-15)", () => {
  it("flags off-topic questions without flagging stored answers", async () => {
    const ws = await buildWorkspace("recall");
    const outcomes = await runAll(ws);
    const offTopic = outcomes.filter((o) => o.query.type === "offtopic");
    report(
      "nothingRelevant",
      outcomes
        .filter((o) => o.query.relevant.length === 0)
        .map((o) => [o.query.id, o.response.nothingRelevant, o.hits[0]?.similarity])
    );
    expect(offTopic).toHaveLength(4);
    for (const o of offTopic) expect(o.response.nothingRelevant, o.query.id).toBe(true);
    // bge-m3's calibrated floor (0.50) puts 2 of the 62 stored answers'
    // best hits below it (keyword queries at 0.44 and 0.46).
    expect(score(ws, outcomes).positivesFlagged).toBeLessThanOrEqual(2);
  });

  it("an explicit minSimilarity empties every negative, decisions included", async () => {
    // RECALL-3: with minSimilarity 0.5–0.7 the server still returned hits for
    // 17/17 negatives — decisions and hyperedge members skipped the floor.
    const ws = await buildWorkspace("recall");
    const floored = score(ws, await runAll(ws, { minSimilarity: 0.65 }));
    report("minSimilarity 0.65", floored);
    expect(floored.negativesFlagged).toBe(floored.negatives);
    // The price of 0.65 on bge-m3: answers below it go too (measured 51/62).
    expect(floored.hit5).toBeGreaterThanOrEqual(48);
  });
});
