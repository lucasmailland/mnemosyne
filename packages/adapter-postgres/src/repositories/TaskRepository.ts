import { dbNow } from "./_clock.js";
import { eq, and, or, lte, gt, isNull, sql, count } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { projectPrimitiveText } from "@mnemo-ai/types";
import { mapRowToTask } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoTask,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  PaginatedResult,
} from "@mnemo-ai/types";

export class TaskRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async listTasksForSession(
    workspaceId: string,
    sessionId: string
  ): Promise<Array<{ id: string; status: string }>> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute<{ id: string; status: string }>(sql`
        SELECT id, status
        FROM mnemosyne.mnemo_task
        WHERE workspace_id = ${workspaceId}
          AND session_id = ${sessionId}
      `);
      return rows.map((r) => ({ id: r.id, status: r.status }));
    });
  }

  async createTask(input: CreateTaskInput): Promise<MnemoTask> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.taskTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          agentId: input.agentId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          title: input.title,
          description: input.description,
          priority: input.priority ?? "medium",
          assignedTo: input.assignedTo,
          sessionId: input.sessionId,
          parentTaskId: input.parentTaskId,
          dueAt: input.dueAt,
          delegatedBy: input.delegatedBy,
          relatedFacts: input.relatedFacts ?? [],
          relatedEntities: input.relatedEntities ?? [],
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      // P65: tasks were persisted and never indexed — no outbox entry, and
      // until migration 0034 not even an `embedding` column. In the same
      // transaction as the INSERT, which is the contract (spec Req 1).
      // Indexed but NOT default-on: reachable via RecallQuery.kinds, never
      // arriving unbidden on an unrelated question.
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id,
          kind: "task",
          text: projectPrimitiveText("task", {
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
          }),
        },
      });

      return mapRowToTask(rows[0]!);
    });
  }

  async getTask(id: string, workspaceId: string): Promise<MnemoTask | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.taskTable)
        .where(and(eq(schema.taskTable.id, id), eq(schema.taskTable.workspaceId, workspaceId)))
        .limit(1);
      return rows[0] ? mapRowToTask(rows[0]) : null;
    });
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<MnemoTask> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const existing = await tx
        .select()
        .from(schema.taskTable)
        .where(
          and(eq(schema.taskTable.id, id), eq(schema.taskTable.workspaceId, input.workspaceId))
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Task not found: ${id}`);

      const updates: Partial<schema.InsertTask> = {};
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description;
      if (input.status !== undefined) updates.status = input.status;
      if (input.priority !== undefined) updates.priority = input.priority;
      if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;
      if (input.blockedBy !== undefined) updates.blockedBy = input.blockedBy;
      if (input.subtaskIds !== undefined) updates.subtaskIds = input.subtaskIds;
      if (input.outcome !== undefined) updates.outcome = input.outcome;
      if (input.lessonsLearned !== undefined) updates.lessonsLearned = input.lessonsLearned;
      if (input.startedAt !== undefined) updates.startedAt = input.startedAt;
      if (input.completedAt !== undefined) updates.completedAt = input.completedAt;
      if (input.dueAt !== undefined) updates.dueAt = input.dueAt;
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      updates.updatedAt = new Date();

      const rows = await tx
        .update(schema.taskTable)
        .set(updates)
        .where(eq(schema.taskTable.id, id))
        .returning();

      return mapRowToTask(rows[0]!);
    });
  }

  /**
   * B7 — terminal-aware archive: closes the bitemporal validity interval
   * unconditionally, but only forces `status: 'cancelled'` when the task is
   * NOT already in a terminal state (`completed`/`cancelled`). Previously
   * this unconditionally overwrote `status: 'cancelled'`, silently
   * corrupting an already-`completed` task's terminal status on archive.
   */
  async archiveTask(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = dbNow();
      await tx
        .update(schema.taskTable)
        .set({
          status: sql`CASE WHEN ${schema.taskTable.status} IN ('completed', 'cancelled') THEN ${schema.taskTable.status} ELSE 'cancelled' END`,
          validTo: now,
          updatedAt: now,
        })
        .where(and(eq(schema.taskTable.id, id), eq(schema.taskTable.workspaceId, workspaceId)));
    });
  }

  async delegateTask(
    id: string,
    workspaceId: string,
    input: { assignedTo: string; delegatedBy: string }
  ): Promise<MnemoTask> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const existing = await tx
        .select()
        .from(schema.taskTable)
        .where(and(eq(schema.taskTable.id, id), eq(schema.taskTable.workspaceId, workspaceId)))
        .limit(1);
      if (!existing[0]) throw new Error(`Task not found: ${id}`);
      const rows = await tx
        .update(schema.taskTable)
        .set({
          status: "delegated",
          assignedTo: input.assignedTo,
          delegatedBy: input.delegatedBy,
          delegatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.taskTable.id, id), eq(schema.taskTable.workspaceId, workspaceId)))
        .returning();
      return mapRowToTask(rows[0]!);
    });
  }

  async queryTasks(filter: TaskFilter): Promise<PaginatedResult<MnemoTask>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.taskTable.workspaceId, workspaceId)];
      if (filter.status) conditions.push(eq(schema.taskTable.status, filter.status));
      if (filter.assignedTo) conditions.push(eq(schema.taskTable.assignedTo, filter.assignedTo));
      if (filter.parentTaskId)
        conditions.push(eq(schema.taskTable.parentTaskId, filter.parentTaskId));
      if (filter.validAt) {
        conditions.push(lte(schema.taskTable.validFrom, filter.validAt));
        conditions.push(
          // Typed operators, not raw sql — see querySkills (SKILL-1, 4bc311d).
          or(isNull(schema.taskTable.validTo), gt(schema.taskTable.validTo, filter.validAt))!
        );
      }
      if (filter.openOnly) conditions.push(isNull(schema.taskTable.validTo));

      const whereClause = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx.select().from(schema.taskTable).where(whereClause).limit(limit).offset(offset),
        tx.select({ total: count() }).from(schema.taskTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToTask),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }
}
