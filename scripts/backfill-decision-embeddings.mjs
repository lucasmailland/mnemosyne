#!/usr/bin/env node
// Backfill for make-primitives-recallable (design.md D5, tasks.md 4.1-4.3).
//
// Decisions written before this change never had a query that could return
// them (design.md's root-cause correction: both retrieval arms were
// fact-only). This script does NOT re-embed anything itself and does NOT
// touch validFrom/validTo/revisionCount -- it only INSERTs a text-form
// `vector_upsert` outbox row for each decision that still needs one,
// mirroring exactly what DecisionRepository.createDecision/
// mergeDecisionByTopicKey already enqueue in-transaction on every live
// write. The already-running OutboxWorker (server/src/index.ts's injected
// embedder) picks the row up and does the real embedding, same production
// path as every other decision write -- so this script cannot drift from
// the live indexing behaviour.
//
// INSERT-only: the only statement that writes is `INSERT INTO mnemo_outbox`.
// mnemo_decision itself is never UPDATEd, so "must not alter
// validFrom/validTo/revisionCount" holds by construction, not by discipline.
//
// Idempotent + resumable: a decision is a candidate only when its embedding
// is missing/stale AND it has no unprocessed vector_upsert outbox entry
// already pending. Once an entry exists (pending or later processed), the
// decision drops out of the candidate set on the next run -- re-running is
// always safe, including mid-drain.
//
// Usage (from anywhere in the repo, after `pnpm install` + `pnpm build`):
//   DATABASE_URL=postgres://mnemo:mnemo@localhost:55434/mnemo \
//     node scripts/backfill-decision-embeddings.mjs [--workspace <id>] [--limit <n>] [--dry-run]
//
// Flags:
//   --workspace <id>  Only backfill decisions in this workspace. Default: all workspaces.
//   --limit <n>       Cap the number of outbox rows enqueued this run. Default: 10000.
//   --dry-run         Report candidates without inserting anything.
import { createRequire } from "node:module";

// `postgres` and `@mnemo-ai/types` live in @mnemo-ai/adapter-postgres's
// dependency tree; resolve from there so this script runs from the repo
// root. Mirrors scripts/backfill-fact-embeddings.mjs's own createRequire
// pattern (anchored to a package that actually declares the dependency).
const require = createRequire(
  new URL("../packages/adapter-postgres/package.json", import.meta.url)
);
const postgres = require("postgres");
const { PRIMITIVE_TEXT_PROJECTION } = require("@mnemo-ai/types");

function parseArgs(argv) {
  const args = { limit: 10000, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") args.workspace = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

// Same projection the write path uses (packages/types/src/indexing.ts) —
// title + " " + body, skipping any absent/empty field. Kept in lockstep by
// reading PRIMITIVE_TEXT_PROJECTION.decision directly rather than
// re-deriving the join rule here.
function projectDecisionText(title, body) {
  const projection = PRIMITIVE_TEXT_PROJECTION.decision;
  const row = { title, body };
  return projection.fields
    .map((field) => row[field])
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(projection.separator);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      "Usage: DATABASE_URL=... node scripts/backfill-decision-embeddings.mjs [--workspace <id>] [--limit <n>] [--dry-run]"
    );
    process.exit(0);
  }

  const CONN = process.env.DATABASE_URL;
  if (!CONN) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const sql = postgres(CONN, { connection: { search_path: "mnemosyne,public" } });

  try {
    // Candidates: embedding missing or explicitly stale, and no pending
    // (unprocessed) vector_upsert outbox entry already enqueued for them —
    // this is what makes a second run a no-op instead of double-enqueuing.
    const rows = await sql`
      SELECT d.id AS id, d.workspace_id AS workspace_id, d.title AS title, d.body AS body
      FROM mnemosyne.mnemo_decision d
      WHERE (d.embedding IS NULL OR d.embedding_stale = true)
        AND (${args.workspace ?? null}::text IS NULL OR d.workspace_id = ${args.workspace ?? null})
        AND NOT EXISTS (
          SELECT 1 FROM mnemosyne.mnemo_outbox o
          WHERE o.event_type = 'vector_upsert'
            AND (o.payload ->> 'id') = d.id
            AND (o.payload ->> 'kind') = 'decision'
            AND o.processed_at IS NULL
        )
      ORDER BY d.created_at
      LIMIT ${args.limit}
    `;

    let enqueued = 0,
      skipped = 0;

    for (const row of rows) {
      const text = projectDecisionText(row.title, row.body);
      if (!text) {
        skipped++;
        console.warn(`skip ${row.id}: empty projected text (no title/body)`);
        continue;
      }
      if (args.dryRun) {
        enqueued++; // counted as "would enqueue" for the dry-run summary
        continue;
      }
      await sql`
        INSERT INTO mnemosyne.mnemo_outbox (workspace_id, event_type, payload)
        VALUES (
          ${row.workspace_id}::uuid,
          'vector_upsert',
          ${sql.json({ id: row.id, kind: "decision", text })}
        )
      `;
      enqueued++;
    }

    console.log(
      JSON.stringify({
        candidates: rows.length,
        enqueued,
        skipped,
        dryRun: args.dryRun,
        workspace: args.workspace ?? "all",
      })
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
