#!/usr/bin/env node
// One-off backfill for Bug 2 (async fact-embedding gap).
//
// Some mnemo_fact rows have embedding IS NULL because their vector_upsert outbox
// entry was claimed and silently no-op'd by a buggy/stale outbox consumer before
// it reached the vector sink. The embedding vector is still recoverable: each
// such fact has a vector-form outbox payload { id, kind:"fact", vector:[...] }.
// This loops PgVectorAdapter.upsert over those rows to re-apply the embedding.
//
// Idempotent: only touches rows where embedding IS NULL. Re-running is safe.
//
// Usage (from anywhere in the repo, after `pnpm install`):
//   DATABASE_URL=postgres://mnemo:mnemo@localhost:55434/mnemo \
//     node scripts/backfill-fact-embeddings.mjs
import { createRequire } from "node:module";

// `postgres` and `@mnemosyne/adapter-vector` live in @mnemosyne/server's
// dependency tree; resolve from there so this script runs from the repo root.
const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const postgres = require("postgres");
const { PgVectorAdapter } = require("@mnemosyne/adapter-vector");

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(CONN, { connection: { search_path: "mnemosyne,public" } });
const vector = new PgVectorAdapter({ connectionString: CONN });

// Most-recent vector-form payload per NULL-embedding fact.
const rows = await sql`
  SELECT DISTINCT ON (f.id) f.id AS id, o.payload->'vector' AS vec
  FROM mnemosyne.mnemo_fact f
  JOIN mnemosyne.mnemo_outbox o
    ON (o.payload->>'id') = f.id::text
   AND o.event_type = 'vector_upsert'
   AND (o.payload->>'kind') = 'fact'
   AND (o.payload ? 'vector')
  WHERE f.embedding IS NULL
  ORDER BY f.id, o.created_at DESC
`;

let applied = 0,
  skipped = 0,
  failed = 0;
for (const r of rows) {
  const arr = r.vec;
  if (!Array.isArray(arr) || arr.length !== vector.dimensions) {
    skipped++;
    console.warn(`skip ${r.id}: payload vector len=${Array.isArray(arr) ? arr.length : "n/a"}`);
    continue;
  }
  try {
    // metadata { kind:"fact" } only — no model stamp, matching the live recall
    // path (embedding_model stays NULL like the already-embedded rows).
    await vector.upsert(r.id, Float32Array.from(arr), { kind: "fact" });
    applied++;
  } catch (err) {
    failed++;
    console.error(`fail ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(JSON.stringify({ candidates: rows.length, applied, skipped, failed }));

await vector.close();
await sql.end();
process.exit(failed > 0 ? 1 : 0);
