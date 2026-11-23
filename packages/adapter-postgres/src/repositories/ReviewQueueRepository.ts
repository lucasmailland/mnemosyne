import { eq, and, isNull, sql, desc } from "drizzle-orm";
import * as schema from "../schema/index.js";
import type { DrizzleClient } from "./types.js";
import type {
  ActiveLearningReviewFilter,
  ActiveLearningReviewRow,
  EnqueueActiveLearningReviewInput,
  EnqueueActiveLearningReviewResult,
  ResolveActiveLearningReviewInput,
  ResolveActiveLearningReviewResult,
} from "@mnemo-ai/types";

/**
 * flatten-legacy-dual-core Slice 3c pt.1 (PR10) — active-learning review
 * queue (Mnemosyne v1.3+, `mnemo_review_queue`). Ported 1:1 from the legacy
 * `CoreLike.{listReview,reviewCount,resolveReview,enqueueReview}` /
 * `packages/core/src/review/queue.ts` implementation against the SAME
 * physical table (already reconciled to this exact column shape by
 * flatten-legacy-dual-core PR3 — see `schema/infrastructure.ts`'s
 * `reviewQueueTable`).
 *
 * Distinct from `RecallRepository.enqueueReviewItem`/`queryDriftCandidates`
 * (Wave Y §25.1), which target the UNRELATED `mnemo_review_item` table
 * (codebase/config-drift review, not this active-learning triage queue).
 */
export class ReviewQueueRepository {
  constructor(private readonly db: DrizzleClient) {}

  private mapRow(row: typeof schema.reviewQueueTable.$inferSelect): ActiveLearningReviewRow {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      factId: row.factId ?? null,
      decisionId: row.decisionId ?? null,
      reason: row.reason as ActiveLearningReviewRow["reason"],
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt ?? null,
      resolvedBy: row.resolvedBy ?? null,
      resolution: (row.resolution as ActiveLearningReviewRow["resolution"]) ?? null,
    };
  }

  async listActiveLearningReview(
    filter: ActiveLearningReviewFilter
  ): Promise<ActiveLearningReviewRow[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);
      const conditions = [eq(schema.reviewQueueTable.workspaceId, filter.workspaceId)];
      if (!filter.includeResolved) conditions.push(isNull(schema.reviewQueueTable.resolvedAt));
      if (filter.reason) conditions.push(eq(schema.reviewQueueTable.reason, filter.reason));

      const rows = await tx
        .select()
        .from(schema.reviewQueueTable)
        .where(and(...conditions))
        .orderBy(desc(schema.reviewQueueTable.createdAt))
        .limit(limit);
      return rows.map((r) => this.mapRow(r));
    });
  }

  async countUnresolvedActiveLearningReview(workspaceId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(schema.reviewQueueTable)
        .where(
          and(
            eq(schema.reviewQueueTable.workspaceId, workspaceId),
            isNull(schema.reviewQueueTable.resolvedAt)
          )
        );
      return rows[0]?.n ?? 0;
    });
  }

  async enqueueActiveLearningReview(
    input: EnqueueActiveLearningReviewInput
  ): Promise<EnqueueActiveLearningReviewResult> {
    if ((input.factId == null) === (input.decisionId == null)) {
      throw new Error(
        "enqueueActiveLearningReview: exactly one of factId or decisionId must be supplied"
      );
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      // Suppression read: an already-open row targeting the same source
      // short-circuits to a dedup hit (mirrors legacy's partial-index dedup).
      const suppressionWhere =
        input.factId != null
          ? and(
              eq(schema.reviewQueueTable.workspaceId, input.workspaceId),
              eq(schema.reviewQueueTable.factId, input.factId),
              isNull(schema.reviewQueueTable.resolvedAt)
            )
          : and(
              eq(schema.reviewQueueTable.workspaceId, input.workspaceId),
              eq(schema.reviewQueueTable.decisionId, input.decisionId!),
              isNull(schema.reviewQueueTable.resolvedAt)
            );

      const existing = await tx
        .select({ id: schema.reviewQueueTable.id })
        .from(schema.reviewQueueTable)
        .where(suppressionWhere)
        .limit(1);
      const prev = existing[0];
      if (prev) return { id: prev.id, inserted: false };

      const id = `mrev_${crypto.randomUUID()}`;
      await tx.insert(schema.reviewQueueTable).values({
        id,
        workspaceId: input.workspaceId,
        factId: input.factId ?? null,
        decisionId: input.decisionId ?? null,
        reason: input.reason,
      });
      return { id, inserted: true };
    });
  }

  async resolveActiveLearningReview(
    input: ResolveActiveLearningReviewInput
  ): Promise<ResolveActiveLearningReviewResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

      // Single UPDATE ... WHERE resolved_at IS NULL gives atomic idempotency:
      // a second resolver sees 0 rows and we report resolved:false.
      const updated = await tx
        .update(schema.reviewQueueTable)
        .set({
          resolvedAt: new Date(),
          resolvedBy: input.resolvedBy,
          resolution: input.resolution,
        })
        .where(
          and(
            eq(schema.reviewQueueTable.id, input.reviewId),
            eq(schema.reviewQueueTable.workspaceId, input.workspaceId),
            isNull(schema.reviewQueueTable.resolvedAt)
          )
        )
        .returning();

      const row = updated[0];
      if (!row) {
        // Disambiguate "already resolved" vs "never existed" for the caller.
        const lookup = await tx
          .select({
            factId: schema.reviewQueueTable.factId,
            decisionId: schema.reviewQueueTable.decisionId,
          })
          .from(schema.reviewQueueTable)
          .where(
            and(
              eq(schema.reviewQueueTable.id, input.reviewId),
              eq(schema.reviewQueueTable.workspaceId, input.workspaceId)
            )
          )
          .limit(1);
        return {
          resolved: false,
          factId: lookup[0]?.factId ?? null,
          decisionId: lookup[0]?.decisionId ?? null,
          cascaded: false,
        };
      }

      let cascaded = false;
      // B6.35 (mirrors legacy factory.ts.resolveReview): 'forgotten' cascades
      // atomically in the SAME tx, but never mid-consolidation.
      if (input.resolution === "forgotten" && row.factId) {
        const cascadeResult = await tx
          .update(schema.factTable)
          .set({ status: "forgotten", updatedAt: new Date() })
          .where(
            and(
              eq(schema.factTable.id, row.factId),
              eq(schema.factTable.workspaceId, input.workspaceId),
              sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
            )
          )
          .returning({ id: schema.factTable.id });
        cascaded = cascadeResult.length > 0;
      }

      return {
        resolved: true,
        factId: row.factId ?? null,
        decisionId: row.decisionId ?? null,
        cascaded,
      };
    });
  }
}
