import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import type { DrizzleClient } from "./types.js";
import type { GetHealthSnapshotInput, HealthSnapshot, HealthSnapshotDay } from "@mnemo-ai/types";
import { tallyHealthSnapshots } from "@mnemo-ai/types";

type HealthTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

/**
 * HealthRepository — memory-drift snapshot (`mnemo_health`).
 *
 * flatten-legacy-dual-core Phase 9 (task 9.1, Requirement 4): ported 1:1 from
 * the legacy `packages/core/src/health/{index,compute}.ts` (raw SQL against
 * `Tx`/`withMnemoTx`) onto the v3 `StorageAdapter` port, same pattern PR6
 * established for `getWorkspaceVitals`/`getAuditFeed` (FactRepository) —
 * `this.db.transaction(...)` + `mnemo_set_workspace($id)` instead of
 * `withMnemoTx`. Every query below is byte-identical to the legacy
 * `compute.ts`/`index.ts` implementation; only the transaction/role wiring
 * differs (the adapter-postgres connection role already carries
 * `mnemo_app_role`, so no `SET LOCAL ROLE` downgrade is needed — see
 * `mnemo_set_workspace()`'s definition, migration 0001).
 *
 * `mnemo_extraction_job` is queried UNQUALIFIED (no `mnemosyne.` prefix) on
 * purpose: that table lives in the legacy `public` schema (created by
 * `packages/core/migrations/0017_mnemosyne_init.sql`, never migrated into
 * `mnemosyne`), reached via this connection's `search_path=mnemosyne,public`
 * fallthrough (`DrizzleStorageAdapter.ts`'s `createDrizzleClient`) — the same
 * resolution the legacy code relied on. `mnemo_app_role`'s SELECT grant on it
 * comes from migration `0016_extraction_job_grant.sql` (STATS-1).
 */
export class HealthRepository {
  constructor(private readonly db: DrizzleClient) {}

