import { closeAt, dbNow } from "./_clock.js";
import { eq, and, or, lte, gt, isNull, sql, count, inArray } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { projectPrimitiveText } from "@mnemo-ai/types";
import { mapRowToStrategy, mapRowToWorkflow, mapRowToSkill } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type {
  MnemoStrategy,
  CreateStrategyInput,
  UpdateStrategyInput,
  StrategyFilter,
  MnemoWorkflow,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowFilter,
  MnemoSkill,
  CreateSkillInput,
  UpdateSkillInput,
  SkillFilter,
  PaginatedResult,
} from "@mnemo-ai/types";
import { StorageConflictError, StorageNotFoundError, scopeRefValues } from "@mnemo-ai/types";

export class KnowledgeRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  // ─── Strategies ─────────────────────────────────────────────────────────────

  async createStrategy(input: CreateStrategyInput): Promise<MnemoStrategy> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      // PRIM-11: `supersedesId` is a lifecycle transition, not a passive pointer.
      // Lock the predecessor (same workspace), refuse it when it is already closed
      // — which also makes two concurrent replacements serialize, one winning —
      // and close it in the SAME transaction that inserts the successor.
      let predecessorId: string | undefined;
      if (input.supersedesId) {
        const pred = await tx
          .select()
          .from(schema.strategyTable)
          .where(
            and(
              eq(schema.strategyTable.id, input.supersedesId),
              eq(schema.strategyTable.workspaceId, input.workspaceId)
            )
          )
          .for("update")
          .limit(1);
        if (!pred[0]) {
          throw new StorageNotFoundError(`Strategy ${input.supersedesId} not found`);
        }
        if (pred[0].status !== "active" || pred[0].validTo != null) {
          throw new StorageConflictError(
            `Strategy ${input.supersedesId} is ${pred[0].status} and cannot be superseded`
          );
        }
        predecessorId = pred[0].id;
      }

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.strategyTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          scopeRef: input.scopeRef,
          trigger: input.trigger,
          action: input.action,
          context: input.context,
          relatedFacts: input.relatedFacts ?? [],
          attribution: input.attribution ?? "inferred",
          supersedesId: input.supersedesId,
          validFrom: input.validFrom ?? dbNow(),
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        // P65: was `input.trigger + " " + input.action` inline. Same result
        // today, but the projection now has ONE source of truth
        // (PRIMITIVE_TEXT_PROJECTION) instead of a copy here that could drift
        // from what recall's lexical column indexes.
        payload: {
          id,
          kind: "strategy",
          text: projectPrimitiveText("strategy", {
            trigger: input.trigger,
            action: input.action,
          }),
        },
      });

      if (predecessorId) {
        const now = dbNow();
        await tx
          .update(schema.strategyTable)
          .set({ status: "superseded", validTo: now, updatedAt: now })
          .where(eq(schema.strategyTable.id, predecessorId));
        await tx.insert(schema.relationTable).values({
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          sourceKind: "strategy",
          sourceId: id,
          targetKind: "strategy",
          targetId: predecessorId,
          relation: "supersedes",
          hebbianWeight: 1.0,
          actorId: input.actorId,
          userId: input.userId,
          actorType: input.actorType,
        });
        // The replaced strategy must stop being recallable.
        await tx.insert(schema.outboxTable).values({
          workspaceId: input.workspaceId,
          eventType: "vector_delete",
          payload: { id: predecessorId, kind: "strategy" },
        });
      }

      return mapRowToStrategy(rows[0]!);
    });
  }

  async getStrategy(id: string, workspaceId: string): Promise<MnemoStrategy | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.strategyTable)
        .where(
          and(eq(schema.strategyTable.id, id), eq(schema.strategyTable.workspaceId, workspaceId))
        )
        .limit(1);
      return rows[0] ? mapRowToStrategy(rows[0]) : null;
    });
  }

  async updateStrategy(id: string, input: UpdateStrategyInput): Promise<MnemoStrategy> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const existing = await tx
        .select()
        .from(schema.strategyTable)
        .where(
          and(
            eq(schema.strategyTable.id, id),
            eq(schema.strategyTable.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Strategy not found: ${id}`);

      const updates: Partial<schema.InsertStrategy> = {};
      if (input.trigger !== undefined) updates.trigger = input.trigger;
      if (input.action !== undefined) updates.action = input.action;
      if (input.context !== undefined) updates.context = input.context;
      if (input.status !== undefined) updates.status = input.status;
      if (input.validTo !== undefined)
        updates.validTo = closeAt(input.validTo, schema.strategyTable.validFrom) as unknown as Date;
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      if (input.successCount !== undefined) updates.successCount = input.successCount;
      if (input.failureCount !== undefined) updates.failureCount = input.failureCount;
      if (input.relatedFacts !== undefined) updates.relatedFacts = input.relatedFacts;
      if (input.attribution !== undefined) updates.attribution = input.attribution;
      // worth is a GENERATED column; drive it via the Beta evidence pair instead.
      // alpha = 2 + successCount, beta = 2 + failureCount (Bayesian +2 prior).
      if (input.successCount !== undefined || input.failureCount !== undefined) {
        const sc = input.successCount ?? existing[0].successCount;
        const fc = input.failureCount ?? existing[0].failureCount;
        updates.worthAlpha = String(2 + sc);
        updates.worthBeta = String(2 + fc);
      }
      updates.updatedAt = new Date();

      const rows = await tx
        .update(schema.strategyTable)
        .set(updates)
        .where(eq(schema.strategyTable.id, id))
        .returning();

      return mapRowToStrategy(rows[0]!);
    });
  }

  async archiveStrategy(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = dbNow();
      await tx
        .update(schema.strategyTable)
        .set({ status: "archived", validTo: now, updatedAt: now })
        .where(
          and(eq(schema.strategyTable.id, id), eq(schema.strategyTable.workspaceId, workspaceId))
        );

      await tx.insert(schema.outboxTable).values({
        workspaceId,
        eventType: "vector_delete",
        payload: { id, kind: "strategy" },
      });
    });
  }

  async queryStrategies(filter: StrategyFilter): Promise<PaginatedResult<MnemoStrategy>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.strategyTable.workspaceId, workspaceId)];
      if (filter.status) conditions.push(eq(schema.strategyTable.status, filter.status));
      const scopeRefs = scopeRefValues(filter);
      if (scopeRefs)
        conditions.push(
          or(
            inArray(schema.strategyTable.scopeRef, scopeRefs),
            isNull(schema.strategyTable.scopeRef)
          )!
        );
      if (filter.validAt) {
        conditions.push(lte(schema.strategyTable.validFrom, filter.validAt));
        conditions.push(
          // Typed operators, not raw sql — see querySkills (SKILL-1, 4bc311d).
          or(
            isNull(schema.strategyTable.validTo),
            gt(schema.strategyTable.validTo, filter.validAt)
          )!
        );
      }
      if (filter.openOnly) conditions.push(isNull(schema.strategyTable.validTo));

      const whereClause = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx.select().from(schema.strategyTable).where(whereClause).limit(limit).offset(offset),
        tx.select({ total: count() }).from(schema.strategyTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToStrategy),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }

  // ─── Workflows ──────────────────────────────────────────────────────────────

  async createWorkflow(input: CreateWorkflowInput): Promise<MnemoWorkflow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.workflowTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          agentId: input.agentId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          scopeRef: input.scopeRef,
          name: input.name,
          description: input.description,
          steps: input.steps as unknown as Record<string, unknown>[],
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      // P65: workflows were persisted and never indexed — no outbox entry, and
      // until migration 0033 not even an `embedding` column to put a vector in.
      // Written, and invisible to recall forever. In the same transaction as
      // the INSERT, which is the contract (spec Req 1): a row that exists
      // without its index entry is the "write-only memory" this closes.
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id,
          kind: "workflow",
          text: projectPrimitiveText("workflow", {
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
          }),
        },
      });

      return mapRowToWorkflow(rows[0]!);
    });
  }

  async getWorkflow(id: string, workspaceId: string): Promise<MnemoWorkflow | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.workflowTable)
        .where(
          and(eq(schema.workflowTable.id, id), eq(schema.workflowTable.workspaceId, workspaceId))
        )
        .limit(1);
      return rows[0] ? mapRowToWorkflow(rows[0]) : null;
    });
  }

  async updateWorkflow(id: string, input: UpdateWorkflowInput): Promise<MnemoWorkflow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const existing = await tx
        .select()
        .from(schema.workflowTable)
        .where(
          and(
            eq(schema.workflowTable.id, id),
            eq(schema.workflowTable.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Workflow not found: ${id}`);

      const updates: Partial<schema.InsertWorkflow> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined) updates.description = input.description;
      if (input.steps !== undefined)
        updates.steps = input.steps as unknown as Record<string, unknown>[];
      if (input.status !== undefined) updates.status = input.status;
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      updates.updatedAt = new Date();

      const rows = await tx
        .update(schema.workflowTable)
        .set(updates)
        .where(eq(schema.workflowTable.id, id))
        .returning();

      return mapRowToWorkflow(rows[0]!);
    });
  }

  async archiveWorkflow(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = dbNow();
      await tx
        .update(schema.workflowTable)
        .set({ status: "deprecated", validTo: now, updatedAt: now })
        .where(
          and(eq(schema.workflowTable.id, id), eq(schema.workflowTable.workspaceId, workspaceId))
        );
      // Workflow has no embedding column — no vector_delete outbox entry needed.
    });
  }

  async queryWorkflows(filter: WorkflowFilter): Promise<PaginatedResult<MnemoWorkflow>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.workflowTable.workspaceId, workspaceId)];
      if (filter.status) conditions.push(eq(schema.workflowTable.status, filter.status));
      const scopeRefs = scopeRefValues(filter);
      if (scopeRefs)
        conditions.push(
          or(
            inArray(schema.workflowTable.scopeRef, scopeRefs),
            isNull(schema.workflowTable.scopeRef)
          )!
        );
      if (filter.validAt) {
        conditions.push(lte(schema.workflowTable.validFrom, filter.validAt));
        conditions.push(
          // Typed operators, not raw sql — see querySkills (SKILL-1, 4bc311d).
          or(
            isNull(schema.workflowTable.validTo),
            gt(schema.workflowTable.validTo, filter.validAt)
          )!
        );
      }
      if (filter.openOnly) conditions.push(isNull(schema.workflowTable.validTo));

      const whereClause = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx.select().from(schema.workflowTable).where(whereClause).limit(limit).offset(offset),
        tx.select({ total: count() }).from(schema.workflowTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToWorkflow),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }

  // ─── Skills ─────────────────────────────────────────────────────────────────

  async createSkill(input: CreateSkillInput): Promise<MnemoSkill> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      const id = crypto.randomUUID();
      const rows = await tx
        .insert(schema.skillTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          agentId: input.agentId,
          userId: input.userId,
          actorType: input.actorType,
          scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
          name: input.name,
          promptTemplate: input.promptTemplate,
          variables: input.variables ?? [],
          requiredContext: input.requiredContext ?? [],
          ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        // P65: was an inline join. One source of truth (the registry) so the
        // outbox text can never drift from what the lexical column indexes.
        payload: {
          id,
          kind: "skill",
          text: projectPrimitiveText("skill", {
            name: input.name,
            promptTemplate: input.promptTemplate,
          }),
        },
      });

      return mapRowToSkill(rows[0]!);
    });
  }

  async getSkill(id: string, workspaceId: string): Promise<MnemoSkill | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.skillTable)
        .where(and(eq(schema.skillTable.id, id), eq(schema.skillTable.workspaceId, workspaceId)))
        .limit(1);
      return rows[0] ? mapRowToSkill(rows[0]) : null;
    });
  }

  async updateSkill(id: string, input: UpdateSkillInput): Promise<MnemoSkill> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const existing = await tx
        .select()
        .from(schema.skillTable)
        .where(
          and(eq(schema.skillTable.id, id), eq(schema.skillTable.workspaceId, input.workspaceId))
        )
        .limit(1);
      if (!existing[0]) throw new Error(`Skill not found: ${id}`);

      const updates: Partial<schema.InsertSkill> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.promptTemplate !== undefined) updates.promptTemplate = input.promptTemplate;
      if (input.variables !== undefined) updates.variables = input.variables;
      if (input.requiredContext !== undefined) updates.requiredContext = input.requiredContext;
      if (input.metadata !== undefined)
        updates.metadata = input.metadata as Record<string, unknown>;
      updates.updatedAt = new Date();

      const rows = await tx
        .update(schema.skillTable)
        .set(updates)
        .where(eq(schema.skillTable.id, id))
        .returning();

      return mapRowToSkill(rows[0]!);
    });
  }

  async archiveSkill(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const now = dbNow();
      await tx
        .update(schema.skillTable)
        .set({ validTo: now, updatedAt: now })
        .where(and(eq(schema.skillTable.id, id), eq(schema.skillTable.workspaceId, workspaceId)));

      await tx.insert(schema.outboxTable).values({
        workspaceId,
        eventType: "vector_delete",
        payload: { id, kind: "skill" },
      });
    });
  }

  async querySkills(filter: SkillFilter): Promise<PaginatedResult<MnemoSkill>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const conditions = [eq(schema.skillTable.workspaceId, workspaceId)];
      if (filter.validAt) {
        conditions.push(lte(schema.skillTable.validFrom, filter.validAt));
        conditions.push(
          // Drizzle's typed column operators (gt/isNull), not a raw `sql`
          // template — embedding a bare JS Date directly inside `sql\`...${date}...\``
          // skips the column-aware driver-value mapping that `lte` above gets
          // for free, and postgres.js rejects the resulting raw Date parameter.
          or(isNull(schema.skillTable.validTo), gt(schema.skillTable.validTo, filter.validAt))!
        );
      }
      if (filter.openOnly) conditions.push(isNull(schema.skillTable.validTo));

      const whereClause = and(...conditions);
      const [rows, countRows] = await Promise.all([
        tx.select().from(schema.skillTable).where(whereClause).limit(limit).offset(offset),
        tx.select({ total: count() }).from(schema.skillTable).where(whereClause),
      ]);

      const total = Number(countRows[0]?.total ?? 0);
      return {
        items: rows.map(mapRowToSkill),
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
      };
    });
  }
}
