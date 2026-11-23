/**
 * packages/core/src/benchmark/bench.ts — Wave V §29 (tinybench benchmarks)
 *
 * Deterministic micro-benchmarks using tinybench + InMemoryStorageAdapter.
 * No DB, no network — all I/O is in-process.
 *
 * Run: pnpm --filter @mnemo-ai/core bench
 *
 * Results are printed to stdout in a table. For CI regression gates, compare
 * the `hz` (operations/sec) against a baseline stored in bench-baseline.json.
 *
 * Benchmark categories:
 *   1. recall-cold (vectorSearch path — in-memory vector store)
 *   2. remember (append-only write path — no LLM, uses stub embedder)
 *   3. wilsonLowerBound (pure-math utility, sanity-check for algorithmic cost)
 *   4. lshBands (locality-sensitive hash utility)
 */

import { Bench } from "tinybench";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { wilsonLowerBound } from "../cognitive/worth.js";
import { lshBands } from "../cognitive/lsh.js";

// ─── Minimal stub adapters ────────────────────────────────────────────────────

/** Zero-latency embed stub — returns a fixed random-ish 1536-dim vector. */
function stubEmbedAdapter() {
  const fixed = new Float32Array(1536).map((_, i) => Math.sin(i * 0.01));
  return {
    embedSingle: (_text: string) => Promise.resolve(fixed),
    embedBatch: (texts: string[]) =>
      Promise.resolve(texts.map(() => fixed)),
  };
}

/** Minimal no-op telemetry. */
function stubTelemetry() {
  return {
    startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
}

/** Minimal no-op logger. */
function stubLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => stubLogger(),
  };
}

/** Minimal in-memory vector adapter (dot-product, no HNSW). */
function stubVectorAdapter(size = 1536) {
  const index = new Map<string, Float32Array>();
  return {
    upsert: (id: string, vec: Float32Array, _meta?: unknown) => {
      index.set(id, vec);
      return Promise.resolve();
    },
    delete: (id: string) => {
      index.delete(id);
      return Promise.resolve();
    },
    search: (query: Float32Array, k: number, _opts?: unknown) => {
      // Brute-force cosine similarity
      const scores: Array<{ id: string; score: number }> = [];
      for (const [id, vec] of index) {
        let dot = 0;
        for (let i = 0; i < size; i++) dot += (query[i] ?? 0) * (vec[i] ?? 0);
        scores.push({ id, score: dot });
      }
      scores.sort((a, b) => b.score - a.score);
      return Promise.resolve(scores.slice(0, k));
    },
    healthCheck: () => Promise.resolve({ status: "ok" as const }),
  };
}

/** Minimal no-op outbox adapter. */
function stubOutboxAdapter() {
  return {
    appendOutbox: () => Promise.resolve(),
  };
}

// ─── Benchmark setup ──────────────────────────────────────────────────────────

const WS = "bench-workspace";

async function buildContext(factCount = 100) {
  const storage = new InMemoryStorageAdapter();
  const vector = stubVectorAdapter();
  const embed = stubEmbedAdapter();
  const telemetry = stubTelemetry();
  const logger = stubLogger();

  // Pre-populate with `factCount` facts
  const embedding = embed.embedSingle("warm-up");
  const warmEmbed = await embedding;

  for (let i = 0; i < factCount; i++) {
    const fact = await storage.createFact({
      workspaceId: WS,
      agentId: "bench-agent",
      actorId: "bench-actor",
      scope: "global",
      statement: `Benchmark fact ${i}: the system is optimised for low-latency recall`,
      subject: `entity-${i % 10}`,
      kind: "preference",
      confidence: 0.8,
      validFrom: new Date(),
      metadata: {},
    });
    await vector.upsert(fact.id, warmEmbed);
  }

  return {
    storage,
    vector,
    embed,
    telemetry,
    logger,
    outbox: stubOutboxAdapter(),
    config: {
      maxHotTierSize: 100,
      worthDecayLambda: 0.1,
      surpriseThreshold: 0.1,
      hotTierTtlSeconds: 300,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
    },
  };
}

// ─── Run benchmarks ───────────────────────────────────────────────────────────

async function main() {
  console.log("Building benchmark context (100 facts)...");
  const ctx = await buildContext(100);

  const bench = new Bench({
    warmup: true,
    warmupIterations: 5,
    iterations: 50,
    time: 500, // ms
  });

  // ── Benchmark 1: wilsonLowerBound (pure math) ──────────────────────────────
  bench.add("wilsonLowerBound(alpha=3, beta=2)", () => {
    wilsonLowerBound(3, 2);
  });

  // ── Benchmark 2: lshBands (pure CPU, 1536-dim) ─────────────────────────────
  const testVec = new Float32Array(1536).map((_, i) => Math.cos(i * 0.02));
  bench.add("lshBands(1536-dim vector)", () => {
    lshBands(testVec);
  });

  // ── Benchmark 3: vector search (in-memory, 100 facts, k=10) ───────────────
  bench.add("vector.search(k=10, n=100)", async () => {
    const q = await ctx.embed.embedSingle("what are the system preferences?");
    await ctx.vector.search(q, 10);
  });

  // ── Benchmark 4: storage.queryFacts — filter by workspace (InMemory) ──────
  bench.add("storage.queryFacts(workspace)", async () => {
    await ctx.storage.queryFacts({ workspaceId: WS });
  });

  // ── Benchmark 5: storage.createFact (append-only write) ───────────────────
  bench.add("storage.createFact (write)", async () => {
    await ctx.storage.createFact({
      workspaceId: WS,
      agentId: "bench-agent",
      actorId: "bench-actor",
      scope: "global",
      statement: `Write benchmark fact ${Date.now()}`,
      subject: "entity-write",
      kind: "preference",
      confidence: 0.9,
      validFrom: new Date(),
      metadata: {},
    });
  });

  await bench.run();

  console.log("\n=== Mnemosyne Core Benchmarks (Wave V §29) ===\n");

  type TaskWithStats = { latency: { mean: number; p50: number; p99: number }; throughput: { mean: number } };

  function taskStats(task: { result: { state: string } }): TaskWithStats | null {
    const r = task.result as { state: string } & Partial<TaskWithStats>;
    if (r.state === "completed" || r.state === "aborted-with-statistics") {
      return r as unknown as TaskWithStats;
    }
    return null;
  }

  console.table(
    bench.tasks.map((task) => {
      const s = taskStats(task);
      return {
        Benchmark: task.name,
        "ops/sec": s ? Math.round(s.throughput.mean).toLocaleString() : "N/A",
        "p50 (ms)": s ? s.latency.p50.toFixed(3) : "N/A",
        "p99 (ms)": s ? s.latency.p99.toFixed(3) : "N/A",
        "Mean (ms)": s ? s.latency.mean.toFixed(3) : "N/A",
      };
    }),
  );

  // Emit machine-readable results for the CI regression gate.
  const { writeFileSync } = await import("node:fs");
  const out = {
    generatedAt: new Date().toISOString(),
    tasks: bench.tasks.map((t) => {
      const s = taskStats(t);
      return {
        name: t.name,
        hz: s ? s.throughput.mean : 0,
        p50: s ? s.latency.p50 : 0,
        p99: s ? s.latency.p99 : 0,
        mean: s ? s.latency.mean : 0,
      };
    }),
  };
  const target = process.env.BENCH_OUT ?? "bench-results.json";
  writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${target} (${out.tasks.length} tasks).`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