  async getHealthSnapshot(input: GetHealthSnapshotInput): Promise<HealthSnapshot | null> {
    const { workspaceId, fresh } = input;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      if (fresh) {
        const snapshot = await computeSnapshot(tx, workspaceId);
        await persistSnapshot(tx, workspaceId, snapshot);
        return snapshot;
      }
      return readLatestSnapshot(tx, workspaceId);
    });
  }

  /** WorkspacePort.getHealthSnapshots: each UTC day's latest snapshot in the window. */
  async getHealthSnapshots(input: {
    workspaceId: string;
    days: number;
  }): Promise<HealthSnapshotDay[]> {
    const { workspaceId: ws, days } = input;
    const since = sql`(((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1))::timestamp AT TIME ZONE 'UTC')`;
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${ws}::uuid)`);
      return (await tx.execute(sql`
        SELECT DISTINCT ON (day)
               to_char((snapshot_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
               fact_count_active, fact_count_embedded, fact_count_unembedded,
               facts_with_zero_hits, recall_hit_rate_30d, extraction_jobs_failed_7d
        FROM mnemosyne.mnemo_health
        WHERE workspace_id = ${ws} AND snapshot_at >= ${since}
        ORDER BY day, snapshot_at DESC
      `)) as unknown as Array<Record<string, string | number | null>>;
    });
    return tallyHealthSnapshots(
      days,
      new Map(
        Array.from(rows).map((r) => [
          String(r.day),
          {
            factCountActive: toInt(r.fact_count_active),
            factCountEmbedded: toInt(r.fact_count_embedded),
            factCountUnembedded: toInt(r.fact_count_unembedded),
            factsWithZeroHits: toInt(r.facts_with_zero_hits),
            recallHitRate30d: r.recall_hit_rate_30d == null ? null : Number(r.recall_hit_rate_30d),
            extractionJobsFailed7d: toInt(r.extraction_jobs_failed_7d),
          },
        ])
      )
    );
  }
}

// ── internal helpers ──────────────────────────────────────────────────────

/** Postgres `COUNT(*)` returns bigint → drizzle returns string in some
 * configs, number in others. Normalise. */
function toInt(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number.parseInt(v, 10) : Math.trunc(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute a fresh snapshot from the live tables — byte-identical query set
 * to legacy `computeHealthSnapshot` (packages/core/src/health/compute.ts).
 */
async function computeSnapshot(tx: HealthTx, workspaceId: string): Promise<HealthSnapshot> {
  const start = Date.now();

  const factRows = (await tx.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')                                        AS active,
      COUNT(*) FILTER (WHERE status = 'forgotten' OR status = 'merged')                AS archived,
      COUNT(*) FILTER (WHERE status = 'active' AND embedding IS NOT NULL)              AS embedded,
      COUNT(*) FILTER (WHERE status = 'active' AND embedding IS NULL)                  AS unembedded,
      COUNT(*) FILTER (WHERE status = 'active' AND hit_count = 0)                      AS zero_hits,
      COUNT(*) FILTER (WHERE status = 'active' AND last_recalled_at IS NOT NULL
                              AND last_recalled_at > now() - interval '30 days')       AS recalled_30d
    FROM mnemosyne.mnemo_fact
    WHERE workspace_id = ${workspaceId}
  `)) as unknown as Array<{
    active: string | number;
    archived: string | number;
    embedded: string | number;
    unembedded: string | number;
    zero_hits: string | number;
    recalled_30d: string | number;
  }>;
  const fact = factRows[0] ?? {
    active: 0,
    archived: 0,
    embedded: 0,
    unembedded: 0,
    zero_hits: 0,
    recalled_30d: 0,
  };
  const factCountActive = toInt(fact.active);
  const factCountArchived = toInt(fact.archived);
  const factCountEmbedded = toInt(fact.embedded);
  const factCountUnembedded = toInt(fact.unembedded);
  const factsWithZeroHits = toInt(fact.zero_hits);
  const recalled30d = toInt(fact.recalled_30d);

  // Hit-rate is meaningless when there are no active facts to recall;
  // surface null so the dashboard can render "no data yet" rather than
  // "0% (alarming!)".
  const recallHitRate30d = factCountActive > 0 ? recalled30d / factCountActive : null;

  const decisionRows = (await tx.execute(sql`
    SELECT COUNT(*) AS c
    FROM mnemosyne.mnemo_decision
    WHERE workspace_id = ${workspaceId} AND status = 'active'
  `)) as unknown as Array<{ c: string | number }>;
  const decisionCountActive = toInt(decisionRows[0]?.c ?? 0);

  const relationRows = (await tx.execute(sql`
    SELECT COUNT(*) AS c
    FROM mnemosyne.mnemo_relation
    WHERE workspace_id = ${workspaceId} AND relation = 'conflicts_with'
  `)) as unknown as Array<{ c: string | number }>;
  const relationCountConflicts = toInt(relationRows[0]?.c ?? 0);

  // mnemo_extraction_job — unqualified, see file header for the schema-
  // resolution rationale.
  const jobRows = (await tx.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE state = 'failed'
                         AND created_at > now() - interval '7 days')      AS failed_7d,
      COUNT(*) FILTER (WHERE state = 'deferred_provider_outage')          AS deferred
    FROM mnemo_extraction_job
    WHERE workspace_id = ${workspaceId}
  `)) as unknown as Array<{ failed_7d: string | number; deferred: string | number }>;
  const extractionJobsFailed7d = toInt(jobRows[0]?.failed_7d ?? 0);
  const extractionJobsDeferred = toInt(jobRows[0]?.deferred ?? 0);

  return {
    workspaceId,
    snapshotAt: new Date(),
    factCountActive,
    factCountArchived,
    factCountEmbedded,
    factCountUnembedded,
    decisionCountActive,
    relationCountConflicts,
    factsWithZeroHits,
    recallHitRate30d,
    extractionJobsFailed7d,
    extractionJobsDeferred,
    computedInMs: Date.now() - start,
  };
}

/**
 * Insert a single `mnemo_health` row. Each snapshot is append-only — we
 * don't upsert by (workspace_id, day) because the dashboard wants the full
 * timeseries, including any ad-hoc on-demand recomputes triggered by an
 * operator. Byte-identical to legacy `persistHealthSnapshot`.
 */
async function persistSnapshot(
  tx: HealthTx,
  workspaceId: string,
  snapshot: HealthSnapshot
): Promise<void> {
  const id = `mh_${createId()}`;
  await tx.execute(sql`
    INSERT INTO mnemosyne.mnemo_health (
      id, workspace_id, snapshot_at,
      fact_count_active, fact_count_archived, fact_count_embedded, fact_count_unembedded,
      decision_count_active, relation_count_conflicts, facts_with_zero_hits,
      recall_hit_rate_30d, extraction_jobs_failed_7d, extraction_jobs_deferred, computed_in_ms
    ) VALUES (
      ${id}, ${workspaceId}, ${snapshot.snapshotAt.toISOString()}::timestamptz,
      ${snapshot.factCountActive}, ${snapshot.factCountArchived},
      ${snapshot.factCountEmbedded}, ${snapshot.factCountUnembedded},
      ${snapshot.decisionCountActive}, ${snapshot.relationCountConflicts},
      ${snapshot.factsWithZeroHits},
      ${snapshot.recallHitRate30d === null ? null : snapshot.recallHitRate30d.toFixed(3)},
      ${snapshot.extractionJobsFailed7d}, ${snapshot.extractionJobsDeferred},
      ${snapshot.computedInMs}
    )
  `);
}

/**
 * Read the most recent row for the workspace, or `null` when none exist.
 * Byte-identical to legacy `readLatestSnapshot`.
 */
async function readLatestSnapshot(
  tx: HealthTx,
  workspaceId: string
): Promise<HealthSnapshot | null> {
  const rows = (await tx.execute(sql`
    SELECT
      workspace_id, snapshot_at,
      fact_count_active, fact_count_archived, fact_count_embedded, fact_count_unembedded,
      decision_count_active, relation_count_conflicts, facts_with_zero_hits,
      recall_hit_rate_30d, extraction_jobs_failed_7d, extraction_jobs_deferred, computed_in_ms
    FROM mnemosyne.mnemo_health
    WHERE workspace_id = ${workspaceId}
    ORDER BY snapshot_at DESC
    LIMIT 1
  `)) as unknown as Array<{
    workspace_id: string;
    snapshot_at: Date | string;
    fact_count_active: number;
    fact_count_archived: number;
    fact_count_embedded: number;
    fact_count_unembedded: number;
    decision_count_active: number;
    relation_count_conflicts: number;
    facts_with_zero_hits: number;
    recall_hit_rate_30d: string | null;
    extraction_jobs_failed_7d: number;
    extraction_jobs_deferred: number;
    computed_in_ms: number;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    workspaceId: r.workspace_id,
    snapshotAt: r.snapshot_at instanceof Date ? r.snapshot_at : new Date(r.snapshot_at),
    factCountActive: r.fact_count_active,
    factCountArchived: r.fact_count_archived,
    factCountEmbedded: r.fact_count_embedded,
    factCountUnembedded: r.fact_count_unembedded,
    decisionCountActive: r.decision_count_active,
    relationCountConflicts: r.relation_count_conflicts,
    factsWithZeroHits: r.facts_with_zero_hits,
    recallHitRate30d: r.recall_hit_rate_30d === null ? null : Number(r.recall_hit_rate_30d),
    extractionJobsFailed7d: r.extraction_jobs_failed_7d,
    extractionJobsDeferred: r.extraction_jobs_deferred,
    computedInMs: r.computed_in_ms,
  };
}
