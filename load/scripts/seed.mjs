#!/usr/bin/env node
// Seeds N facts into Mnemosyne via the API.
//
// Usage:
//   MNEMO_BASE_URL=http://localhost:3939 \
//   MNEMO_TEST_API_KEY=mk_test_localdev \
//   node load/scripts/seed.mjs --count 1000
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    count: { type: "string", default: "1000" },
    batch: { type: "string", default: "50" },
    url: { type: "string" },
    key: { type: "string" },
  },
});

const COUNT = parseInt(values.count, 10);
const BATCH = parseInt(values.batch, 10);
const BASE_URL = values.url || process.env.MNEMO_BASE_URL || "http://localhost:3939";
const API_KEY = values.key || process.env.MNEMO_TEST_API_KEY || "mk_test_localdev";

const TOPICS = [
  "infra/pg",
  "infra/redis",
  "api/auth",
  "ml/embeddings",
  "ops/deploy",
  "core/worth",
  "core/collapse",
  "core/recall",
  "docs/architecture",
  "docs/api",
  "security/rls",
  "perf/indexes",
];

const FACT_TEMPLATES = [
  "The system uses PostgreSQL with pgvector for vector similarity search.",
  "Redis is used as the hot tier for frequently-accessed facts.",
  "The HNSW index uses m=16 ef_construction=64 for 1536-dim halfvec embeddings.",
  "Row-level security is enforced in FORCE mode on all workspace-scoped tables.",
  "The session collapse pipeline uses LLM to summarize conversation history.",
  "API keys are prefixed with mk_ and set workspace context via the auth middleware.",
  "The worth scoring system uses Beta-Bernoulli updating with TD(λ) propagation.",
  "Federation uses LWW conflict resolution with supermajority consensus override.",
  "The anticipation engine blends 4 signals: recency, frequency, context, and explicit triggers.",
  "Consolidation merges near-duplicate facts using cosine similarity thresholds.",
];

function randomFact(i) {
  const base = FACT_TEMPLATES[i % FACT_TEMPLATES.length];
  return `${base} (seed-${Math.floor(i / FACT_TEMPLATES.length)})`;
}

function randomTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

async function seedBatch(start, size) {
  const promises = [];
  for (let i = start; i < start + size && i < COUNT; i++) {
    promises.push(
      fetch(`${BASE_URL}/remember`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          statement: randomFact(i),
          confidence: 0.85 + Math.random() * 0.15,
          topicKey: randomTopic(),
          tags: ["seeded"],
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const text = await r.text().catch(() => r.status.toString());
          throw new Error(`HTTP ${r.status}: ${text}`);
        }
        return r.json();
      })
    );
  }
  return Promise.all(promises);
}

async function main() {
  console.log(`Seeding ${COUNT} facts to ${BASE_URL} ...`);
  let done = 0;
  let errors = 0;

  for (let i = 0; i < COUNT; i += BATCH) {
    const batchSize = Math.min(BATCH, COUNT - i);
    try {
      await seedBatch(i, batchSize);
      done += batchSize;
    } catch (e) {
      errors += batchSize;
      process.stderr.write(`\nBatch ${i}-${i + batchSize} failed: ${e.message}\n`);
    }
    process.stdout.write(`\rProgress: ${done}/${COUNT} (${errors} errors)`);
  }
  console.log(`\nDone. Seeded ${done} facts, ${errors} errors.`);
  if (errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
