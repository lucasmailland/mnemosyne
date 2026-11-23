#!/usr/bin/env tsx
// One-time helper for existing databases that have all 75 original v3 migrations applied.
// Inserts a sentinel row in mnemosyne.schema_migrations for the squash file.
// Leaves the 75 original rows intact.
//
// Usage: DATABASE_URL=postgres://... npx tsx scripts/mark-squash-applied.ts
//
// --update-checksums flag:
//   Scans all .sql files in migrations/baseline/ (excluding .down.sql), and for
//   each file that already has a row in mnemosyne.schema_migrations, recomputes
//   the SHA-256 checksum and updates the stored value if it differs.
//   Does NOT insert new rows — use the default mode (no flag) for that.
//
// Usage: DATABASE_URL=postgres://... npx tsx scripts/mark-squash-applied.ts --update-checksums

import postgres from "postgres";
import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

async function updateChecksums() {
  const squashDir = join(__dirname, "../migrations/baseline");

  // Discover all non-down SQL files
  const files = readdirSync(squashDir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();

  if (files.length === 0) {
    console.log("No .sql files found in migrations/baseline/");
    await sql.end();
    return;
  }

  console.log(`Scanning ${files.length} file(s) in migrations/baseline/\n`);

  const updated: string[] = [];
  const unchanged: string[] = [];
  const newFiles: string[] = [];

  for (const filename of files) {
    const filePath = join(squashDir, filename);
    const currentChecksum = computeChecksum(filePath);

    // Check whether this file exists in schema_migrations
    const rows = await sql<{ filename: string; checksum: string }[]>`
      SELECT filename, checksum
      FROM mnemosyne.schema_migrations
      WHERE filename = ${filename}
    `;

    if (rows.length === 0) {
      // Not in the table yet — report as new (skip insert)
      newFiles.push(filename);
      console.log(`  NEW      ${filename}`);
      console.log(`           (not in schema_migrations — run without --update-checksums to insert)`);
      continue;
    }

    const storedChecksum = rows[0].checksum;

    if (storedChecksum === currentChecksum) {
      unchanged.push(filename);
      console.log(`  OK       ${filename}`);
      console.log(`           checksum: ${currentChecksum}`);
    } else {
      // Update the stored checksum
      await sql`
        UPDATE mnemosyne.schema_migrations
        SET checksum = ${currentChecksum}
        WHERE filename = ${filename}
      `;
      updated.push(filename);
      console.log(`  UPDATED  ${filename}`);
      console.log(`           old: ${storedChecksum}`);
      console.log(`           new: ${currentChecksum}`);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`  Updated:   ${updated.length}`);
  console.log(`  Unchanged: ${unchanged.length}`);
  console.log(`  New (skipped): ${newFiles.length}`);

  if (newFiles.length > 0) {
    console.log("\nNew files not yet in schema_migrations:");
    for (const f of newFiles) {
      console.log(`  - ${f}`);
    }
    console.log("Run without --update-checksums to insert sentinel rows for these files.");
  }

  await sql.end();
}

async function markSquashApplied() {
  // Safety check: verify the database is at the full 75-migration state
  // by confirming mnemo_sync_supersession table exists (created in migration 0073).
  const check = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'mnemosyne'
        AND table_name = 'mnemo_sync_supersession'
    ) AS ready
  `;
  if (!check[0].ready) {
    console.error("ERROR: Table mnemosyne.mnemo_sync_supersession does not exist.");
    console.error("This database does not appear to have all 75 v3 migrations applied.");
    console.error("Run the full migration first: pnpm --filter @mnemo-ai/adapter-postgres migrate");
    await sql.end();
    process.exit(1);
  }

  // Compute checksum of squash file
  const squashPath = join(__dirname, "../migrations/baseline/0001_v3_complete_baseline.sql");
  const content = readFileSync(squashPath, "utf-8");
  const checksum = createHash("sha256").update(content).digest("hex");
  const filename = "0001_v3_complete_baseline.sql";

  // Insert sentinel row (idempotent)
  const result = await sql`
    INSERT INTO mnemosyne.schema_migrations (filename, checksum)
    VALUES (${filename}, ${checksum})
    ON CONFLICT (filename) DO NOTHING
    RETURNING filename
  `;

  if (result.length > 0) {
    console.log(`Inserted sentinel row for ${filename}`);
    console.log(`  checksum: ${checksum}`);
  } else {
    console.log(`Sentinel row already exists for ${filename} — nothing to do`);
  }

  console.log("\nThe 75 original migration rows are preserved (runner ignores unknown filenames).");
  console.log("This database is now compatible with the squash baseline.");

  await sql.end();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--update-checksums")) {
    await updateChecksums();
  } else {
    await markSquashApplied();
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
