import { sql } from "drizzle-orm";
import type { DrizzleClient } from "./types.js";
import type { EmbeddableTable, HotTierSnapshotRow, TextProjection } from "@mnemo-ai/types";
import { PRIMITIVE_TEXT_PROJECTION } from "@mnemo-ai/types";

// ─── Embedding-model migration helpers ────────────────────────────────────────

// make-primitives-recallable (PR1, design.md D1): builds the same raw-SQL
// `COALESCE(field, '') || sep || COALESCE(field, '')` shape the hardcoded
// entries below spell out by hand, but driven by the shared registry so a
// recallable kind's textExpr can never drift from what's actually indexed
// on write (DecisionRepository.ts). Field names come only from the
// trusted, in-repo PRIMITIVE_TEXT_PROJECTION constant — never from request
// input — so raw interpolation into the SQL string here is safe.
function textExprFromProjection(projection: TextProjection): string {
  return (
    projection.fields
      // PRIMITIVE_TEXT_PROJECTION names TypeScript fields; these are SQL columns.
      // Every field used up to P65 happened to be identical in both
      // (`title`, `body`, `name`, `description`, `question`, `conclusion`,
      // `narrative`), so nothing forced the conversion — until `skill` projected
      // `promptTemplate`, whose column is `prompt_template`. Without this the
      // generated SQL references a column that does not exist and the re-embed
      // sweep fails for that table alone.
      .map((field) => `COALESCE(${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}, '')`)
      .join(` || '${projection.separator}' || `)
  );
}

// Bug fix: workspace_id is `text` on EVERY one of these 7 tables (verified against
// the live schema), not just mnemo_entity as the old comment claimed. The other 6
// were building `WHERE workspace_id = $1::uuid` against a text column, which
// Postgres rejects outright ("operator does not exist: text = uuid") — so
// listStaleEmbeddings/markEmbeddingsStale/updateEmbeddingVector threw for every
// table except entity, meaning the §36 daily embed-migration cron
// (mnemo.embed.migration) has never successfully migrated a single row.
const EMBED_TABLE_META: Record<EmbeddableTable, { tableName: string; textExpr: string }> = {
  // fact/decision derive from PRIMITIVE_TEXT_PROJECTION (make-primitives-recallable
  // PR1) — single source of truth shared with DecisionRepository's outbox payload.
  fact: {
    tableName: "mnemo_fact",
    textExpr: textExprFromProjection(PRIMITIVE_TEXT_PROJECTION.fact),
  },
  decision: {
    tableName: "mnemo_decision",
    textExpr: textExprFromProjection(PRIMITIVE_TEXT_PROJECTION.decision),
  },
  // P65: was `COALESCE(name, '')`, which already disagreed with what the
  // outbox producer embedded (`name + promptTemplate`). Same source of truth
  // now, so a re-embed cannot change a skill's vector into something the
  // lexical column does not match.
  skill: {
    tableName: "mnemo_skill",
    textExpr: textExprFromProjection(PRIMITIVE_TEXT_PROJECTION.skill),
  },
  workflow: {
    tableName: "mnemo_workflow",
    textExpr: textExprFromProjection(PRIMITIVE_TEXT_PROJECTION.workflow),
  },
  task: {
    tableName: "mnemo_task",
    textExpr: textExprFromProjection(PRIMITIVE_TEXT_PROJECTION.task),
  },
  event: {
    tableName: "mnemo_event",
    textExpr: textExprFromProjection(PRIMITIVE_TEXT_PROJECTION.event),
  },
  strategy: {
    tableName: "mnemo_strategy",
    textExpr: "COALESCE(trigger, '') || ' ' || COALESCE(action, '')",
  },
  reasoning: {
    tableName: "mnemo_reasoning",
    textExpr: "COALESCE(question, '') || ' ' || COALESCE(conclusion, '')",
  },
  // DELTAMEM §16 — matches the createEpisode producer's text-form payload
  // (`title + ' ' + narrative`) so re-embeds during §36 model migration stay consistent.
  episode: {
    tableName: "mnemo_episode",
    textExpr: "COALESCE(title, '') || ' ' || COALESCE(narrative, '')",
  },
  // P16 — entity embedding: name + description mirrors createEntity outbox text form.
  entity: {
    tableName: "mnemo_entity",
    textExpr: "COALESCE(name, '') || ' ' || COALESCE(description, '')",
  },
};

