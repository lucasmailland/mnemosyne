import { dbNow } from "./_clock.js";
import { eq, and, sql, count, lte, gt, isNull, or } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { projectPrimitiveText } from "@mnemo-ai/types";
import { sameWidthAsQuery } from "./_embedding-width.js";
import { mapRowToReasoning } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoReasoning,
  CreateReasoningInput,
  UpdateReasoningInput,
  ReasoningFilter,
  PaginatedResult,
  MnemoAgentProfile,
} from "@mnemo-ai/types";

function mapRowToAgentProfile(
  row: typeof schema.agentProfileTable.$inferSelect
): MnemoAgentProfile {
  return {
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    summary: row.summary,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ReasoningRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async createReasoning(input: CreateReasoningInput): Promise<MnemoReasoning> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.reasoningTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          question: input.question,
          chain: (input.chain ?? []) as unknown as Record<string, unknown>[],
          conclusion: input.conclusion,
          topicKey: input.topicKey,
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id,
          kind: "reasoning",
          text: projectPrimitiveText("reasoning", {
            question: input.question,
            conclusion: input.conclusion,
          }),
        },
      });

      return mapRowToReasoning(rows[0]!);
    });
  }

  async getReasoning(id: string, workspaceId: string): Promise<MnemoReasoning | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.reasoningTable)
        .where(
          and(eq(schema.reasoningTable.id, id), eq(schema.reasoningTable.workspaceId, workspaceId))
        )
        .limit(1);
      return rows[0] ? mapRowToReasoning(rows[0]) : null;
    });
  }

  async updateReasoning(id: string, input: UpdateReasoningInput): Promise<MnemoReasoning> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const existing = await tx
        .select()
        .from(schema.reasoningTable)
        .where(
          and(
            eq(schema.reasoningTable.id, id),
            eq(schema.reasoningTable.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Reasoning not found: ${id}`);

      const updates: Partial<schema.InsertReasoning> = {};
      if (input.status !== undefined) updates.status = input.status;
      if (input.chain !== undefined)
        updates.chain = input.chain as unknown as Record<string, unknown>[];
      if (input.conclusion !== undefined) updates.conclusion = input.conclusion;
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      updates.updatedAt = new Date();

      const rows = await tx
        .update(schema.reasoningTable)
        .set(updates)
        .where(eq(schema.reasoningTable.id, id))
        .returning();

      return mapRowToReasoning(rows[0]!);
    });
  }

  async archiveReasoning(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.reasoningTable)
        .set({ status: "archived", validTo: dbNow(), updatedAt: dbNow() })
        .where(
          and(eq(schema.reasoningTable.id, id), eq(schema.reasoningTable.workspaceId, workspaceId))
        );

      await tx.insert(schema.outboxTable).values({
        workspaceId,
        eventType: "vector_delete",
        payload: { id, kind: "reasoning" },
      });
    });
  }

  async queryReasoning(filter: ReasoningFilter): Promise<PaginatedResult<MnemoReasoning>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.reasoningTable.workspaceId, workspaceId)];
      if (filter.status) conditions.push(eq(schema.reasoningTable.status, filter.status));
      if (filter.topicKey) conditions.push(eq(schema.reasoningTable.topicKey, filter.topicKey));
      // PRIM-16: current rows only (open validity interval), like the other kinds.
      if (filter.validAt) {
        conditions.push(lte(schema.reasoningTable.validFrom, filter.validAt));
        conditions.push(
          or(
            isNull(schema.reasoningTable.validTo),
            gt(schema.reasoningTable.validTo, filter.validAt)
          )!
        );
      }
      if (filter.openOnly) conditions.push(isNull(schema.reasoningTable.validTo));

      const whereClause = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx.select().from(schema.reasoningTable).where(whereClause).limit(limit).offset(offset),
        tx.select({ total: count() }).from(schema.reasoningTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToReasoning),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }

  async searchReasoning(input: {
    workspaceId: string;
    vector: number[];
    limit: number;
    includeAllStatuses?: boolean;
  }): Promise<
    Array<{
      id: string;
      cosine: number;
      worth: number;
      successCount: number;
      failureCount: number;
      status: MnemoReasoning["status"];
    }>
  > {
    const literal = `[${input.vector.join(",")}]`;
    const statusFilter = input.includeAllStatuses ? sql`TRUE` : sql`status IN ('active', 'golden')`;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const rows = await tx.execute<{
        id: string;
        cosine: string | number;
        worth: string | number;
        success_count: string | number;
        failure_count: string | number;
        status: string;
      }>(sql`
        SELECT id,
               (1 - (embedding <=> ${literal}::halfvec))::float8 AS cosine,
               worth,
               success_count,
               failure_count,
               status
          FROM mnemosyne.mnemo_reasoning
         WHERE workspace_id = ${input.workspaceId}
           AND embedding IS NOT NULL
           AND ${sameWidthAsQuery("embedding", input.vector)}
           AND ${statusFilter}
         ORDER BY embedding <=> ${literal}::halfvec
         LIMIT ${input.limit}
      `);
      return (
        rows as unknown as Array<{
          id: string;
          cosine: string | number;
          worth: string | number;
          success_count: string | number;
          failure_count: string | number;
          status: string;
        }>
      ).map((r) => ({
        id: r.id,
        cosine: Number(r.cosine),
        worth: Number(r.worth),
        successCount: Number(r.success_count),
        failureCount: Number(r.failure_count),
        status: r.status as MnemoReasoning["status"],
      }));
    });
  }

  async recordReasoningUse(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.reasoningTable)
        .set({
          usageCount: sql`usage_count + 1`,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(schema.reasoningTable.id, id), eq(schema.reasoningTable.workspaceId, workspaceId))
        );
    });
  }

  async setReasoningStatus(
    id: string,
    workspaceId: string,
    status: MnemoReasoning["status"]
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.reasoningTable)
        .set({ status, updatedAt: new Date() })
        .where(
          and(eq(schema.reasoningTable.id, id), eq(schema.reasoningTable.workspaceId, workspaceId))
        );
    });
  }

  async getAgentProfile(workspaceId: string, agentId: string): Promise<MnemoAgentProfile | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.agentProfileTable)
        .where(
          and(
            eq(schema.agentProfileTable.workspaceId, workspaceId),
            eq(schema.agentProfileTable.agentId, agentId)
          )
        )
        .limit(1);
      return rows[0] ? mapRowToAgentProfile(rows[0]) : null;
    });
  }

  async upsertAgentProfile(input: {
    workspaceId: string;
    agentId: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MnemoAgentProfile> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const now = new Date();
      const [row] = await tx
        .insert(schema.agentProfileTable)
        .values({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          summary: input.summary ?? "",
          metadata: input.metadata ?? {},
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.agentProfileTable.workspaceId, schema.agentProfileTable.agentId],
          set: {
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            updatedAt: now,
          },
        })
        .returning();
      if (!row) throw new Error("upsertAgentProfile: UPSERT returned no rows");
      return mapRowToAgentProfile(row);
    });
  }

  async incrementSessionsSinceReflection(workspaceId: string, agentId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = new Date();
      // Read-modify-write in the same transaction (SELECT FOR UPDATE → UPDATE)
      const existing = await tx
        .select()
        .from(schema.agentProfileTable)
        .where(
          and(
            eq(schema.agentProfileTable.workspaceId, workspaceId),
            eq(schema.agentProfileTable.agentId, agentId)
          )
        )
        .for("update")
        .limit(1);

      const prevMeta = (existing[0]?.metadata as Record<string, unknown>) ?? {};
      const prev = (prevMeta.sessionsSinceReflection as number | undefined) ?? 0;
      const next = prev + 1;
      const newMeta = { ...prevMeta, sessionsSinceReflection: next };

      if (existing[0]) {
        await tx
          .update(schema.agentProfileTable)
          .set({ metadata: newMeta, updatedAt: now })
          .where(
            and(
              eq(schema.agentProfileTable.workspaceId, workspaceId),
              eq(schema.agentProfileTable.agentId, agentId)
            )
          );
      } else {
        await tx.insert(schema.agentProfileTable).values({
          workspaceId,
          agentId,
          summary: "",
          metadata: newMeta,
          createdAt: now,
          updatedAt: now,
        });
      }
      return next;
    });
  }
}
