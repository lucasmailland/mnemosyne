import { sql } from "drizzle-orm";
import type { DrizzleClient } from "./types.js";

export class MeteringRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  // ── §35 Durable metering — F15 (mnemo_meter_event) ───────────────────────────

  /**
   * Durably append one meter event. Idempotent via the UNIQUE idempotency_key
   * constraint: a duplicate (retry / cross-replica) is dropped silently.
   * Runs inside a workspace-scoped tx so RLS fires with the right context.
   */
  async appendMeterEvent(event: {
    workspaceId: string;
    metric: string;
    quantity: number;
    occurredAt: Date;
    costUsd: number;
    idempotencyKey: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${event.workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_meter_event
          (workspace_id, operation, units, cost_usd, occurred_at, idempotency_key)
        VALUES (
          ${event.workspaceId}::uuid,
          ${event.metric},
          ${event.quantity},
          ${event.costUsd},
          ${event.occurredAt.toISOString()}::timestamptz,
          ${event.idempotencyKey}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `);
    });
  }

  /**
   * SUM(cost_usd) for the current calendar month (UTC). Returns 0 when empty.
   * NUMERIC comes back as a string from postgres-js, so coerce with parseFloat.
   */
  async getWorkspaceMonthlySpendUsd(workspaceId: string): Promise<number> {
    const rows = await this.db.execute<{ spend: string | null }>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS spend
      FROM mnemosyne.mnemo_meter_event
      WHERE workspace_id = ${workspaceId}::uuid
        AND occurred_at >= date_trunc('month', now())
    `);
    const raw = (rows as Array<{ spend: string | null }>)[0]?.spend;
    const n = raw == null ? 0 : parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * P111 — SUM(units) for the `embedding` metric since `since`.
   *
   * The port declared this optional and no adapter implemented it, so
   * `metrics/cost.ts` took its `?? Promise.resolve(0)` branch on every request
   * and the cost dashboard reported zero embedding usage regardless of what the
   * meter actually held. The rows were being written the whole time by
   * appendMeterEvent; only the read-back was missing.
   */
  async getWorkspaceEmbeddingTokenUsage(workspaceId: string, since: Date): Promise<number> {
    return this.sumMeterUnits(workspaceId, "embedding", since);
  }

  /**
   * P111 — SUM(units) for the `recall` metric in the current calendar month
   * (UTC), matching getWorkspaceMonthlySpendUsd's window. Same story as above:
   * GET /health/cognitive degraded to 0 because nothing implemented the read.
   */
  async getWorkspaceMonthlyRecallCount(workspaceId: string): Promise<number> {
    const rows = await this.db.execute<{ units: string | null }>(sql`
      SELECT COALESCE(SUM(units), 0)::text AS units
      FROM mnemosyne.mnemo_meter_event
      WHERE workspace_id = ${workspaceId}::uuid
        AND operation = 'recall'
        AND occurred_at >= date_trunc('month', now())
    `);
    return MeteringRepository.toFiniteNumber((rows as Array<{ units: string | null }>)[0]?.units);
  }

  /** Shared SUM(units) over one metric since a point in time. */
  private async sumMeterUnits(
    workspaceId: string,
    operation: string,
    since: Date
  ): Promise<number> {
    const rows = await this.db.execute<{ units: string | null }>(sql`
      SELECT COALESCE(SUM(units), 0)::text AS units
      FROM mnemosyne.mnemo_meter_event
      WHERE workspace_id = ${workspaceId}::uuid
        AND operation = ${operation}
        AND occurred_at >= ${since.toISOString()}::timestamptz
    `);
    return MeteringRepository.toFiniteNumber((rows as Array<{ units: string | null }>)[0]?.units);
  }

  /** NUMERIC arrives as a string from postgres-js; never propagate NaN. */
  private static toFiniteNumber(raw: string | null | undefined): number {
    const n = raw == null ? 0 : parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Month-to-date usage per metric, summed from the durable table. Keys are
   * MeterMetric strings; missing metrics are absent (callers default to 0).
   */
  async getMonthToDateUsageFromDb(workspaceId: string): Promise<Record<string, number>> {
    // mnemo_meter_event is FORCE RLS on the workspace GUC: without it, under the app role the
    // read saw no rows (or threw on an empty GUC) and GET /usage fell back to the in-process
    // accumulator, which a restart empties. Same transaction shape as appendMeterEvent.
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx.execute<{ operation: string; units: string | null }>(sql`
        SELECT operation, COALESCE(SUM(units), 0)::text AS units
        FROM mnemosyne.mnemo_meter_event
        WHERE workspace_id = ${workspaceId}::uuid
          AND occurred_at >= date_trunc('month', now())
        GROUP BY operation
      `);
    });
    const out: Record<string, number> = {};
    for (const r of rows as Array<{ operation: string; units: string | null }>) {
      const v = r.units == null ? 0 : parseFloat(r.units);
      out[r.operation] = Number.isFinite(v) ? v : 0;
    }
    return out;
  }

  // ── §14 A/B scoring — mean outcome score for a specific prompt version ────────

  async computeCandidateAbScore(
    workspaceId: string,
    agentId: string,
    promptVersionId: string
  ): Promise<number | null> {
    const rows = await this.db.execute<{
      outcome_rating: string | null;
    }>(sql`
      SELECT outcome_rating
      FROM mnemosyne.mnemo_session
      WHERE workspace_id = ${workspaceId}
        AND outcome_rating IS NOT NULL
        AND active_prompt_version_id = ${promptVersionId}
        ${agentId !== "*" ? sql`AND agent_id = ${agentId}` : sql``}
    `);
    if (rows.length === 0) return null;
    const sum = rows.reduce((acc, r) => {
      const s = r.outcome_rating === "success" ? 1.0 : r.outcome_rating === "failure" ? 0.0 : 0.5;
      return acc + s;
    }, 0);
    return sum / rows.length;
  }

  // ── T4 stale-task cron — list tasks not updated within staleSinceMs ─────────

  async listStaleTasks(
    workspaceId: string,
    staleSinceMs: number,
    limit: number
  ): Promise<Array<{ id: string; title: string; status: string; updatedAt: Date }>> {
    const rows = await this.db.execute<{
      id: string;
      title: string;
      status: string;
      updated_at: Date;
    }>(sql`
      SELECT id, title, status, updated_at
      FROM mnemosyne.mnemo_task
      WHERE workspace_id = ${workspaceId}
        AND status NOT IN ('done', 'cancelled', 'archived')
        AND updated_at < NOW() - (${staleSinceMs} * INTERVAL '1 millisecond')
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: new Date(r.updated_at),
    }));
  }

  // ── §3.5 snapshot count methods — called on Prometheus scrape (~15s) ─────────

  async countFactsByTypeStatus(): Promise<Array<{ type: string; status: string; count: number }>> {
    const rows = await this.db.execute<{ type: string; status: string; count: number }>(
      sql`SELECT kind AS type, status, COUNT(*)::int AS count
          FROM mnemosyne.mnemo_fact
          WHERE status != 'forgotten'
          GROUP BY kind, status`
    );
    return rows.map((r) => ({ type: r.type, status: r.status, count: Number(r.count) }));
  }

  async worthHistogram(): Promise<Array<{ bucket: string; count: number }>> {
    const rows = await this.db.execute<{ bucket: string; count: number }>(
      sql`SELECT
            CASE
              WHEN worth < 0.2 THEN '0.0-0.2'
              WHEN worth < 0.4 THEN '0.2-0.4'
              WHEN worth < 0.6 THEN '0.4-0.6'
              WHEN worth < 0.8 THEN '0.6-0.8'
              ELSE '0.8-1.0'
            END AS bucket,
            COUNT(*)::int AS count
          FROM mnemosyne.mnemo_fact
          WHERE status != 'forgotten' AND worth IS NOT NULL
          GROUP BY 1`
    );
    return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
  }

  async countActiveSessions(): Promise<number> {
    const rows = await this.db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_session WHERE status = 'active'`
    );
    const row = rows[0];
    return Number(row?.count ?? 0);
  }

  async countTasksByStatus(): Promise<Array<{ status: string; count: number }>> {
    const rows = await this.db.execute<{ status: string; count: number }>(
      sql`SELECT status, COUNT(*)::int AS count
          FROM mnemosyne.mnemo_task
          GROUP BY status`
    );
    return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
  }

  async countStaleTasks(): Promise<number> {
    const staleSinceMs = 7 * 24 * 60 * 60 * 1000; // default: 7 days
    const rows = await this.db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count
          FROM mnemosyne.mnemo_task
          WHERE status NOT IN ('done', 'cancelled', 'archived')
            AND updated_at < NOW() - (${staleSinceMs} * INTERVAL '1 millisecond')`
    );
    const row = rows[0];
    return Number(row?.count ?? 0);
  }
}
