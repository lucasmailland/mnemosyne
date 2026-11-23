import { dbNow } from "./_clock.js";
import { eq, and, desc, gt, sql, count } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { compositionRuleRowToDomain, inferenceRowToDomain } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import { SENSITIVITY_ORDER, type Sensitivity } from "@mnemo-ai/types";
import type {
  MnemoCompositionRule,
  CreateCompositionRuleInput,
  UpdateCompositionRuleInput,
  CompositionRuleFilter,
  MnemoInferenceLogEntry,
  AppendInferenceInput,
  InferenceLogFilter,
  MaterialiseInferenceInput,
  PaginatedResult,
} from "@mnemo-ai/types";

export class CompositionRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async createCompositionRule(input: CreateCompositionRuleInput): Promise<MnemoCompositionRule> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const id = crypto.randomUUID();
      const [row] = await tx
        .insert(schema.compositionRuleTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          conditionDsl: input.conditionDsl as never,
          actionDsl: input.actionDsl as never,
          priority: input.priority ?? 100,
          isActive: input.isActive ?? true,
          createdBy: input.createdBy,
          source: input.source ?? "manual",
          metadata: (input.metadata ?? {}) as never,
        })
        .returning();
      if (!row) throw new Error("createCompositionRule: INSERT returned no rows");
      return compositionRuleRowToDomain(row);
    });
  }

  async getCompositionRule(id: string, workspaceId: string): Promise<MnemoCompositionRule | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.compositionRuleTable)
        .where(
          and(
            eq(schema.compositionRuleTable.id, id),
            eq(schema.compositionRuleTable.workspaceId, workspaceId)
          )
        )
        .limit(1);
      return rows[0] ? compositionRuleRowToDomain(rows[0]) : null;
    });
  }

  async updateCompositionRule(
    id: string,
    workspaceId: string,
    input: UpdateCompositionRuleInput
  ): Promise<MnemoCompositionRule> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const [row] = await tx
        .update(schema.compositionRuleTable)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.conditionDsl !== undefined && { conditionDsl: input.conditionDsl as never }),
          ...(input.actionDsl !== undefined && { actionDsl: input.actionDsl as never }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          ...(input.metadata !== undefined && { metadata: input.metadata as never }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.compositionRuleTable.id, id),
            eq(schema.compositionRuleTable.workspaceId, workspaceId)
          )
        )
        .returning();
      if (!row) throw new Error(`CompositionRule ${id} not found in workspace ${workspaceId}`);
      return compositionRuleRowToDomain(row);
    });
  }

  async queryCompositionRules(
    filter: CompositionRuleFilter
  ): Promise<PaginatedResult<MnemoCompositionRule>> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);
      const limit = Math.min(filter.limit ?? 50, 500);
      const offset = filter.offset ?? 0;
      const conditions = [eq(schema.compositionRuleTable.workspaceId, filter.workspaceId)];
      if (filter.isActive !== undefined)
        conditions.push(eq(schema.compositionRuleTable.isActive, filter.isActive));
      if (filter.source) conditions.push(eq(schema.compositionRuleTable.source, filter.source));
      const countRows = await tx
        .select({ total: count() })
        .from(schema.compositionRuleTable)
        .where(and(...conditions));
      const total = Number(countRows[0]?.total ?? 0);
      const rows = await tx
        .select()
        .from(schema.compositionRuleTable)
        .where(and(...conditions))
        .orderBy(desc(schema.compositionRuleTable.priority))
        .limit(limit)
        .offset(offset);
      const items = rows.map(compositionRuleRowToDomain);
      return { items, total, offset, limit, hasMore: offset + items.length < total };
    });
  }

  async bumpCompositionExecution(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.compositionRuleTable)
        .set({
          executionCount: sql`${schema.compositionRuleTable.executionCount} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.compositionRuleTable.id, id),
            eq(schema.compositionRuleTable.workspaceId, workspaceId)
          )
        );
    });
  }

  async ensureBuiltinCompositionRules(workspaceId: string): Promise<void> {
    await this.db.execute(sql`SELECT mnemosyne.mnemo_seed_builtin_rules(${workspaceId}::uuid)`);
  }

  // ─── Inference log (Wave E) ──────────────────────────────────────────────

  async appendInference(input: AppendInferenceInput): Promise<MnemoInferenceLogEntry> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const id = crypto.randomUUID();
      const [row] = await tx
        .insert(schema.inferenceLogTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          ruleId: input.ruleId,
          inputFactIds: input.inputFactIds,
          derivedKind: input.derivedKind,
          derivedId: input.derivedId,
          confidence: input.confidence.toFixed(4),
          rationale: input.rationale,
          triggeredByQuery: input.triggeredByQuery,
          conversationId: input.conversationId,
        })
        .returning();
      if (!row) throw new Error("appendInference: INSERT returned no rows");
      return inferenceRowToDomain(row);
    });
  }

  async materialiseInference(input: MaterialiseInferenceInput): Promise<{ id: string }> {
    return this.db.transaction(async (tx) => {
      // 1. Set RLS workspace GUC for this transaction
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      // C1 fail-closed: a derived fact has no writing actor, so no DEK to seal
      // a confidential+ statement with — and that statement is built from its
      // premises' plaintext. Refuse rather than store it in the clear.
      if (
        SENSITIVITY_ORDER[(input.fact.sensitivity ?? "internal") as Sensitivity] >=
        SENSITIVITY_ORDER.confidential
      ) {
        throw new Error(
          `C1 fail-closed: a ${input.fact.sensitivity} derived fact has no actor DEK; refusing to store plaintext.`
        );
      }

      // 2. Insert the derived fact
      const factId = crypto.randomUUID();
      const factRows = await tx
        .insert(schema.factTable)
        .values({
          id: factId,
          workspaceId: input.workspaceId,
          scope: input.fact.scope,
          kind: input.fact.kind,
          subject: input.fact.subject,
          statement: input.fact.statement,
          attribution: input.fact.attribution,
          sensitivity: input.fact.sensitivity,
          // B6.35: a derived fact must never carry a forged pending marker.
          metadata: (() => {
            const { __mnemoConsolidationPending: _pending, ...safe } = (input.fact.metadata ??
              {}) as Record<string, unknown>;
            return safe;
          })(),
          confidence: 0.7,
          sourceMessageIds: [],
          validFrom: dbNow(),
        })
        .returning();
      if (!factRows[0]) throw new Error("materialiseInference: fact INSERT returned no rows");

      // 3. Outbox event so the vector embedding worker picks up the new fact (CRIT-05)
      await tx.insert(schema.outboxTable).values({
        workspaceId: input.workspaceId,
        eventType: "vector_upsert",
        payload: { id: factId, kind: "fact", text: input.fact.statement },
      });

      // 4. Insert inference log entry
      const logId = crypto.randomUUID();
      const logRows = await tx
        .insert(schema.inferenceLogTable)
        .values({
          id: logId,
          workspaceId: input.workspaceId,
          ruleId: input.ruleId,
          inputFactIds: input.inferenceLog.inputFactIds,
          derivedKind: input.inferenceLog.derivedKind,
          derivedId: factId,
          confidence: input.inferenceLog.confidence.toFixed(4),
          rationale: input.inferenceLog.rationale,
          triggeredByQuery: input.inferenceLog.triggeredByQuery,
          conversationId: input.inferenceLog.conversationId,
        })
        .returning();
      if (!logRows[0])
        throw new Error("materialiseInference: inference_log INSERT returned no rows");

      // 5. Bump execution_count on the composition rule
      await tx
        .update(schema.compositionRuleTable)
        .set({
          executionCount: sql`${schema.compositionRuleTable.executionCount} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.compositionRuleTable.id, input.ruleId),
            eq(schema.compositionRuleTable.workspaceId, input.workspaceId)
          )
        );

      return { id: factId };
    });
  }

  async queryInferences(
    filter: InferenceLogFilter
  ): Promise<PaginatedResult<MnemoInferenceLogEntry>> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);
      const limit = Math.min(filter.limit ?? 100, 500);
      const offset = filter.offset ?? 0;
      const conditions = [eq(schema.inferenceLogTable.workspaceId, filter.workspaceId)];
      if (filter.ruleId) conditions.push(eq(schema.inferenceLogTable.ruleId, filter.ruleId));
      if (filter.derivedId)
        conditions.push(eq(schema.inferenceLogTable.derivedId, filter.derivedId));
      if (filter.since) conditions.push(gt(schema.inferenceLogTable.createdAt, filter.since));
      const countRows = await tx
        .select({ total: count() })
        .from(schema.inferenceLogTable)
        .where(and(...conditions));
      const total = Number(countRows[0]?.total ?? 0);
      const rows = await tx
        .select()
        .from(schema.inferenceLogTable)
        .where(and(...conditions))
        .orderBy(desc(schema.inferenceLogTable.createdAt))
        .limit(limit)
        .offset(offset);
      const items = rows.map(inferenceRowToDomain);
      return { items, total, offset, limit, hasMore: offset + items.length < total };
    });
  }
}
