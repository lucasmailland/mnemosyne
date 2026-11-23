#!/usr/bin/env node
// packages/cup/src/migrate.ts
//
// CLI migration runner: v2 memories → v3 cognitive primitives.
//
// Usage:
//   mnemo-migrate --workspace <uuid> [--batch-size N] [--dry-run]
//
// Required env:
//   DATABASE_URL      — source v2 PostgreSQL connection string
//   DATABASE_URL_V3   — target v3 PostgreSQL connection string
//
// The script reads memories from the v2 `public.memories` table, maps them
// via mapV2MemoryBatch(), and inserts into the v3 `mnemosyne.mnemo_fact`,
// `mnemosyne.mnemo_episode`, and `mnemosyne.mnemo_skill` tables using raw
// SQL (no ORM dependency — cup intentionally has @mnemo-ai/core as a peer
// only, not a hard dep, so we keep this script self-contained).

import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mapV2MemoryBatch } from "./TypeMapper.js";
import type { V2Memory, MappedFact, MappedEpisode, MappedSkill, MappedItem } from "./TypeMapper.js";

// ─── LLM helpers ─────────────────────────────────────────────────────────────

/**
 * Build an embedder function that calls the configured LLM provider.
 * Returns null when no embed provider env vars are set (embedding is optional).
 *
 * Provider resolution order:
 *   MNEMO_EMBED_PROVIDER (dedicated embed provider)
 *   → MNEMO_LLM_PROVIDER (fallback: use the LLM provider for embeddings)
 * API key:
 *   MNEMO_EMBED_API_KEY → MNEMO_LLM_API_KEY
 */
export async function createEmbedder(): Promise<((text: string) => Promise<number[] | null>) | null> {
  const providerName =
    process.env["MNEMO_EMBED_PROVIDER"] ?? process.env["MNEMO_LLM_PROVIDER"];
  const apiKey =
    process.env["MNEMO_EMBED_API_KEY"] ?? process.env["MNEMO_LLM_API_KEY"];

  if (!providerName || !apiKey) return null;

  try {
    const { createProvider } = await import("@mnemo-ai/llm-providers");
    const provider = createProvider({ provider: providerName, apiKey });
    if (!provider.capabilities.embed) {
      console.warn(
        `  [embed] Provider "${providerName}" does not support embeddings — skipping.`,
      );
      return null;
    }
    return async (text: string): Promise<number[] | null> => {
      try {
        return await provider.embed(text, "");
      } catch (err) {
        console.warn(`  [embed] Failed to embed text: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };
  } catch (err) {
    console.warn(
      `  [embed] Provider init failed: ${err instanceof Error ? err.message : String(err)} — embeddings will be skipped.`,
    );
    return null;
  }
}

/**
 * Build a simple semaphore for capping concurrent LLM calls.
 */
function createSemaphore(maxConcurrent: number): { acquire: () => Promise<() => void> } {
  let running = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<() => void> {
      return new Promise<() => void>((resolve) => {
        const tryRun = () => {
          if (running < maxConcurrent) {
            running++;
            resolve(() => {
              running--;
              const next = queue.shift();
              if (next) next();
            });
          } else {
            queue.push(tryRun);
          }
        };
        tryRun();
      });
    },
  };
}

/** Valid v3 types the LLM may return. */
const VALID_LLM_TYPES = new Set(["fact", "episode", "skill"]);

/**
 * Re-classify a batch of mapped items using the LLM, capped at `maxConcurrent`
 * parallel calls. Returns the number of reclassifications that happened.
 */
export async function reclassifyBatch(
  items: MappedItem[],
  completeProvider: {
    complete?: (req: { prompt: string; maxTokens?: number; temperature?: number }) => Promise<{ text: string }>;
  },
  maxConcurrent = 5,
): Promise<{ reclassified: number }> {
  let reclassified = 0;
  const sem = createSemaphore(maxConcurrent);

  await Promise.allSettled(
    items.map(async (item) => {
      const text =
        item.type === "fact"
          ? item.input.statement
          : item.type === "episode"
            ? `${item.input.title} ${item.input.narrative}`
            : item.input.name;

      const prompt =
        `Classify this memory into one of: fact, episode, skill. ` +
        `Memory: ${text}. ` +
        `Current classification: ${item.type}. ` +
        `Respond with just the type word.`;

      const release = await sem.acquire();
      try {
        if (!completeProvider.complete) return;
        const response = await completeProvider.complete({
          prompt,
          maxTokens: 10,
          temperature: 0,
        });
        const rawType = response.text.trim().toLowerCase();
        if (VALID_LLM_TYPES.has(rawType) && rawType !== item.type) {
          console.log(`  [LLM] reclassified: ${item.type} → ${rawType}`);
          // Mutate the item.type in place — the caller uses the same reference.
          // TypeScript doesn't allow assigning to a discriminant directly, so we
          // use Object.assign to update it without losing other properties.
          (item as { type: string }).type = rawType;
          reclassified++;
        }
      } catch (err) {
        console.warn(
          `  [LLM] reclassification failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        release();
      }
    }),
  );

  return { reclassified };
}