function embedTableMeta(table: EmbeddableTable): { tableName: string; textExpr: string } {
  return EMBED_TABLE_META[table];
}

export class EmbeddingRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  // ── §36 Embedding-model migration ──────────────────────────────────────────

  async listStaleEmbeddings(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string,
    limit: number,
    opts?: { plaintextOnly?: boolean }
  ): Promise<Array<{ id: string; text: string }>> {
    const { tableName, textExpr } = embedTableMeta(table);
    const tbl = sql.raw(tableName);
    const tExpr = sql.raw(textExpr);
    const wsFilter = sql`workspace_id = ${workspaceId}`;
    // PRIM-4 — an open fact with no vector at all. A restore used to leave
    // exactly that (forget's vector_delete cleared it; the model stamp stayed
    // current and `embedding_stale` false), so this repair job never matched it.
    //
    // Review round — for facts, liveness and the plaintext tiers bound the
    // WHOLE selection, not one branch of it: a stale or never-stamped
    // confidential row holds ciphertext, which must not be embedded, and a
    // closed row is never recalled, so re-embedding it is wasted work.
    const factOnly =
      table === "fact"
        ? sql`AND valid_to IS NULL AND status = 'active' AND sensitivity IN ('public', 'internal')`
        : sql``;
    const missingVector = table === "fact" ? sql`OR embedding IS NULL` : sql``;
    // MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=none: every table carries a tier, and a
    // confidential+ row's text must not reach an external embedder.
    const plaintextOnly = opts?.plaintextOnly
      ? sql`AND sensitivity IN ('public', 'internal')`
      : sql``;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute<{ id: string; text: string }>(sql`
        SELECT id::text AS id, (${tExpr}) AS text
        FROM mnemosyne.${tbl}
        WHERE ${wsFilter}
          AND (embedding_stale = true OR embedding_model IS NULL OR embedding_model != ${currentModel}
               ${missingVector})
          ${factOnly}
          ${plaintextOnly}
        ORDER BY id
        LIMIT ${limit}
      `);
      return Array.from(rows as unknown as Array<{ id: string; text: string }>);
    });
  }

  /** The tier of the row an embedding job would embed; null when unknown. */
  async getEmbeddingSourceSensitivity(
    table: EmbeddableTable,
    id: string,
    workspaceId: string
  ): Promise<string | null> {
    if (!Object.prototype.hasOwnProperty.call(EMBED_TABLE_META, table)) return null;
    const tbl = sql.raw(embedTableMeta(table).tableName);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = (await tx.execute<{ sensitivity: string }>(sql`
        SELECT sensitivity FROM mnemosyne.${tbl}
        WHERE workspace_id = ${workspaceId} AND id::text = ${id}
      `)) as unknown as Array<{ sensitivity: string }>;
      return rows[0]?.sensitivity ?? null;
    });
  }

  /**
   * P111 — implements the port method `recall-cold.ts` has always called and no
   * adapter ever provided.
   *
   * `recall-cold` guards the call with `ctx.storage.hasActiveEmbeddingMigration ? …
   * : false`, so an absent implementation did not throw — it silently took the
   * `false` branch on every recall, forever. The consequence is the wrong way
   * round: `hybridRecallWeights` shifts to {fts 0.7, vector 0.3} precisely
   * because a half-migrated corpus has embeddings from two different models that
   * are not comparable. Always answering "no migration" meant recall kept
   * weighting those inconsistent vectors at 0.6 during exactly the window they
   * are least trustworthy.
   *
   * A migration is active only when an existing vector is stale or belongs to
   * another model. Rows without vectors still need backfill, but cannot make
   * the vector scores incomparable. EXISTS with LIMIT 1 stops at the first hit.
   */
  async hasActiveEmbeddingMigration(workspaceId: string, currentModel: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // Keys of the local EMBED_TABLE_META rather than core's EMBEDDABLE_TABLES:
      // an adapter must not import @mnemo-ai/core (hexagonal purity), and this map
      // is already the adapter-side source of truth for which tables carry an
      // embedding column.
      for (const table of Object.keys(EMBED_TABLE_META) as EmbeddableTable[]) {
        const { tableName } = embedTableMeta(table);
        const tbl = sql.raw(tableName);
        const rows = await tx.execute<{ one: number }>(sql`
          SELECT 1 AS one
          FROM mnemosyne.${tbl}
          WHERE workspace_id = ${workspaceId}
            AND embedding IS NOT NULL
            AND (embedding_stale = true OR embedding_model IS DISTINCT FROM ${currentModel})
          LIMIT 1
        `);
        if (Array.from(rows as unknown as Array<{ one: number }>).length > 0) return true;
      }
      return false;
    });
  }

  async markEmbeddingsStale(
    table: EmbeddableTable,
    workspaceId: string,
    currentModel: string
  ): Promise<number> {
    const { tableName } = embedTableMeta(table);
    const tbl = sql.raw(tableName);
    const wsFilter = sql`workspace_id = ${workspaceId}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const result = await tx.execute(sql`
        UPDATE mnemosyne.${tbl}
        SET embedding_stale = true
        WHERE ${wsFilter}
          AND embedding_model IS DISTINCT FROM ${currentModel}
      `);
      return (result as unknown as { rowCount?: number }).rowCount ?? 0;
    });
  }

  async updateEmbeddingVector(
    table: EmbeddableTable,
    id: string,
    workspaceId: string,
    vector: number[],
    model: string
  ): Promise<void> {
    const { tableName } = embedTableMeta(table);
    const tbl = sql.raw(tableName);
    const vecLiteral = sql.raw(`'[${vector.join(",")}]'::public.halfvec`);
    const wsFilter = sql`workspace_id = ${workspaceId}`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        UPDATE mnemosyne.${tbl}
        SET embedding = ${vecLiteral},
            embedding_model = ${model},
            embedding_stale = false
        WHERE id = ${id} AND ${wsFilter}
      `);
    });
  }

  // ── §37 Hot-tier dump persistence ─────────────────────────────────────────

  async upsertHotTierSnapshot(rows: HotTierSnapshotRow[]): Promise<void> {
    if (rows.length === 0) return;
    // Chunked upsert — avoid statement too large for very big hot tiers.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values = chunk.map(
        (r) =>
          sql`(${r.workspaceId}::uuid, ${r.cacheKey}, ${r.score}, ${JSON.stringify(r.payload)}::jsonb, NOW())`
      );
      // Build VALUES list manually since drizzle doesn't support ON CONFLICT for raw inserts.
      await this.db.execute(sql`
        INSERT INTO mnemosyne.mnemo_hot_tier_snapshot (workspace_id, cache_key, score, payload, dumped_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (workspace_id, cache_key) DO UPDATE
          SET score = EXCLUDED.score,
              payload = EXCLUDED.payload,
              dumped_at = EXCLUDED.dumped_at
      `);
    }
  }

  async loadHotTierSnapshots(workspaceId?: string): Promise<HotTierSnapshotRow[]> {
    const rows = workspaceId
      ? await this.db.execute<{
          workspace_id: string;
          cache_key: string;
          score: number;
          payload: Record<string, unknown>;
        }>(sql`
          SELECT workspace_id::text AS workspace_id, cache_key, score::float8 AS score, payload
          FROM mnemosyne.mnemo_hot_tier_snapshot
          WHERE workspace_id = ${workspaceId}::uuid
          ORDER BY workspace_id, cache_key
        `)
      : await this.db.execute<{
          workspace_id: string;
          cache_key: string;
          score: number;
          payload: Record<string, unknown>;
        }>(sql`
          SELECT workspace_id::text AS workspace_id, cache_key, score::float8 AS score, payload
          FROM mnemosyne.mnemo_hot_tier_snapshot
          ORDER BY workspace_id, cache_key
        `);
    return Array.from(
      rows as unknown as Array<{
        workspace_id: string;
        cache_key: string;
        score: number;
        payload: Record<string, unknown>;
      }>
    ).map((r) => ({
      workspaceId: r.workspace_id,
      cacheKey: r.cache_key,
      score: r.score,
      payload: r.payload,
    }));
  }
}
