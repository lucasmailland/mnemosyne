import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DrizzleClient } from './types.js';
import { withMaintenanceBudget } from '../pg-timeouts.js';
import type {
  ConfidenceMapRow, KnowledgeGapRow, MetacognitionTrends,
  SequentialPatternRow, PeriodicPatternRow, ConditionalPatternRow, CoOccurrencePatternRow,
} from '@mnemo-ai/types';

export class AnalyticsRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient,
  ) {}

  async getConfidenceMap(workspaceId: string, opts?: { limit?: number }): Promise<ConfidenceMapRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const limit = Math.min(opts?.limit ?? 500, 5000);
      const rows = (await tx.execute(sql`
        SELECT * FROM mnemosyne.mv_confidence_map
        WHERE workspace_id = ${workspaceId}
        ORDER BY fact_count DESC
        LIMIT ${limit}
      `)) as unknown as Array<{
        workspace_id: string; entity_id: string; canonical_name: string; kind: string;
        fact_count: number; avg_worth: string; avg_confidence: string; evidence_volume: string;
        distinct_attributions: number; pinned_count: number; low_strength_count: number;
        last_updated_at: Date; coverage_level: string; freshness: string;
      }>;
      return Array.from(rows).map((r) => ({
        workspaceId: r.workspace_id,
        entityId: r.entity_id,
        canonicalName: r.canonical_name,
        kind: r.kind,
        factCount: Number(r.fact_count),
        avgConfidence: parseFloat(r.avg_confidence),
        coverageLevel: r.coverage_level as ConfidenceMapRow["coverageLevel"],
        freshness: r.freshness as ConfidenceMapRow["freshness"],
        topicKey: r.canonical_name,
        memoryCount: Number(r.fact_count),
        avgWorth: parseFloat(r.avg_worth),
        evidenceVolume: parseFloat(r.evidence_volume),
        distinctAttributions: Number(r.distinct_attributions),
        pinnedCount: Number(r.pinned_count),
        lowStrengthCount: Number(r.low_strength_count),
        lastUpdatedAt: r.last_updated_at,
      }));
    });
  }

  async getKnowledgeGaps(workspaceId: string, opts?: { limit?: number; minScore?: number }): Promise<KnowledgeGapRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const limit = Math.min(opts?.limit ?? 100, 1000);
      const minScore = opts?.minScore ?? 0;
      const rows = (await tx.execute(sql`
        SELECT * FROM mnemosyne.mv_knowledge_gaps
        WHERE workspace_id = ${workspaceId}
          AND gap_score >= ${minScore}
        ORDER BY gap_score DESC
        LIMIT ${limit}
      `)) as unknown as Array<{
        workspace_id: string; topic_key: string;
        avg_worth: string; evidence_volume: string;
        memory_count: number; recall_hits_30d: number;
        gap_score: string;
      }>;
      return Array.from(rows).map((r) => ({
        workspaceId: r.workspace_id,
        topicKey: r.topic_key,
        avgWorth: parseFloat(r.avg_worth),
        evidenceVolume: parseFloat(r.evidence_volume),
        memoryCount: Number(r.memory_count),
        recallHits30d: Number(r.recall_hits_30d),
        gapScore: parseFloat(r.gap_score),
      }));
    });
  }

  async getMetacognitionTrends(workspaceId: string): Promise<MetacognitionTrends> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = (await tx.execute(sql`
        SELECT * FROM mnemosyne.mnemo_metacognition_trends(${workspaceId}::uuid)
      `)) as unknown as Array<{
        recall_hit_rate_cur: string; recall_hit_rate_prev: string;
        avg_recall_latency_cur: string; avg_recall_latency_prev: string;
        session_collapse_qual_cur: string; session_collapse_qual_prev: string;
        strategy_success_rate_cur: string; strategy_success_rate_prev: string;
      }>;
      const r = Array.from(rows)[0] ?? {
        recall_hit_rate_cur: "0", recall_hit_rate_prev: "0",
        avg_recall_latency_cur: "0", avg_recall_latency_prev: "0",
        session_collapse_qual_cur: "0", session_collapse_qual_prev: "0",
        strategy_success_rate_cur: "0", strategy_success_rate_prev: "0",
      };
      const pair = (cur: string, prev: string) => {
        const c = parseFloat(cur), p = parseFloat(prev);
        return { current: c, previous: p, delta: Number((c - p).toFixed(4)) };
      };
      return {
        recallHitRate: pair(r.recall_hit_rate_cur, r.recall_hit_rate_prev),
        avgRecallLatency: pair(r.avg_recall_latency_cur, r.avg_recall_latency_prev),
        sessionCollapseQuality: pair(r.session_collapse_qual_cur, r.session_collapse_qual_prev),
        strategySuccessRate: pair(r.strategy_success_rate_cur, r.strategy_success_rate_prev),
      };
    });
  }

  async refreshMetacognitionViews(): Promise<void> {
    // Calls REFRESH MATERIALIZED VIEW CONCURRENTLY via the SECURITY DEFINER fn.
    // Do NOT call from withMnemoTx (no workspace scope: it refreshes every
    // workspace's rows). PG-TIMEOUTS: a whole-database refresh can outlast the
    // request-sized statement_timeout, so it runs under the maintenance budget.
    await withMaintenanceBudget(this.db, (tx) =>
      tx.execute(sql`SELECT mnemosyne.mnemo_refresh_metacognition()`)
    );
  }

  // ── Anticipation (Wave G) ─────────────────────────────────────────────────

  async getSequentialPatterns(args: {
    workspaceId: string;
    predecessorId?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<SequentialPatternRow[]> {
    const limit = Math.min(args.limit ?? 200, 2000);
    const minConfidence = args.minConfidence ?? 0;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${args.workspaceId}::uuid)`);
      const conditions: SQL[] = [sql`workspace_id = ${args.workspaceId}::uuid`];
      if (args.predecessorId) conditions.push(sql`predecessor_id = ${args.predecessorId}`);
      if (minConfidence > 0) conditions.push(sql`confidence >= ${minConfidence}`);
      const rows = (await tx.execute(sql`
        SELECT workspace_id, predecessor_id, successor_id, support, avg_lag_seconds, confidence
        FROM mnemosyne.mv_sequential_patterns
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY confidence DESC, support DESC
        LIMIT ${limit}
      `)) as unknown as Array<{
        workspace_id: string;
        predecessor_id: string;
        successor_id: string;
        support: number;
        avg_lag_seconds: number;
        confidence: string;
      }>;
      return Array.from(rows).map((r) => ({
        workspaceId: r.workspace_id,
        predecessorId: r.predecessor_id,
        successorId: r.successor_id,
        support: Number(r.support),
        avgLagSeconds: Number(r.avg_lag_seconds),
        confidence: parseFloat(r.confidence),
      }));
    });
  }

  async getPeriodicPatterns(args: {
    workspaceId: string;
    dayOfWeek?: number;
    hourBucket?: number;
    limit?: number;
  }): Promise<PeriodicPatternRow[]> {
    const limit = Math.min(args.limit ?? 200, 2000);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${args.workspaceId}::uuid)`);
      const conditions: SQL[] = [sql`workspace_id = ${args.workspaceId}::uuid`];
      if (args.dayOfWeek !== undefined) conditions.push(sql`day_of_week = ${args.dayOfWeek}`);
      if (args.hourBucket !== undefined) conditions.push(sql`hour_bucket = ${args.hourBucket}`);
      const rows = (await tx.execute(sql`
        SELECT workspace_id, memory_id, day_of_week, hour_bucket, slot_recalls, distinct_weeks, slot_share
        FROM mnemosyne.mv_periodic_patterns
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY slot_share DESC, distinct_weeks DESC
        LIMIT ${limit}
      `)) as unknown as Array<{
        workspace_id: string;
        memory_id: string;
        day_of_week: number;
        hour_bucket: number;
        slot_recalls: number;
        distinct_weeks: number;
        slot_share: string;
      }>;
      return Array.from(rows).map((r) => ({
        workspaceId: r.workspace_id,
        memoryId: r.memory_id,
        dayOfWeek: Number(r.day_of_week),
        hourBucket: Number(r.hour_bucket),
        slotRecalls: Number(r.slot_recalls),
        distinctWeeks: Number(r.distinct_weeks),
        slotShare: parseFloat(r.slot_share),
      }));
    });
  }

  async refreshAnticipationViews(): Promise<void> {
    // Calls REFRESH MATERIALIZED VIEW CONCURRENTLY via the SECURITY DEFINER fn.
    // Do NOT call from withMnemoTx (no workspace scope). PG-TIMEOUTS: runs
    // under the maintenance budget, like refreshMetacognitionViews.
    await withMaintenanceBudget(this.db, (tx) =>
      tx.execute(sql`SELECT mnemosyne.mnemo_refresh_anticipation()`)
    );
  }

  async getConditionalPatterns(args: {
    workspaceId: string;
    queryKey?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<ConditionalPatternRow[]> {
    const limit = Math.min(args.limit ?? 200, 2000);
    const minConfidence = args.minConfidence ?? 0;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${args.workspaceId}::uuid)`);
      const conditions: SQL[] = [sql`workspace_id = ${args.workspaceId}::uuid`];
      if (args.queryKey) conditions.push(sql`query_key = lower(btrim(${args.queryKey}))`);
      if (minConfidence > 0) conditions.push(sql`confidence >= ${minConfidence}`);
      const rows = (await tx.execute(sql`
        SELECT workspace_id, query_key, fact_id, co_returns, query_total, confidence
        FROM mnemosyne.mv_conditional_patterns
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY confidence DESC, co_returns DESC
        LIMIT ${limit}
      `)) as unknown as Array<{
        workspace_id: string; query_key: string; fact_id: string;
        co_returns: number; query_total: number; confidence: string;
      }>;
      return Array.from(rows).map((r) => ({
        workspaceId: r.workspace_id,
        queryKey: r.query_key,
        factId: r.fact_id,
        coReturns: Number(r.co_returns),
        queryTotal: Number(r.query_total),
        confidence: parseFloat(r.confidence),
      }));
    });
  }

  async getCoOccurrencePatterns(args: {
    workspaceId: string;
    sourceId: string;
    minCoRecall?: number;
    limit?: number;
  }): Promise<CoOccurrencePatternRow[]> {
    const limit = Math.min(args.limit ?? 50, 500);
    const minCoRecall = args.minCoRecall ?? 2;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${args.workspaceId}::uuid)`);
      // mnemo_relation.workspace_id is TEXT (not UUID) — no ::uuid cast here.
      const rows = (await tx.execute(sql`
        SELECT
          CASE WHEN source_id = ${args.sourceId} THEN target_id ELSE source_id END AS partner_id,
          co_recall_count,
          hebbian_weight
        FROM mnemosyne.mnemo_relation
        WHERE workspace_id = ${args.workspaceId}
          AND (source_id = ${args.sourceId} OR target_id = ${args.sourceId})
          AND co_recall_count >= ${minCoRecall}
          AND valid_to IS NULL
        ORDER BY co_recall_count DESC, hebbian_weight DESC
        LIMIT ${limit}
      `)) as unknown as Array<{ partner_id: string; co_recall_count: number; hebbian_weight: number }>;
      return Array.from(rows).map((r) => ({
        workspaceId: args.workspaceId,
        sourceId: args.sourceId,
        partnerId: r.partner_id,
        coRecallCount: Number(r.co_recall_count),
        hebbianWeight: Number(r.hebbian_weight),
      }));
    });
  }
}