// ─── CLI args ────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): {
  workspace: string;
  batchSize: number;
  dryRun: boolean;
  llm: boolean;
  runId: string;
} {
  const args = argv.slice(2);
  let workspace: string | undefined;
  let batchSize = 100;
  let dryRun = false;
  let llm = false;
  let runId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace" && args[i + 1]) {
      workspace = args[++i];
    } else if (arg === "--batch-size" && args[i + 1]) {
      const rawVal = args[++i] ?? "";
      const n = parseInt(rawVal, 10);
      if (isNaN(n) || n < 1) {
        console.error(`--batch-size must be a positive integer, got: ${rawVal}`);
        process.exit(1);
      }
      batchSize = n;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--llm") {
      // Wave V §27: re-classify migrated records using the LLM adapter.
      // Requires MNEMO_LLM_API_KEY to be set.
      llm = true;
    } else if (arg === "--run-id" && args[i + 1]) {
      runId = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  if (!workspace) {
    console.error("Error: --workspace <uuid> is required.");
    printHelp();
    process.exit(1);
  }

  return {
    workspace: workspace as string,
    batchSize,
    dryRun,
    llm,
    runId: runId ?? randomUUID(),
  };
}

function printHelp(): void {
  console.log(`
mnemo-migrate — v2 → v3 Mnemosyne migration runner

Usage:
  mnemo-migrate --workspace <uuid> [--batch-size N] [--dry-run] [--llm] [--run-id <id>]

Required environment variables:
  DATABASE_URL      Source v2 PostgreSQL connection string
  DATABASE_URL_V3   Target v3 PostgreSQL connection string

Options:
  --workspace <uuid>   (Required) Workspace ID to migrate
  --batch-size N       Records per batch (default: 100)
  --dry-run            Print what would be migrated, no writes
  --llm                Re-classify migrated records using LLM (requires MNEMO_LLM_API_KEY)
  --run-id <id>        Resume a previous run by its ID (keyset cursor persisted in v3 DB)
  --help, -h           Show this help
  `.trim());
}

// ─── Summary counters ─────────────────────────────────────────────────────────

