import { eq, and, gte, lte, sql, count } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { projectPrimitiveText } from "@mnemo-ai/types";
import { mapRowToEvent } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoEvent,
  CreateEventInput,
  EventFilter,
  PaginatedResult,
  Sensitivity,
} from "@mnemo-ai/types";

export class EventRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async createEvent(input: CreateEventInput): Promise<MnemoEvent> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.eventTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          type: input.type,
          name: input.name,
          description: input.description,
          occurredAt: input.occurredAt,
          durationS: input.durationS,
          source: input.source,
          relatedEntities: input.relatedEntities ?? [],
          annotations: (input.annotations ?? []) as unknown as Record<string, unknown>[],
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      // P65: events were persisted and never indexed — no outbox entry, and
      // until migration 0034 not even an `embedding` column. In the same
      // transaction as the INSERT, which is the contract (spec Req 1).
      // Indexed but NOT default-on: reachable via RecallQuery.kinds, never
      // arriving unbidden on an unrelated question.
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id,
          kind: "event",
          text: projectPrimitiveText("event", {
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
          }),
        },
      });
      return mapRowToEvent(rows[0]!);
    });
  }

  async getEvent(id: string, workspaceId: string): Promise<MnemoEvent | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.eventTable)
        .where(and(eq(schema.eventTable.id, id), eq(schema.eventTable.workspaceId, workspaceId)))
        .limit(1);
      return rows[0] ? mapRowToEvent(rows[0]) : null;
    });
  }

  async archiveEvent(_id: string, workspaceId: string): Promise<void> {
    // EVENT-1: intentional NO-OP. mnemo_event has no status/valid_to column —
    // there is nothing to flip — so this reads/writes no row at all. Adding
    // real soft-close here is a feature (migration + RLS/GRANT + EventFilter
    // semantics), not a bug fix; do not "fix" this without that decision.
    // GUC still set for RLS consistency with every other transactional call.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
    });
  }

  async appendEventAnnotation(
    id: string,
    workspaceId: string,
    annotation: { author: string; content: string; at: Date }
  ): Promise<MnemoEvent> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const payload = JSON.stringify([
        { author: annotation.author, content: annotation.content, at: annotation.at.toISOString() },
      ]);
      const rows = await tx
        .update(schema.eventTable)
        .set({
          annotations: sql`${schema.eventTable.annotations} || ${payload}::jsonb`,
        })
        .where(and(eq(schema.eventTable.id, id), eq(schema.eventTable.workspaceId, workspaceId)))
        .returning();
      if (!rows[0]) throw new Error(`Event not found: ${id}`);
      return mapRowToEvent(rows[0]);
    });
  }

  async updateEventSensitivity(
    id: string,
    workspaceId: string,
    sensitivity: Sensitivity
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.eventTable)
        .set({ sensitivity })
        .where(and(eq(schema.eventTable.id, id), eq(schema.eventTable.workspaceId, workspaceId)));
    });
  }

  async queryEvents(filter: EventFilter): Promise<PaginatedResult<MnemoEvent>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.eventTable.workspaceId, workspaceId)];
      if (filter.type) conditions.push(eq(schema.eventTable.type, filter.type));
      if (filter.source) conditions.push(eq(schema.eventTable.source, filter.source));
      if (filter.after) conditions.push(gte(schema.eventTable.occurredAt, filter.after));
      if (filter.before) conditions.push(lte(schema.eventTable.occurredAt, filter.before));

      const whereClause = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx.select().from(schema.eventTable).where(whereClause).limit(limit).offset(offset),
        tx.select({ total: count() }).from(schema.eventTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToEvent),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }
}
