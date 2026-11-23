/**
 * §36 Embedding-model migration engine (MEMORY_IMPROVEMENT.md §36).
 *
 * Pure core module — no infrastructure imports. All DB operations go through
 * the StorageAdapter port; embedding through the EmbedAdapter port.
 *
 * Design:
 *  - detectStale: counts per-table stale rows for a workspace
 *  - migrateWorkspace: pages through stale rows in batches, re-embeds, writes back
 *  - Tables covered: fact, decision, skill, strategy, reasoning, episode
 *  - Idempotent: rows with the correct model are skipped
 *  - Errors: per-row errors are collected and returned; the run continues
 */

import type { EmbeddableTable } from "@mnemo-ai/types";

export interface EmbedMigrationStorage {
  listStaleEmbeddings(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string,
    limit: number,
    opts?: { plaintextOnly?: boolean }
  ): Promise<Array<{ id: string; text: string }>>;
  markEmbeddingsStale(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string
  ): Promise<number>;
  updateEmbeddingVector(
    table: EmbeddableTable,
    id: string,
    workspaceId: string,
    vector: number[],
    model: string
  ): Promise<void>;
  listWorkspaceIds(): Promise<string[]>;
}

export interface EmbedMigrationEmbed {
  model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface DetectStaleResult {
  workspaceId: string;
  counts: Record<EmbeddableTable, number>;
  total: number;
}

export interface MigrateWorkspaceResult {
  workspaceId: string;
  migrated: number;
  errors: Array<{ table: EmbeddableTable; id: string; error: string }>;
}

export interface MigrateWorkspaceOpts {
  storage: EmbedMigrationStorage;
  embed: EmbedMigrationEmbed;
  workspaceId: string;
  /** Batch size per table per run. Default 50. */
  batchSize?: number;
  /**
   * False when `embed` may not receive confidential+ text
   * (MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=none, external embedder, SECURITY.md §7):
   * such rows are never listed, so never re-embedded. Only `true` lists them:
   * unset fails closed.
   */
  sensitiveTextToEmbedder?: boolean;
}

export const EMBEDDABLE_TABLES: EmbeddableTable[] = [
  "fact",
  "decision",
  "skill",
  "strategy",
  "reasoning",
  "episode",
  "entity", // P16 — entity embedding
  // P65 — migration 0033. Every existing workflow row has embedding_stale=true
  // by column default, so the first sweep after deploy backfills the corpus:
  // that IS the P65 backfill, not a separate script.
  "workflow",
  "task",
  "event",
];

/**
 * Count stale embeddings per table for a workspace.
 * A row is stale when embedding_stale = true or embedding_model != currentModel.
 */
export async function detectStale(
  storage: EmbedMigrationStorage,
  workspaceId: string,
  currentModel: string,
  opts: { sensitiveTextToEmbedder?: boolean } = {}
): Promise<DetectStaleResult> {
  const listOpts = opts.sensitiveTextToEmbedder === true ? undefined : { plaintextOnly: true };
  const counts: Record<EmbeddableTable, number> = {
    fact: 0,
    decision: 0,
    skill: 0,
    strategy: 0,
    reasoning: 0,
    episode: 0,
    entity: 0, // P16
    workflow: 0, // P65 — migration 0033
    task: 0, // P65 — migration 0034
    event: 0, // P65 — migration 0034
  };

  for (const table of EMBEDDABLE_TABLES) {
    const rows = await storage.listStaleEmbeddings(
      table,
      workspaceId,
      currentModel,
      10_000,
      ...(listOpts ? [listOpts] : [])
    );
    counts[table] = rows.length;
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return { workspaceId, counts, total };
}

/**
 * Migrate stale embeddings for one workspace.
 * Pages through each table in batches — re-embeds texts, writes vectors back.
 * Errors per-row are collected (not thrown) so a bad row doesn't abort the run.
 */
export async function migrateWorkspace(
  opts: MigrateWorkspaceOpts
): Promise<MigrateWorkspaceResult> {
  const { storage, embed, workspaceId, batchSize = 50 } = opts;
  const listOpts = opts.sensitiveTextToEmbedder === true ? undefined : { plaintextOnly: true };
  const model = embed.model;
  let migrated = 0;
  const errors: MigrateWorkspaceResult["errors"] = [];

  for (const table of EMBEDDABLE_TABLES) {
    let hasMore = true;
    while (hasMore) {
      const rows = await storage.listStaleEmbeddings(
        table,
        workspaceId,
        model,
        batchSize,
        ...(listOpts ? [listOpts] : [])
      );
      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      // Batch embed all texts at once.
      const texts = rows.map((r) => r.text);
      let vectors: Float32Array[];
      try {
        vectors = await embed.embed(texts);
      } catch (embedErr) {
        // If the batch embed fails, record error for each row and stop this table.
        for (const row of rows) {
          errors.push({ table, id: row.id, error: String(embedErr) });
        }
        hasMore = false;
        break;
      }

      // Write each vector back individually — per-row isolation.
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const vector = vectors[i];
        if (!vector) continue;
        try {
          await storage.updateEmbeddingVector(
            table,
            row.id,
            workspaceId,
            Array.from(vector),
            model
          );
          migrated++;
        } catch (writeErr) {
          errors.push({ table, id: row.id, error: String(writeErr) });
        }
      }

      // If we got a full batch, there may be more. Otherwise we're done for this table.
      hasMore = rows.length === batchSize;
    }
  }

  return { workspaceId, migrated, errors };
}

// ─── §36 Hybrid recall reweight during an active embedding migration ───────────

export interface HybridRecallWeights {
  /** Weight on the lexical (FTS / text_lemmatized) signal. */
  fts: number;
  /** Weight on the vector (cosine / HNSW) signal. */
  vector: number;
}

/**
 * §36 (spec lines 4637-4644): while a workspace's embeddings are being migrated to
 * a new model, vector search is only valid for the subset of facts already
 * re-embedded (embedding_stale = false). FTS (text_lemmatized) is model-agnostic
 * and always valid, so recall leans on FTS until the backfill completes.
 *
 *   migrationActive = true  → fts 0.7 / vector 0.3 (spec ftsWeightDuringMigration)
 *   migrationActive = false → fts 0.4 / vector 0.6 (spec "normal" weights)
 *
 * Pure — no I/O. The caller derives `migrationActive` from detectStale(...).total
 * > 0 for the workspace (set on RecallQuery.embeddingMigrationActive at the
 * transport/orchestrator layer).
 */
export function hybridRecallWeights(migrationActive: boolean): HybridRecallWeights {
  return migrationActive ? { fts: 0.7, vector: 0.3 } : { fts: 0.4, vector: 0.6 };
}
