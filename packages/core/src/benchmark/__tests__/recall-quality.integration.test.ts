/**
 * VER-3 — Recall quality harness (lexical, in-process).
 *
 * Loads eval-fixture.json (8 facts, 6 questions), inserts facts into
 * InMemoryStorageAdapter + a brute-force bag-of-words vector adapter, runs
 * top-5 recall for each question, and asserts R@5 ≥ 0.95.
 *
 * No Docker / testcontainers required — deterministic and fast (<200ms).
 * Placed under the integration config so it's opt-in and can be extended with
 * a real pgvector backend later without touching the CI defaults.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import {
  evaluateQuestion,
  aggregateResults,
  formatBenchmarkReport,
} from "../metrics.js";
import type { EvalHit, GroundTruth } from "../metrics.js";

// ── Fixture loading ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "..", "eval-fixture.json");

interface FixtureFact {
  id: string;
  statement: string;
  subject: string;
  kind: string;
}

interface FixtureQuestion {
  id: string;
  text: string;
  groundTruth: GroundTruth;
  category: string;
}

interface Fixture {
  facts: FixtureFact[];
  questions: FixtureQuestion[];
}

// ── Bag-of-words vector utilities ──────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "in", "of", "and", "to", "for", "on", "at",
  "it", "its", "as", "that", "are", "was", "were", "by", "be", "been",
  "has", "have", "had", "do", "does", "did", "will", "would", "could",
  "with", "from", "this", "or", "not", "which", "than",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function buildVocabulary(texts: string[]): Map<string, number> {
  const vocab = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (!vocab.has(token)) {
        vocab.set(token, vocab.size);
      }
    }
  }
  return vocab;
}

function bow(text: string, vocab: Map<string, number>): Float32Array {
  const vec = new Float32Array(vocab.size);
  for (const token of tokenize(text)) {
    const idx = vocab.get(token);
    if (idx !== undefined) vec[idx] = (vec[idx] ?? 0) + 1;
  }
  // L2 normalise
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

// ── Test setup ─────────────────────────────────────────────────────────────────

const WS = "recall-quality-test";
let fixture: Fixture;
let storage: InMemoryStorageAdapter;
let vocab: Map<string, number>;
/** Map from fact fixture-id ("fact-N") to storage fact ID + BOW vector. */
let factIndex: Map<string, { storageId: string; vec: Float32Array; statement: string }>;

beforeAll(async () => {
  const raw = await readFile(FIXTURE_PATH, "utf-8");
  fixture = JSON.parse(raw) as Fixture;

  // Build vocab from all fact statements
  vocab = buildVocabulary(fixture.facts.map((f) => f.statement));

  storage = new InMemoryStorageAdapter();
  factIndex = new Map();

  for (const f of fixture.facts) {
    const fact = await storage.createFact({
      workspaceId: WS,
      agentId: "test-agent",
      actorId: "test-actor",
      scope: "global",
      statement: f.statement,
      subject: f.subject,
      kind: "other",
      confidence: 0.9,
      validFrom: new Date("2026-01-01"),
      metadata: {},
    });
    factIndex.set(f.id, { storageId: fact.id, vec: bow(f.statement, vocab), statement: f.statement });
  }
});

// ── Recall helper ──────────────────────────────────────────────────────────────

function recall(queryText: string, k: number): EvalHit[] {
  const qvec = bow(queryText, vocab);

  // Score all facts
  const scores: Array<{ factFixtureId: string; score: number; statement: string; storageId: string }> = [];
  for (const [fixtureId, entry] of factIndex) {
    scores.push({
      factFixtureId: fixtureId,
      score: cosineSimilarity(qvec, entry.vec),
      statement: entry.statement,
      storageId: entry.storageId,
    });
  }
  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, k).map((s, i) => ({
    factId: s.storageId,
    text: s.statement,
    rank: i + 1,
  }));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("recall-quality harness — R@5 ≥ 0.95 (VER-3)", () => {
  it("recall top-5 correctly identifies the relevant fact for each question", () => {
    const K = 5;
    const qResults: Array<ReturnType<typeof evaluateQuestion> & { category: string }> = [];

    for (const q of fixture.questions) {
      const hits = recall(q.text, K);

      // Map fixture factIds to storage IDs for ground truth
      const mappedTruth: GroundTruth = {
        factIds: q.groundTruth.factIds.map((fid) => {
          const entry = factIndex.get(fid);
          if (!entry) throw new Error(`Fixture fact ${fid} not in index`);
          return entry.storageId;
        }),
        acceptedAnswers: q.groundTruth.acceptedAnswers,
      };

      const result = evaluateQuestion(q.id, hits, mappedTruth, K);
      qResults.push({ ...result, category: q.category });
    }

    const report = aggregateResults(qResults, K);
    console.log("\n" + formatBenchmarkReport(report));

    // Per-question detail for debugging failures
    for (const r of report.perQuestion) {
      expect(r.hitAtK, `Question ${r.questionId} not found in top-${K}`).toBe(true);
    }

    // Aggregate gate
    expect(report.recallAtK).toBeGreaterThanOrEqual(0.95);
    expect(report.totalQuestions).toBe(fixture.questions.length);
  });

  it("answer-coverage ≥ 0.95 — recalled text contains accepted answer phrase", () => {
    const K = 5;
    const qResults: Array<ReturnType<typeof evaluateQuestion> & { category: string }> = [];

    for (const q of fixture.questions) {
      const hits = recall(q.text, K);
      const mappedTruth: GroundTruth = {
        factIds: q.groundTruth.factIds.map((fid) => factIndex.get(fid)!.storageId),
        acceptedAnswers: q.groundTruth.acceptedAnswers,
      };
      qResults.push({ ...evaluateQuestion(q.id, hits, mappedTruth, K), category: q.category });
    }

    const report = aggregateResults(qResults, K);
    expect(report.answerCoverage).toBeGreaterThanOrEqual(0.95);
  });
});
