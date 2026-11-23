#!/usr/bin/env node
// P74 backfill — recover writes the surprise gate discarded.
//
// Until P74, a write whose prediction error fell below MNEMO_SURPRISE_THRESHOLD
// was diverted into a `staging_evaluation` queue job instead of being written.
// That path was broken end to end: the outbox payload was written flat while
// OutboxWorker destructures `{ job, data, opts }` (so `{}` was enqueued), no
// consumer for the job was ever registered, and the id handed back to the
// caller was a fabricated crypto.randomUUID() matching no row.
//
// The content itself survived: it is still sitting in `mnemo_outbox`, because
// purge_outbox() has never had a caller. This script replays those rows through
// POST /remember so they take the ordinary write path — embedding, outbox,
// audit and conflict resolution included. Writing them straight into mnemo_fact
// via SQL would skip all four.
//
// Idempotent: every recovered row is stamped with `p74BackfilledAt` in its
// payload, and stamped rows are excluded from subsequent runs.
//
// Dry run by default — prints what it would replay and exits.
//
// Usage:
//   DATABASE_URL=postgres://mnemo:mnemo@localhost:55434/mnemo \
//   MNEMO_BASE_URL=http://localhost:3939 \
//   MNEMO_API_KEY=mns_live_... \
//     node scripts/backfill-p74-staged-writes.mjs [--apply] [--limit N] [--workspace <uuid>]
//
// What a replay actually recovers: since P85.3 wired content-hash idempotency, a
// row whose statement already exists as an active fact returns that fact's id
// rather than creating a duplicate. On the dev instance 201 of 202 distinct
// statements were already present — the surprise gate fired precisely BECAUSE
// they were near-duplicates — so a replay there recovers ONE genuinely lost
// fact and bumps seenCount on the rest. Measure before assuming the row count
// is the loss count.
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const postgres = require("postgres");

const CONN = process.env.DATABASE_URL;
const BASE_URL = (process.env.MNEMO_BASE_URL ?? "http://localhost:3939").replace(/\/$/, "");
const API_KEY = process.env.MNEMO_API_KEY;

const apply = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 1000;
// --workspace narrows the replay to one workspace. Added after the first real
// dry-run: 200 of 209 discarded rows on the dev instance sat in a synthetic
// workspace, and replaying those would import test noise into a live corpus.
// Targeting is the difference between a recovery and a mess.
const wsArg = process.argv.indexOf("--workspace");
const onlyWorkspace = wsArg !== -1 ? process.argv[wsArg + 1] : undefined;

if (!CONN) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (apply && !API_KEY) {
  console.error("MNEMO_API_KEY is required with --apply");
  process.exit(1);
}
if (!Number.isInteger(limit) || limit <= 0) {
  console.error(`--limit must be a positive integer (got ${process.argv[limitArg + 1]})`);
  process.exit(1);
}

const sql = postgres(CONN, { connection: { search_path: "mnemosyne,public" } });

// The orphaned producer wrote its arguments FLAT alongside `job` — that shape
// is the reason the content never reached the queue, and it is also how these
// rows are still readable today.
const rows = await sql`
  SELECT id, workspace_id, payload, created_at
  FROM mnemosyne.mnemo_outbox
  WHERE event_type = 'queue_job'
    AND payload->>'job' = 'staging_evaluation'
    AND NOT (payload ? 'p74BackfilledAt')
    AND payload->>'content' IS NOT NULL
    ${onlyWorkspace ? sql`AND workspace_id = ${onlyWorkspace}` : sql``}
  ORDER BY created_at ASC
  LIMIT ${limit}
`;

if (rows.length === 0) {
  console.log("nothing to backfill: no unrecovered staging_evaluation rows found");
  await sql.end();
  process.exit(0);
}

const byWorkspace = new Map();
for (const r of rows) {
  byWorkspace.set(r.workspace_id, (byWorkspace.get(r.workspace_id) ?? 0) + 1);
}

console.log(
  `found ${rows.length} discarded write(s) across ${byWorkspace.size} workspace(s)` +
    `${onlyWorkspace ? ` (filtered to ${onlyWorkspace})` : ""}:`
);
for (const [ws, n] of byWorkspace) console.log(`  ${ws}: ${n}`);
console.log(`  oldest: ${rows[0].created_at.toISOString()}`);
console.log(`  newest: ${rows[rows.length - 1].created_at.toISOString()}`);

if (!apply) {
  console.log("\ndry run — re-run with --apply to replay these through POST /remember");
  await sql.end();
  process.exit(0);
}

let recovered = 0,
  failed = 0;
for (const r of rows) {
  const p = r.payload;
  try {
    const res = await fetch(`${BASE_URL}/remember`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        kind: p.kind ?? "fact",
        // The outbox payload calls it `content` (that is the field name the
        // orphaned producer wrote); POST /remember's body schema calls it
        // `statement`. Sending `content` returns a 400 ZodError on every row —
        // which is exactly what the first --apply run against a live server
        // did, and no unit test could have caught: the script talks HTTP.
        statement: p.content,
        // Cross-workspace targeting travels in the BODY (P57), not a header, and
        // requires the key's user to have membership in the target workspace —
        // see resolveTargetWorkspace in routes/remember.ts. Rows belonging to the
        // key's own workspace are unaffected by sending it.
        targetWorkspaceId: r.workspace_id,
        ...(p.subject ? { subject: p.subject } : {}),
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        metadata: {
          p74Recovered: true,
          originalOutboxId: r.id,
          originalPredictionError: p.pe ?? null,
          originallyDiscardedAt: r.created_at.toISOString(),
        },
      }),
    });
    if (!res.ok) {
      failed++;
      console.error(`  FAIL outbox ${r.id}: HTTP ${res.status} ${await res.text()}`);
      continue;
    }
    // Stamp only after the write is confirmed, so a crash mid-run re-tries
    // rather than silently marking an unrecovered row as done.
    await sql`
      UPDATE mnemosyne.mnemo_outbox
      SET payload = payload || jsonb_build_object('p74BackfilledAt', now()::text)
      WHERE id = ${r.id}
    `;
    recovered++;
  } catch (err) {
    failed++;
    console.error(`  FAIL outbox ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nrecovered=${recovered} failed=${failed} of ${rows.length}`);
await sql.end();
process.exit(failed > 0 ? 1 : 0);
