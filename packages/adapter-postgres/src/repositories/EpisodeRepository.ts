import { dbNow } from "./_clock.js";
import { eq, and, gte, lte, or, gt, isNull, sql, count } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import * as schema from "../schema/index.js";
import { projectPrimitiveText } from "@mnemo-ai/types";
import { sameWidthAsQuery } from "./_embedding-width.js";
import { mapRowToEpisode } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import { applyDelta } from "@mnemo-ai/types";
import type {
  MnemoEpisode,
  CreateEpisodeInput,
  UpdateEpisodeInput,
  EpisodeFilter,
  PaginatedResult,
  SimilarEpisode,
  RememberKind,
} from "@mnemo-ai/types";

export class EpisodeRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async createEpisode(input: CreateEpisodeInput): Promise<MnemoEpisode> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      // B4.1 discovery, fixed this session: this used to be a plain
      // crypto.randomUUID(), but GET /episodes/:id's own param schema
      // (EPISODE_ID_PATTERN) only ever accepted the mepi_-prefixed shape
      // that the extraction pipeline's own createEpisode() already produces
      // (packages/core/src/episode/store.ts) — a plain-UUID episode created
      // here could never be fetched back by id. Matching that established
      // convention, not inventing a new one.
      const id = `mepi_${createId()}`;
      const isRoot = !input.parentEpisodeId;

      // Compute real depth from parent (grandchild = 2, not 1). Spec §16.
      let depth = 0;
      if (input.parentEpisodeId) {
        const parentRows = await tx
          .select({ depth: schema.episodeTable.depth })
          .from(schema.episodeTable)
          .where(
            and(
              eq(schema.episodeTable.id, input.parentEpisodeId),
              eq(schema.episodeTable.workspaceId, input.workspaceId)
            )
          )
          .limit(1);
        if (!parentRows[0]) {
          throw new Error(
            `Parent episode ${input.parentEpisodeId} not found in workspace ${input.workspaceId}`
          );
        }
        depth = parentRows[0].depth + 1;
      }

      const rows = await tx
        .insert(schema.episodeTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          // actorId was previously never propagated here despite
          // CreateEpisodeInput declaring it — pre-existing gap, fixed
          // alongside adding userId/actorType.
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          title: input.title,
          narrative: input.narrative,
          occurredAt: input.occurredAt,
          durationMinutes: input.durationMinutes,
          participants: input.participants ?? [],
          topics: input.topics ?? [],
          linkedFactIds: input.linkedFactIds ?? [],
          parentEpisodeId: input.parentEpisodeId,
          deltaContent: input.deltaContent,
          isRoot,
          depth,
          isSynthetic: input.isSynthetic ?? false,
          sourceConversationId: input.sourceConversationId,
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id,
          kind: "episode",
          text: projectPrimitiveText("episode", {
            title: input.title,
            narrative: input.narrative,
          }),
        },
      });

      return mapRowToEpisode(rows[0]!);
    });
  }

  async getEpisode(id: string, workspaceId: string): Promise<MnemoEpisode | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.episodeTable)
        .where(
          and(eq(schema.episodeTable.id, id), eq(schema.episodeTable.workspaceId, workspaceId))
        )
        .limit(1);
      return rows[0] ? mapRowToEpisode(rows[0]) : null;
    });
  }

  async reconstructEpisode(id: string, workspaceId: string): Promise<MnemoEpisode> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      // Walk leaf→root collecting the chain, with a cycle guard.
      const chain: Array<schema.SelectEpisode> = [];
      let cursor: string | null = id;
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        const rows = await tx
          .select()
          .from(schema.episodeTable)
          .where(
            and(
              eq(schema.episodeTable.id, cursor),
              eq(schema.episodeTable.workspaceId, workspaceId)
            )
          )
          .limit(1);
        if (rows.length === 0) break;
        chain.push(rows[0]!);
        cursor = rows[0]!.parentEpisodeId ?? null;
      }

      if (chain.length === 0) throw new Error(`episode ${id} not found`);

      // Reverse to root→leaf order.
      const rootFirst = [...chain].reverse();
      const root = rootFirst[0]!;

      // Fold root→leaf: start from the root narrative and apply each descendant's
      // residual deltaContent in depth order (DELTAMEM §16). A header-less legacy
      // deltaContent is applied as a literal full narrative by applyDelta.
      let reconstructed = root.narrative;
      for (const node of rootFirst.slice(1)) {
        reconstructed = applyDelta(reconstructed, node.deltaContent ?? "");
      }

      // Return the leaf episode (chain[0] is the requested episode) with folded narrative.
      const folded = mapRowToEpisode(chain[0]!);
      return { ...folded, narrative: reconstructed };
    });
  }

  // Spec §16 episode trees: return parent, siblings (same parentEpisodeId),
  // and direct children of the target episode.  Uses idx_episode_tree
  // (workspace_id, parent_episode_id) for both sibling + children lookups.
  async getEpisodeTreeNeighbors(
    episodeId: string,
    workspaceId: string,
    limit = 10
  ): Promise<MnemoEpisode[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      // Fetch the target episode to know its parentEpisodeId.
      const targetRows = await tx
        .select()
        .from(schema.episodeTable)
        .where(
          and(
            eq(schema.episodeTable.id, episodeId),
            eq(schema.episodeTable.workspaceId, workspaceId)
          )
        )
        .limit(1);
      if (targetRows.length === 0) return [];
      const target = targetRows[0]!;

      const neighborIds = new Set<string>();
      const neighborRows: schema.SelectEpisode[] = [];

      // 1. Parent + siblings: episodes with the same parentEpisodeId.
      if (target.parentEpisodeId) {
        const siblingRows = await tx
          .select()
          .from(schema.episodeTable)
          .where(
            and(
              eq(schema.episodeTable.workspaceId, workspaceId),
              eq(schema.episodeTable.parentEpisodeId, target.parentEpisodeId)
            )
          )
          .limit(limit + 1); // +1 to account for self being filtered out
        for (const row of siblingRows) {
          if (row.id === episodeId) continue;
          if (!neighborIds.has(row.id)) {
            neighborIds.add(row.id);
            neighborRows.push(row);
          }
        }
        // Fetch the parent itself (it may not share its own parentEpisodeId with target).
        const parentRows = await tx
          .select()
          .from(schema.episodeTable)
          .where(
            and(
              eq(schema.episodeTable.id, target.parentEpisodeId),
              eq(schema.episodeTable.workspaceId, workspaceId)
            )
          )
          .limit(1);
        if (parentRows[0] && !neighborIds.has(parentRows[0].id)) {
          neighborIds.add(parentRows[0].id);
          neighborRows.unshift(parentRows[0]); // parent first
        }
      }

      // 2. Direct children: uses idx_episode_tree (workspace_id, parent_episode_id).
      const childRows = await tx
        .select()
        .from(schema.episodeTable)
        .where(
          and(
            eq(schema.episodeTable.workspaceId, workspaceId),
            eq(schema.episodeTable.parentEpisodeId, episodeId)
          )
        )
        .limit(limit);
      for (const row of childRows) {
        if (!neighborIds.has(row.id)) {
          neighborIds.add(row.id);
          neighborRows.push(row);
        }
      }

      return neighborRows.slice(0, limit).map(mapRowToEpisode);
    });
  }

  // DELTAMEM §16 — HNSW cosine search over mnemo_episode.embedding. Mirrors
  // searchReasoning's halfvec pattern; the idx_episode_embedding_hnsw index
  // (m=16, ef_construction=64, halfvec_cosine_ops) serves the ORDER BY.
  async findSimilarEpisodes(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEpisode[]> {
    const literal = `[${embedding.join(",")}]`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute<{
        id: string;
        cosine: string | number;
        depth: number;
      }>(sql`
        SELECT id,
               (1 - (embedding <=> ${literal}::halfvec))::float8 AS cosine,
               depth
          FROM mnemosyne.mnemo_episode
         WHERE workspace_id = ${workspaceId}
           AND embedding IS NOT NULL
           AND ${sameWidthAsQuery("embedding", embedding)}
           AND (1 - (embedding <=> ${literal}::halfvec)) >= ${minSim}
         ORDER BY embedding <=> ${literal}::halfvec
         LIMIT ${limit}
      `);
      return (
        rows as unknown as Array<{
          id: string;
          cosine: string | number;
          depth: number;
        }>
      ).map((r) => ({
        id: r.id,
        cosine: Number(r.cosine),
        depth: Number(r.depth),
      }));
    });
  }

  async updateEpisode(id: string, input: UpdateEpisodeInput): Promise<MnemoEpisode> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const existing = await tx
        .select()
        .from(schema.episodeTable)
        .where(
          and(
            eq(schema.episodeTable.id, id),
            eq(schema.episodeTable.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Episode not found: ${id}`);

      const updates: Partial<schema.InsertEpisode> = {};
      if (input.title !== undefined) updates.title = input.title;
      if (input.narrative !== undefined) updates.narrative = input.narrative;
      if (input.topics !== undefined) updates.topics = input.topics;
      if (input.linkedFactIds !== undefined) updates.linkedFactIds = input.linkedFactIds;
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      updates.updatedAt = new Date();

      const rows = await tx
        .update(schema.episodeTable)
        .set(updates)
        .where(eq(schema.episodeTable.id, id))
        .returning();

      return mapRowToEpisode(rows[0]!);
    });
  }

  async archiveEpisode(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = dbNow();
      await tx
        .update(schema.episodeTable)
        .set({ validTo: now, updatedAt: now })
        .where(
          and(eq(schema.episodeTable.id, id), eq(schema.episodeTable.workspaceId, workspaceId))
        );

      await tx.insert(schema.outboxTable).values({
        workspaceId,
        eventType: "vector_delete",
        payload: { id, kind: "episode" },
      });
    });
  }

  async queryEpisodes(filter: EpisodeFilter): Promise<PaginatedResult<MnemoEpisode>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.episodeTable.workspaceId, workspaceId)];
      if (filter.isSynthetic !== undefined)
        conditions.push(eq(schema.episodeTable.isSynthetic, filter.isSynthetic));
      if (filter.after) conditions.push(gte(schema.episodeTable.occurredAt, filter.after));
      if (filter.before) conditions.push(lte(schema.episodeTable.occurredAt, filter.before));
      if (filter.parentEpisodeId !== undefined)
        conditions.push(eq(schema.episodeTable.parentEpisodeId, filter.parentEpisodeId));
      // flatten-legacy-dual-core Slice 3c pt.1 (PR10): `topics` was declared on
      // EpisodeFilter but never wired here — array-overlap match (Postgres `&&`)
      // against the GIN-indexed `topics` column, mirroring legacy episode/query.ts's
      // `${topic} = ANY(topics)` single-topic membership check generalized to "any
      // of the given topics is present".
      if (filter.topics && filter.topics.length > 0) {
        const topicList = sql.join(
          filter.topics.map((t) => sql`${t}`),
          sql`, `
        );
        conditions.push(sql`${schema.episodeTable.topics} && ARRAY[${topicList}]::text[]`);
      }
      if (filter.validAt) {
        conditions.push(lte(schema.episodeTable.validFrom, filter.validAt));
        conditions.push(
          // Typed operators, not raw sql — see querySkills (SKILL-1, 4bc311d).
          or(isNull(schema.episodeTable.validTo), gt(schema.episodeTable.validTo, filter.validAt))!
        );
      }

      const whereClause = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx.select().from(schema.episodeTable).where(whereClause).limit(limit).offset(offset),
        tx.select({ total: count() }).from(schema.episodeTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToEpisode),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }

  async getKnowledgeDistribution(
    workspaceId: string
  ): Promise<Partial<Record<RememberKind, number>>> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const countFrom = async (table: any): Promise<number> => {
        const r = await tx
          .select({ n: count() })
          .from(table)
          .where(eq(table.workspaceId, workspaceId));
        return Number(r[0]?.n ?? 0);
      };
      const [
        fact,
        decision,
        strategy,
        episode,
        entity,
        task,
        event,
        skill,
        workflow,
        reasoning,
        hyperedge,
      ] = await Promise.all([
        countFrom(schema.factTable),
        countFrom(schema.decisionTable),
        countFrom(schema.strategyTable),
        countFrom(schema.episodeTable),
        countFrom(schema.entityTable),
        countFrom(schema.taskTable),
        countFrom(schema.eventTable),
        countFrom(schema.skillTable),
        countFrom(schema.workflowTable),
        countFrom(schema.reasoningTable),
        countFrom(schema.hyperedgeTable),
      ]);
      return {
        fact,
        decision,
        strategy,
        episode,
        entity,
        task,
        event,
        skill,
        workflow,
        reasoning,
        hyperedge,
      };
    });
  }

  async persistCompression(input: {
    workspaceId: string;
    rootEpisodeId: string;
    compressedNarrative: string;
    retainedDeltas: Array<{ episodeId: string; deltaContent: string }>;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      await tx
        .update(schema.episodeTable)
        .set({
          narrative: input.compressedNarrative,
          metadata: sql`COALESCE(${schema.episodeTable.metadata}, '{}'::jsonb) || ${JSON.stringify({ compressed: true, compressedAt: new Date().toISOString(), retainedDeltas: input.retainedDeltas })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.episodeTable.id, input.rootEpisodeId),
            eq(schema.episodeTable.workspaceId, input.workspaceId)
          )
        );
    });
  }
}