export interface MigrationSummary {
  total: number;
  migrated: number;
  errors: number;
  facts: number;
  episodes: number;
  skills: number;
  relations: number;
  /** Number of items whose type was changed by LLM re-classification. */
  reclassified: number;
  dryRun: boolean;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

/**
 * RLS-safe transaction wrapper for the migration tool.
 *
 * Equivalent to `withMnemoTx` from @mnemo-ai/core but operates on a raw
 * postgres.js Sql connection. Cup intentionally avoids a hard dep on core
 * (which brings in Drizzle) so we replicate the two-statement activation
 * pattern here in one place.
 *
 * Every mnemo_* write inside `fn` runs as `app_user` with the workspace GUC
 * set, activating FORCE RLS on all mnemosyne-schema tables.
 */
async function withRlsTx<T>(
  dst: ReturnType<typeof postgres>,
  workspaceId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return dst.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

// ─── Keyset cursor ────────────────────────────────────────────────────────────
// Wave V §27: replace OFFSET pagination with (created_at, id) keyset cursor.
// This avoids the O(n) re-scan cost that makes large workspace migrations slow.
// A cursor row (workspaceId, runId) is maintained in mnemo_migration_cursor
// so interrupted runs can resume without re-scanning from position 0.

interface KeysetCursor {
  lastCreatedAt: Date;
  lastId: string;
}

/**
 * Fetch the next batch after the given keyset cursor.
 * First batch: pass cursor = null.
 * Each subsequent batch: pass the (created_at, id) of the LAST row in the
 * previous batch.
 */
async function fetchBatch(
  sql: Sql,
  workspaceId: string,
  cursor: KeysetCursor | null,
  limit: number,
): Promise<V2Memory[]> {
  if (cursor === null) {
    // First page — no lower bound
    const rows = await sql<V2Memory[]>`
      SELECT
        id,
        workspace_id,
        agent_id,
        actor_id,
        session_id,
        memory_type,
        content,
        subject,
        confidence,
        entity_id,
        created_at,
        updated_at,
        metadata
      FROM memories
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `;
    return rows;
  }

  // Subsequent pages — keyset WHERE clause
  const rows = await sql<V2Memory[]>`
    SELECT
      id,
      workspace_id,
      agent_id,
      actor_id,
      session_id,
      memory_type,
      content,
      subject,
      confidence,
      entity_id,
      created_at,
      updated_at,
      metadata
    FROM memories
    WHERE workspace_id = ${workspaceId}
      AND (created_at > ${cursor.lastCreatedAt}
           OR (created_at = ${cursor.lastCreatedAt} AND id > ${cursor.lastId}))
    ORDER BY created_at ASC, id ASC
    LIMIT ${limit}
  `;
  return rows;
}

async function countTotal(sql: Sql, workspaceId: string): Promise<number> {
  const [row] = await sql<[{ count: string }]>`
    SELECT COUNT(*)::text AS count
    FROM memories
    WHERE workspace_id = ${workspaceId}
  `;
  return parseInt(row.count, 10);
}

async function insertFact(
  sql: Sql,
  item: MappedFact,
  embedding?: number[] | null,
): Promise<void> {
  const inp = item.input;
  const id = randomUUID();
  const now = new Date();

  // B6.35: defensively strip the reserved pending-consolidation marker once,
  // then serialize the SAME sanitized object in both SQL branches. The TypeMapper
  // already strips it, but this insert is the last line of defence for any future
  // direct caller — never serialize raw `inp.metadata` here.
  const { __mnemoConsolidationPending: _pending, ...rest } =
    (inp.metadata ?? {}) as Record<string, unknown>;
  const safeFactMetadata = rest;

  if (embedding && embedding.length > 0) {
    const vecLiteral = `[${embedding.join(",")}]`;
    await sql`
      INSERT INTO mnemosyne.mnemo_fact (
        id, workspace_id, agent_id, actor_id, scope, scope_ref,
        statement, subject, kind, confidence,
        session_id, extraction_source, entity_id,
        valid_from, valid_to,
        embedding,
        metadata,
        created_at, updated_at
      ) VALUES (
        ${id},
        ${inp.workspaceId},
        ${inp.agentId ?? null},
        ${inp.actorId ?? null},
        ${"global"},
        ${inp.scopeRef ?? null},
        ${inp.statement},
        ${inp.subject},
        ${inp.kind},
        ${inp.confidence ?? 1 / 3},
        ${inp.sessionId ?? null},
        ${inp.extractionSource ?? null},
        ${inp.entityId ?? null},
        ${inp.validFrom ?? now},
        ${inp.validTo ?? null},
        ${vecLiteral}::halfvec,
        ${sql.json(safeFactMetadata as unknown as Parameters<typeof sql.json>[0])},
        ${now},
        ${now}
      )
      ON CONFLICT DO NOTHING
    `;
  } else {
    await sql`
      INSERT INTO mnemosyne.mnemo_fact (
        id, workspace_id, agent_id, actor_id, scope, scope_ref,
        statement, subject, kind, confidence,
        session_id, extraction_source, entity_id,
        valid_from, valid_to,
        metadata,
        created_at, updated_at
      ) VALUES (
        ${id},
        ${inp.workspaceId},
        ${inp.agentId ?? null},
        ${inp.actorId ?? null},
        ${"global"},
        ${inp.scopeRef ?? null},
        ${inp.statement},
        ${inp.subject},
        ${inp.kind},
        ${inp.confidence ?? 1 / 3},
        ${inp.sessionId ?? null},
        ${inp.extractionSource ?? null},
        ${inp.entityId ?? null},
        ${inp.validFrom ?? now},
        ${inp.validTo ?? null},
        ${sql.json(safeFactMetadata as unknown as Parameters<typeof sql.json>[0])},
        ${now},
        ${now}
      )
      ON CONFLICT DO NOTHING
    `;
  }
}

async function insertEpisode(
  sql: Sql,
  item: MappedEpisode,
  embedding?: number[] | null,
): Promise<void> {
  const inp = item.input;
  const id = randomUUID();
  const now = new Date();

  if (embedding && embedding.length > 0) {
    const vecLiteral = `[${embedding.join(",")}]`;
    await sql`
      INSERT INTO mnemosyne.mnemo_episode (
        id, workspace_id, agent_id, title, narrative, occurred_at,
        is_synthetic, source_conversation_id,
        embedding,
        metadata, created_at, updated_at
      ) VALUES (
        ${id},
        ${inp.workspaceId},
        ${inp.agentId ?? null},
        ${inp.title},
        ${inp.narrative},
        ${inp.occurredAt},
        ${inp.isSynthetic ?? false},
        ${inp.sourceConversationId ?? null},
        ${vecLiteral}::halfvec,
        ${sql.json((inp.metadata ?? {}) as unknown as Parameters<typeof sql.json>[0])},
        ${now},
        ${now}
      )
      ON CONFLICT DO NOTHING
    `;
  } else {
    await sql`
      INSERT INTO mnemosyne.mnemo_episode (
        id, workspace_id, agent_id, title, narrative, occurred_at,
        is_synthetic, source_conversation_id,
        metadata, created_at, updated_at
      ) VALUES (
        ${id},
        ${inp.workspaceId},
        ${inp.agentId ?? null},
        ${inp.title},
        ${inp.narrative},
        ${inp.occurredAt},
        ${inp.isSynthetic ?? false},
        ${inp.sourceConversationId ?? null},
        ${sql.json((inp.metadata ?? {}) as unknown as Parameters<typeof sql.json>[0])},
        ${now},
        ${now}
      )
      ON CONFLICT DO NOTHING
    `;
  }
}

async function insertSkill(
  sql: Sql,
  item: MappedSkill,
  embedding?: number[] | null,
): Promise<void> {
  const inp = item.input;
  const id = randomUUID();
  const now = new Date();

  if (embedding && embedding.length > 0) {
    const vecLiteral = `[${embedding.join(",")}]`;
    await sql`
      INSERT INTO mnemosyne.mnemo_skill (
        id, workspace_id, name, prompt_template,
        embedding,
        metadata, created_at, updated_at
      ) VALUES (
        ${id},
        ${inp.workspaceId},
        ${inp.name},
        ${inp.promptTemplate},
        ${vecLiteral}::halfvec,
        ${sql.json((inp.metadata ?? {}) as unknown as Parameters<typeof sql.json>[0])},
        ${now},
        ${now}
      )
      ON CONFLICT DO NOTHING
    `;
  } else {
    await sql`
      INSERT INTO mnemosyne.mnemo_skill (
        id, workspace_id, name, prompt_template,
        metadata, created_at, updated_at
      ) VALUES (
        ${id},
        ${inp.workspaceId},
        ${inp.name},
        ${inp.promptTemplate},
        ${sql.json((inp.metadata ?? {}) as unknown as Parameters<typeof sql.json>[0])},
        ${now},
        ${now}
      )
      ON CONFLICT DO NOTHING
    `;
  }
}

// ─── Relation insertion ───────────────────────────────────────────────────────

/**
 * Insert a pending_relation into mnemo_relation.
 * Wave V §27: when a v2 memory_type maps to a "pendingRelation" (e.g.
 * "link" records), we convert them to mnemo_relation rows so the graph
 * is preserved in v3.
 */
async function insertRelation(sql: Sql, opts: {
  workspaceId: string;
  sourceId: string;
  sourceType: string;
  targetId: string;
  targetType: string;
  verb: string;
  weight: number;
}): Promise<void> {
  const id = randomUUID();
  const now = new Date();
  await sql`
    INSERT INTO mnemosyne.mnemo_relation (
      id, workspace_id, source_id, source_type, target_id, target_type,
      verb, weight, metadata, created_at, updated_at
    ) VALUES (
      ${id},
      ${opts.workspaceId},
      ${opts.sourceId},
      ${opts.sourceType},
      ${opts.targetId},
      ${opts.targetType},
      ${opts.verb},
      ${opts.weight},
      ${"{}"}::jsonb,
      ${now},
      ${now}
    )
    ON CONFLICT DO NOTHING
  `;
}

// ─── Core migration logic ─────────────────────────────────────────────────────

export async function runMigration(opts: {
  srcUrl: string;
  dstUrl: string;
  workspaceId: string;
  batchSize: number;
  dryRun: boolean;
  /** Wave V §27: use LLM to re-classify migrated records. */
  llm?: boolean;
  /** Wave V §27: run ID for keyset cursor persistence / resumption. */
  runId?: string;
}): Promise<MigrationSummary> {
  const { srcUrl, dstUrl, workspaceId, batchSize, dryRun, llm = false, runId } = opts;

  const src = postgres(srcUrl, { max: 3 }); // SRC intentionally targets public schema (v2 source)
  const dst = dryRun ? null : postgres(dstUrl, { max: 5, connection: { search_path: 'mnemosyne,public' } });

  const summary: MigrationSummary = {
    total: 0,
    migrated: 0,
    errors: 0,
    facts: 0,
    episodes: 0,
    skills: 0,
    relations: 0,
    reclassified: 0,
    dryRun,
  };

  // ── Embedder setup (always-on when env vars are set) ────────────────────────
  const embedder = await createEmbedder();
  if (embedder) {
    const embedProvider =
      process.env["MNEMO_EMBED_PROVIDER"] ?? process.env["MNEMO_LLM_PROVIDER"] ?? "unknown";
    console.log(`  [embed] Embedding enabled via provider "${embedProvider}".`);
  }

  // ── LLM provider for re-classification (only when --llm is set) ─────────────
  let llmProvider: {
    complete?: (req: { prompt: string; maxTokens?: number; temperature?: number }) => Promise<{ text: string }>;
  } | null = null;

  if (llm) {
    console.log("  [LLM mode] Re-classification via LLM enabled. Requires MNEMO_LLM_API_KEY.");
    const llmApiKey = process.env["MNEMO_LLM_API_KEY"];
    const llmProviderName = process.env["MNEMO_LLM_PROVIDER"];
    if (!llmApiKey || !llmProviderName) {
      console.warn("  [LLM] MNEMO_LLM_API_KEY or MNEMO_LLM_PROVIDER not set — LLM re-classification will be skipped.");
    } else {
      try {
        const { createProvider } = await import("@mnemo-ai/llm-providers");
        const created = createProvider({ provider: llmProviderName, apiKey: llmApiKey });
        if (created.capabilities.complete) {
          llmProvider = created;
          console.log(`  [LLM] Re-classification provider "${llmProviderName}" ready.`);
        } else {
          console.warn(`  [LLM] Provider "${llmProviderName}" does not support completions — re-classification skipped.`);
        }
      } catch (err) {
        console.warn(`  [LLM] Provider init failed: ${err instanceof Error ? err.message : String(err)} — re-classification skipped.`);
      }
    }
  }

  if (runId) {
    console.log(`  [Run ID] ${runId}`);
  }

  // ── Keyset cursor — restore from DB if resuming a run ───────────────────
  let cursor: KeysetCursor | null = null;
  if (runId && dst !== null && !dryRun) {
    try {
      const cursorRows = await withRlsTx(dst, workspaceId, (tx) =>
        tx<Array<{ last_created_at: Date; last_id: string; total_migrated: number }>>`
          SELECT last_created_at, last_id, total_migrated
          FROM mnemosyne.mnemo_migration_cursor
          WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        `,
      ) as Array<{ last_created_at: Date; last_id: string; total_migrated: number }> | undefined;
      const cursorRow = cursorRows?.[0];
      if (cursorRow) {
        cursor = { lastCreatedAt: cursorRow.last_created_at, lastId: cursorRow.last_id };
        summary.migrated = cursorRow.total_migrated;
        console.log(
          `  Resuming run ${runId} from cursor (created_at=${cursor.lastCreatedAt.toISOString()}, id=${cursor.lastId})`,
        );
      }
    } catch {
      // Table may not exist in older deployments — fall through to fresh start
    }
  }

  try {
    summary.total = await countTotal(src, workspaceId);
    console.log(
      `Starting ${dryRun ? "[DRY RUN] " : ""}migration of workspace ${workspaceId}` +
      ` — ${summary.total} records, batch size ${batchSize}` +
      (cursor ? " (resuming)" : ""),
    );

    if (summary.total === 0) {
      console.log("No records found. Nothing to migrate.");
      return summary;
    }

    // ── Main keyset loop ─────────────────────────────────────────────────────
    while (true) {
      const rows = await fetchBatch(src, workspaceId, cursor, batchSize);
      if (rows.length === 0) break;

      const { mapped, failed } = mapV2MemoryBatch(rows);

      // Count failures
      summary.errors += failed.length;
      for (const f of failed) {
        console.warn(`  [ERROR] id=${f.v2.id} type=${f.v2.memory_type}: ${f.error}`);
      }

      // LLM re-classification (when --llm flag and provider is ready)
      if (llmProvider && mapped.length > 0) {
        const { reclassified } = await reclassifyBatch(mapped, llmProvider);
        summary.reclassified += reclassified;
      }

      if (!dryRun && dst !== null) {
        for (const item of mapped) {
          try {
            // Compute embedding for this item's text content
            let embedding: number[] | null = null;
            if (embedder) {
              const text =
                item.type === "fact"
                  ? item.input.statement
                  : item.type === "episode"
                    ? `${item.input.title} ${item.input.narrative}`
                    : item.input.name;
              embedding = await embedder(text);
            }

            // Each insert activates FORCE RLS via withRlsTx — same two-statement
            // pattern as withMnemoTx in @mnemo-ai/core. We are writing user data,
            // not performing a sweep, so admin bypass is not appropriate.
            await withRlsTx(dst, workspaceId, async (tx) => {
              if (item.type === "fact") {
                await insertFact(tx, item, embedding);
                summary.facts++;
                // Wave V §27: pendingRelation — "relational" v2 type also inserts a relation
                if (item.pendingRelation) {
                  const factId = (item.input.metadata as Record<string, unknown>)?.["v2Id"] as string ?? "";
                  const entityId = item.pendingRelation.entityId;
                  await insertRelation(tx, {
                    workspaceId,
                    sourceId: factId,
                    sourceType: "fact",
                    targetId: entityId,
                    targetType: "entity",
                    verb: "related",
                    weight: 1,
                  });
                  summary.relations++;
                }
              } else if (item.type === "episode") {
                await insertEpisode(tx, item, embedding);
                summary.episodes++;
              } else if (item.type === "skill") {
                await insertSkill(tx, item, embedding);
                summary.skills++;
              }
            });
            summary.migrated++;
          } catch (err) {
            summary.errors++;
            const v2Id = (item.input.metadata as Record<string, unknown> | undefined)?.["v2Id"] ?? "?";
            console.warn(
              `  [ERROR] insert ${item.type} (v2Id=${v2Id}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Persist keyset cursor after each successful batch
        const lastRow = rows[rows.length - 1];
        if (lastRow && runId) {
          const newCursor: KeysetCursor = {
            lastCreatedAt: new Date(lastRow.created_at),
            lastId: lastRow.id,
          };
          try {
            await withRlsTx(dst, workspaceId, (tx) => tx`
              INSERT INTO mnemosyne.mnemo_migration_cursor
                (workspace_id, run_id, last_created_at, last_id, total_migrated, status)
              VALUES
                (${workspaceId}, ${runId}, ${newCursor.lastCreatedAt}, ${newCursor.lastId}, ${summary.migrated}, 'running')
              ON CONFLICT (workspace_id, run_id) DO UPDATE
                SET last_created_at = EXCLUDED.last_created_at,
                    last_id = EXCLUDED.last_id,
                    total_migrated = EXCLUDED.total_migrated,
                    updated_at = NOW()
            `);
          } catch {
            // Cursor table may not exist — non-fatal
          }
          cursor = newCursor;
        }
      } else {
        // Dry run: just tally
        for (const item of mapped) {
          if (item.type === "fact") {
            summary.facts++;
            // Also tally pending relations
            if (item.pendingRelation) summary.relations++;
          } else if (item.type === "episode") {
            summary.episodes++;
          } else if (item.type === "skill") {
            summary.skills++;
          }
          summary.migrated++;
        }
        // Print preview for dry run
        for (const item of mapped.slice(0, 3)) {
          const v2Id =
            (item.input.metadata as Record<string, unknown> | undefined)?.["v2Id"] ?? "?";
          console.log(`  [DRY RUN] would insert ${item.type} (v2Id=${v2Id})`);
        }
        if (mapped.length > 3) {
          console.log(`  [DRY RUN] ... and ${mapped.length - 3} more in this batch`);
        }

        // Advance keyset cursor for dry run progress tracking
        const lastRow = rows[rows.length - 1];
        if (lastRow) {
          cursor = { lastCreatedAt: new Date(lastRow.created_at), lastId: lastRow.id };
        }
      }

      console.log(
        `  Migrated ${summary.migrated} records` +
        ` (${summary.errors} errors)`,
      );
    }

    // Mark run as completed
    if (runId && dst !== null && !dryRun) {
      try {
        await withRlsTx(dst, workspaceId, (tx) => tx`
          UPDATE mnemosyne.mnemo_migration_cursor
          SET status = 'completed', updated_at = NOW()
          WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        `);
      } catch { /* non-fatal */ }
    }
  } finally {
    await src.end();
    if (dst) await dst.end();
  }

  return summary;
}

// ─── Summary printer ──────────────────────────────────────────────────────────

function printSummary(summary: MigrationSummary): void {
  const mode = summary.dryRun ? "[DRY RUN] " : "";
  console.log("\n" + "─".repeat(60));
  console.log(`${mode}Migration complete`);
  console.log(`  Total records scanned : ${summary.total}`);
  console.log(`  Successfully migrated : ${summary.migrated}`);
  console.log(`  Errors                : ${summary.errors}`);
  console.log(`  ├─ facts              : ${summary.facts}`);
  console.log(`  ├─ episodes           : ${summary.episodes}`);
  console.log(`  ├─ skills             : ${summary.skills}`);
  console.log(`  ├─ relations          : ${summary.relations}`);
  console.log(`  └─ reclassified (LLM) : ${summary.reclassified}`);
  console.log("─".repeat(60));
  if (summary.dryRun) {
    console.log("No data was written (--dry-run mode).");
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { workspace, batchSize, dryRun, llm, runId } = parseArgs(process.argv);

  const srcUrl = process.env["DATABASE_URL"];
  const dstUrl = process.env["DATABASE_URL_V3"];

  if (!srcUrl) {
    console.error("Error: DATABASE_URL environment variable is required (source v2 DB).");
    process.exit(1);
  }
  if (!dstUrl && !dryRun) {
    console.error("Error: DATABASE_URL_V3 environment variable is required (target v3 DB).");
    process.exit(1);
  }

  try {
    const summary = await runMigration({
      srcUrl,
      dstUrl: dstUrl ?? "",
      workspaceId: workspace,
      batchSize,
      dryRun,
      llm,
      runId,
    });
    printSummary(summary);
    process.exit(summary.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error("Migration failed:", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

import { realpathSync } from "node:fs";

function isCupMigrateMain(): boolean {
  if (process.argv[1] === undefined) return false;
  const currentFilePath = fileURLToPath(import.meta.url);
  try {
    const realArgv = realpathSync(process.argv[1]);
    const realCurrent = realpathSync(currentFilePath);
    return realArgv === realCurrent;
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isCupMigrateMain()) {
  main();
}
