import { dbNow } from "./_clock.js";
import { eq, and, or, lte, gt, isNull, sql, count, desc } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { sameWidthAsQuery } from "./_embedding-width.js";
import { mapRowToEntity } from "./mappers.js";
import { rethrowAsConflict } from "./_pg-errors.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoEntity,
  CreateEntityInput,
  UpdateEntityInput,
  EntityFilter,
  PaginatedResult,
  SimilarEntity,
  SupersedeEntityInput,
} from "@mnemo-ai/types";
import { StorageConflictError, StorageNotFoundError } from "@mnemo-ai/types";

const ENTITY_CONFLICTS = {
  uq_mnemo_entity_live_name_kind: "An entity with this name and kind already exists",
  uq_mnemo_entity_linked_user_live: "That user is already linked to another live entity",
};

export class EntityRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async createEntity(input: CreateEntityInput): Promise<MnemoEntity> {
    return this.insertEntity(input).catch((err) => rethrowAsConflict(err, ENTITY_CONFLICTS));
  }

  private async insertEntity(input: CreateEntityInput): Promise<MnemoEntity> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.entityTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          agentId: input.agentId,
          userId: input.userId,
          actorType: input.actorType,
          // linkedUserId is deliberately NOT accepted from CreateEntityInput —
          // it is only ever set via the (future, Phase 3) trusted
          // POST /entities/:id/link-user route, never on create/update.
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          name: input.name,
          kind: input.kind,
          aliases: input.aliases ?? [],
          canonicalId: input.canonicalId,
          description: input.description,
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      // P16: enqueue vector_upsert so the OutboxWorker embeds the entity text.
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: { id, kind: "entity", text: input.name + " " + (input.description ?? "") },
      });

      return mapRowToEntity(rows[0]!);
    });
  }

  async getEntity(id: string, workspaceId: string): Promise<MnemoEntity | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.entityTable)
        .where(and(eq(schema.entityTable.id, id), eq(schema.entityTable.workspaceId, workspaceId)))
        .limit(1);
      return rows[0] ? mapRowToEntity(rows[0]) : null;
    });
  }

  async updateEntity(id: string, input: UpdateEntityInput): Promise<MnemoEntity> {
    return this.patchEntity(id, input).catch((err) => rethrowAsConflict(err, ENTITY_CONFLICTS));
  }

  private async patchEntity(id: string, input: UpdateEntityInput): Promise<MnemoEntity> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const existing = await tx
        .select()
        .from(schema.entityTable)
        .where(
          and(eq(schema.entityTable.id, id), eq(schema.entityTable.workspaceId, input.workspaceId))
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Entity not found: ${id}`);

      const updates: Partial<schema.InsertEntity> = {};
      if (input.name !== undefined) updates.name = input.name;
      // flatten-legacy-dual-core PR9a / D6.2: `kind` was omitted from
      // UpdateEntityInput's Pick<> union and silently dropped here even
      // though the legacy route (routes/entities.ts patchEntityRoute)
      // accepts a kind patch — the physical column already supports it.
      if (input.kind !== undefined) updates.kind = input.kind;
      if (input.aliases !== undefined) updates.aliases = input.aliases;
      if (input.description !== undefined) updates.description = input.description;
      if (input.canonicalId !== undefined) updates.canonicalId = input.canonicalId;
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      // linkedUserId/validTo/sensitivity: written only by the trusted
      // POST/DELETE /entities/:id/link-user route (never create/update),
      // and by the bitemporal-close step of unlinking. See routes/entities.ts.
      if (input.linkedUserId !== undefined) updates.linkedUserId = input.linkedUserId;
      if (input.validTo !== undefined) updates.validTo = input.validTo;
      if (input.sensitivity !== undefined) updates.sensitivity = input.sensitivity;
      updates.updatedAt = new Date();

      const rows = await tx
        .update(schema.entityTable)
        .set(updates)
        .where(eq(schema.entityTable.id, id))
        .returning();

      // P16: re-enqueue vector_upsert so updated name/description gets re-embedded.
      const entity = mapRowToEntity(rows[0]!);
      const embedText = entity.name + " " + (entity.description ?? "");
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: { id, kind: "entity", text: embedText },
      });

      return entity;
    });
  }

  /**
   * PRIM-2 — close + successor + `supersedes` lineage + embedding upkeep in ONE
   * transaction. The row lock makes concurrent revisions of the same entity
   * serialize: the loser re-reads a closed row and conflicts instead of
   * forking the entity into two live versions.
   */
  async supersedeEntity(input: SupersedeEntityInput): Promise<MnemoEntity> {
    return this.runSupersede(input).catch((err) => rethrowAsConflict(err, ENTITY_CONFLICTS));
  }

  private async runSupersede(input: SupersedeEntityInput): Promise<MnemoEntity> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const locked = await tx
        .select()
        .from(schema.entityTable)
        .where(
          and(
            eq(schema.entityTable.id, input.id),
            eq(schema.entityTable.workspaceId, input.workspaceId)
          )
        )
        .for("update")
        .limit(1);
      const closed = locked[0];
      if (!closed) throw new StorageNotFoundError(`Entity ${input.id} not found`);
      if (closed.validTo != null) {
        throw new StorageConflictError(`Entity ${input.id} is already closed`);
      }

      const now = dbNow();
      await tx
        .update(schema.entityTable)
        .set({ validTo: now, updatedAt: now })
        .where(eq(schema.entityTable.id, input.id));

      const successorId = crypto.randomUUID();
      const s = input.successor;
      const rows = await tx
        .insert(schema.entityTable)
        .values({
          id: successorId,
          workspaceId: input.workspaceId,
          actorId: s.actorId ?? closed.actorId,
          agentId: closed.agentId,
          userId: s.userId !== undefined ? s.userId : closed.userId,
          actorType: s.actorType ?? closed.actorType,
          linkedUserId: s.linkedUserId,
          scopeOwner: closed.scopeOwner,
          name: closed.name,
          kind: closed.kind,
          aliases: closed.aliases,
          canonicalId: closed.canonicalId,
          description: closed.description,
          sensitivity: s.sensitivity ?? closed.sensitivity,
          metadata: closed.metadata as Record<string, unknown>,
          validFrom: now,
        })
        .returning();

      await tx.insert(schema.relationTable).values({
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        sourceKind: "entity",
        sourceId: successorId,
        targetKind: "entity",
        targetId: input.id,
        relation: "supersedes",
        hebbianWeight: 1.0,
        actorId: s.actorId,
        userId: s.userId,
        actorType: s.actorType,
      });

      const entity = mapRowToEntity(rows[0]!);
      await tx.insert(schema.outboxTable).values([
        {
          workspaceId: input.workspaceId,
          eventType: "vector_delete",
          payload: { id: input.id, kind: "entity" },
        },
        {
          workspaceId: input.workspaceId,
          eventType: "vector_upsert",
          payload: {
            id: successorId,
            kind: "entity",
            text: entity.name + " " + (entity.description ?? ""),
          },
        },
      ]);
      return entity;
    });
  }

  // P16 — HNSW cosine search over mnemo_entity.embedding.
  // Mirrors EpisodeRepository.findSimilarEpisodes: set_workspace GUC, cosine
  // formula, ORDER BY <=> operator, embedding IS NOT NULL predicate.
  async findSimilarEntities(
    workspaceId: string,
    embedding: number[],
    limit: number,
    minSim: number
  ): Promise<SimilarEntity[]> {
    const literal = `[${embedding.join(",")}]`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute<{ id: string; cosine: string | number }>(sql`
        SELECT id,
               (1 - (embedding <=> ${literal}::public.halfvec))::float8 AS cosine
          FROM mnemosyne.mnemo_entity
         WHERE workspace_id = ${workspaceId}
           AND embedding IS NOT NULL
           AND ${sameWidthAsQuery("embedding", embedding)}
           AND (1 - (embedding <=> ${literal}::public.halfvec)) >= ${minSim}
         ORDER BY embedding <=> ${literal}::public.halfvec
         LIMIT ${limit}
      `);
      return (rows as unknown as Array<{ id: string; cosine: string | number }>).map((r) => ({
        id: r.id,
        cosine: Number(r.cosine),
      }));
    });
  }

  async archiveEntity(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = dbNow();
      await tx
        .update(schema.entityTable)
        .set({ validTo: now, updatedAt: now })
        .where(and(eq(schema.entityTable.id, id), eq(schema.entityTable.workspaceId, workspaceId)));

      await tx.insert(schema.outboxTable).values({
        workspaceId,
        eventType: "vector_delete",
        payload: { id, kind: "entity" },
      });
    });
  }

  async queryEntities(filter: EntityFilter): Promise<PaginatedResult<MnemoEntity>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.entityTable.workspaceId, workspaceId)];
      if (filter.kind) conditions.push(eq(schema.entityTable.kind, filter.kind));
      if (filter.name) conditions.push(eq(schema.entityTable.name, filter.name));
      // flatten-legacy-dual-core PR9a / D6.2: case-insensitive substring
      // search across name + aliases, mirroring legacy
      // `core/src/entity/query.ts`'s listEntities `q` filter — distinct from
      // `name`, which stays exact-match (eq() above).
      const needle = filter.q?.trim() ?? "";
      if (needle.length > 0) {
        const likePattern = `%${needle.toLowerCase()}%`;
        conditions.push(
          sql`(
            lower(${schema.entityTable.name}) LIKE ${likePattern}
            OR EXISTS (
              SELECT 1 FROM unnest(${schema.entityTable.aliases}) AS a
              WHERE lower(a) LIKE ${likePattern}
            )
          )`
        );
      }
      if (filter.validAt) {
        conditions.push(lte(schema.entityTable.validFrom, filter.validAt));
        conditions.push(
          // Typed operators, not raw sql — see querySkills (SKILL-1, 4bc311d).
          or(isNull(schema.entityTable.validTo), gt(schema.entityTable.validTo, filter.validAt))!
        );
      }
      if (filter.openOnly) conditions.push(isNull(schema.entityTable.validTo));

      const whereClause = and(...conditions);
      // Newest-mentioned first, matching legacy listEntities' ORDER BY —
      // deterministic tiebreakers so a paginated caller doesn't see rows
      // shuffle across requests.
      const orderClause = [
        desc(schema.entityTable.lastSeenAt),
        desc(schema.entityTable.createdAt),
        desc(schema.entityTable.id),
      ];
      const [rows, countRows] = await Promise.all([
        tx
          .select()
          .from(schema.entityTable)
          .where(whereClause)
          .orderBy(...orderClause)
          .limit(limit)
          .offset(offset),
        tx.select({ total: count() }).from(schema.entityTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToEntity),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }
}
