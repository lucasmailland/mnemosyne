import { setWorkspaceContext } from "./SessionRepository.js";
import {
  eq,
  and,
  ne,
  desc,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  gt,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { sameWidthAsQuery } from "./_embedding-width.js";
import { hyperedgeReadable, relationReadable } from "./GraphRepository.js";
import {
  hyperedgeRowToDomain,
  mapRowToDecision,
  mapRowToEntity,
  mapRowToEpisode,
  mapRowToEvent,
  mapRowToFact,
  mapRowToReasoning,
  mapRowToRelation,
  mapRowToSkill,
  mapRowToStrategy,
  mapRowToTask,
  mapRowToWorkflow,
} from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import {
  isOrganicRecall,
  organicRecallLogRow,
  recallHitInsertSql,
  recallRequestInsertSql,
} from "../recall-log-sql.js";
import type {
  PrimitiveKind,
  WorthDelta,
  RecallLogEntry,
  RecallRequestObservation,
  RecallHitObservation,
  DecayClass,
  MnemoFact,
  PointerCandidateQuery,
  PointerCandidate,
  FtsCandidate,
  PrimitiveCandidate,
  PrimitiveCandidateQuery,
  FederatedRecallCandidate,
  FederatedRecallQuery,
  Sensitivity,
  Provenance,
  RecallPrimitiveRef,
  RecallPrimitiveRecord,
  RecallLogRecord,
  RecallStructures,
  RecallPrecisionAtK,
  RecallPrecisionReport,
  RecallMetrics,
  RecallMetricsWindow,
  FactStats,
} from "@mnemo-ai/types";
import {
  applyDelta,
  RECALL_PRECISION_METHODOLOGY_NOTE,
  scopeRefValues,
  tiersAtOrBelow,
} from "@mnemo-ai/types";
import {
  ftsConfig,
  ftsConfigEs,
  ftsMatchesEither,
  ftsRankEither,
  ftsTermLexemes,
} from "./_fts-config.js";

const RECALL_STOPWORDS = new Set([
  "a",
  "al",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "como",
  "con",
  "de",
  "del",
  "do",
  "does",
  "el",
  "en",
  "es",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "la",
  "las",
  "lo",
  "los",
  "of",
  "on",
  "or",
  "por",
  "que",
  "se",
  "the",
  "to",
  "un",
  "una",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "y",
]);

/** Content lexemes for the recall-only fallback; shared FTS matching stays strict. */
export function recallContentTerms(terms: string[]): string[] {
  const normalized = terms
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return [
    ...new Set(
      (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !RECALL_STOPWORDS.has(term))
    ),
  ];
}

/**
 * P65 — the non-fact recallable kinds, where their rows live, and what "still
 * counts" means for each.
 *
 * `recallableCandidates` reads this instead of naming one table. Adding a kind
 * is an entry here plus its registry entries in `@mnemo-ai/types` — and, as
 * migrations 0033/0034 showed, usually its `embedding` / `text_lemmatized`
 * columns too, which the backlog's "just a registry entry" estimate had missed.
 *
 * `live` is per-kind and NOT boilerplate. The tables genuinely disagree:
 *   - episode and skill have no `status` column at all;
 *   - event has neither `status` nor `valid_to` — it is an immutable log, so
 *     every row is live by construction;
 *   - `mnemo_task.status` is the TASK LIFECYCLE (pending|in_progress|blocked|
 *     delegated|completed|cancelled). There is no 'active' in that CHECK
 *     constraint, so the copy-pasted `status = 'active'` would have matched
 *     nothing and tasks would have been silently unrecallable — indexed,
 *     wired, and returning zero rows forever;
 *   - `mnemo_reasoning.status` includes 'golden', its CURATED-HIGH-VALUE state.
 *     Filtering to 'active' alone would exclude precisely the reasoning most
 *     worth recalling.
 *
 * Both arms take the same `live` string, so the semantic and lexical halves can
 * never disagree about which rows exist.
 */
interface NonFactRecallSource {
  kind: string;
  /** Schema-qualified name, spliced into both arms' raw SQL. */
  sqlName: string;
  /** Liveness predicate, or null when every row qualifies. */
  live: string | null;
  /**
   * Start of a row's validity, for point-in-time recall. Default
   * `COALESCE(valid_from, created_at)`; events, which are never closed, use
   * `occurred_at` and have no end.
   */
  since?: string;
}

const NON_FACT_RECALL_SOURCES: Record<string, NonFactRecallSource> = {
  decision: {
    kind: "decision",
    sqlName: "mnemosyne.mnemo_decision",
    live: "status = 'active' AND valid_to IS NULL",
  },
  strategy: {
    kind: "strategy",
    sqlName: "mnemosyne.mnemo_strategy",
    live: "status = 'active' AND valid_to IS NULL",
  },
  workflow: {
    kind: "workflow",
    sqlName: "mnemosyne.mnemo_workflow",
    live: "status = 'active' AND valid_to IS NULL",
  },
  // No status column.
  skill: { kind: "skill", sqlName: "mnemosyne.mnemo_skill", live: "valid_to IS NULL" },
  episode: { kind: "episode", sqlName: "mnemosyne.mnemo_episode", live: "valid_to IS NULL" },
  // Lifecycle status, not validity — see the note above. A cancelled task is
  // still excluded, but by naming it, not by pretending 'active' exists.
  task: {
    kind: "task",
    sqlName: "mnemosyne.mnemo_task",
    live: "valid_to IS NULL AND status <> 'cancelled'",
  },
  // Immutable log: no status, no valid_to, nothing to filter.
  event: { kind: "event", sqlName: "mnemosyne.mnemo_event", live: null, since: "occurred_at" },
  reasoning: {
    kind: "reasoning",
    sqlName: "mnemosyne.mnemo_reasoning",
    live: "status IN ('active', 'golden') AND valid_to IS NULL",
  },
};

export class RecallRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  // ─── Worth governance (TD(λ)) ────────────────────────────────────────────────

  async updateWorth(
    id: string,
    workspaceId: string,
    primitiveKind: PrimitiveKind,
    delta: WorthDelta
  ): Promise<void> {
    const successDelta = delta.success * delta.creditWeight;
    const failureDelta = delta.failure * delta.creditWeight;

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      switch (primitiveKind) {
        case "fact": {
          // Beta-Bernoulli evidence accumulation. α (worth_alpha) tracks
          // successes, β (worth_beta) tracks failures. The generated `worth`
          // column reads them via α / (α + β). Raw counters (worth_success,
          // worth_failure) are also kept for evidence-volume signal in Wave F.
          await tx
            .update(schema.factTable)
            .set({
              worthAlpha: sql`worth_alpha + ${successDelta}`,
              worthBeta: sql`worth_beta + ${failureDelta}`,
              worthSuccess: sql`worth_success + ${successDelta}`,
              worthFailure: sql`worth_failure + ${failureDelta}`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.factTable.id, id),
                eq(schema.factTable.workspaceId, workspaceId),
                // B6.35: the four worth fields are snapshotted by an in-flight
                // consolidation merge — never mutate them on a pending fact or the
                // rollback baseline is corrupted.
                sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
              )
            );
          break;
        }

        case "strategy":
          await tx
            .update(schema.strategyTable)
            .set({
              successCount: sql`success_count + ${Math.round(successDelta)}`,
              failureCount: sql`failure_count + ${Math.round(failureDelta)}`,
              // §25.2 Beta evidence (decayed by decayKind). Full-precision deltas;
              // clamp at the (1,1) prior so evidence never drops below uniform.
              worthAlpha: sql`GREATEST(1, worth_alpha + ${successDelta})`,
              worthBeta: sql`GREATEST(1, worth_beta + ${failureDelta})`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.strategyTable.id, id),
                eq(schema.strategyTable.workspaceId, workspaceId)
              )
            );
          break;

        case "reasoning":
          await tx
            .update(schema.reasoningTable)
            .set({
              successCount: sql`success_count + ${Math.round(successDelta)}`,
              failureCount: sql`failure_count + ${Math.round(failureDelta)}`,
              worthAlpha: sql`GREATEST(1, worth_alpha + ${successDelta})`,
              worthBeta: sql`GREATEST(1, worth_beta + ${failureDelta})`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.reasoningTable.id, id),
                eq(schema.reasoningTable.workspaceId, workspaceId)
              )
            );
          break;

        case "decision":
          // decisions don't have worth counters; update confidence as proxy
          break;

        case "skill":
          await tx
            .update(schema.skillTable)
            .set({
              qualityScore: sql`LEAST(1.0, GREATEST(0.0, quality_score + ${successDelta - failureDelta}))`,
              // §25.2 Beta evidence (decayed by decayKind), parallel to quality_score.
              worthAlpha: sql`GREATEST(1, worth_alpha + ${successDelta})`,
              worthBeta: sql`GREATEST(1, worth_beta + ${failureDelta})`,
              updatedAt: new Date(),
            })
            .where(
              and(eq(schema.skillTable.id, id), eq(schema.skillTable.workspaceId, workspaceId))
            );
          break;

        case "workflow":
          await tx
            .update(schema.workflowTable)
            .set({
              successRate: sql`LEAST(1.0, GREATEST(0.0, success_rate + ${successDelta - failureDelta}))`,
              // §25.2 Beta evidence (decayed by decayKind), parallel to success_rate.
              worthAlpha: sql`GREATEST(1, worth_alpha + ${successDelta})`,
              worthBeta: sql`GREATEST(1, worth_beta + ${failureDelta})`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.workflowTable.id, id),
                eq(schema.workflowTable.workspaceId, workspaceId)
              )
            );
          break;

        case "hyperedge": {
          // TD(λ) step: ±0.1 per update, clamped to [0, 1].
          // No success/failure counters — simple additive update on the worth column.
          await tx
            .update(schema.hyperedgeTable)
            .set({
              worth: sql`LEAST(1.0, GREATEST(0.0, worth + ${(successDelta - failureDelta) * 0.1}::real))`,
            })
            .where(
              and(
                eq(schema.hyperedgeTable.id, id),
                eq(schema.hyperedgeTable.workspaceId, workspaceId)
              )
            );
          break;
        }

        // episode, entity, task, event have no worth columns — no-op
        default:
          break;
      }
    });
  }

  async recordRecall(entry: RecallLogEntry): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${entry.workspaceId}::uuid)`);
      await tx.insert(schema.recallLogTable).values({
        workspaceId: entry.workspaceId,
        factId: entry.factId,
        sessionId: entry.sessionId,
        queryText: entry.queryText,
        hitRank: entry.hitRank,
        tdCredit: entry.tdCredit?.toString(),
        activationScore: entry.activationScore?.toString(),
        latencyMs: entry.latencyMs ?? null,
      });
      // Update lastRecalledAt so the consolidation gate's 14-day recency check
      // has accurate data (spec §12 condition 3), and count the hit in the same
      // transaction as its log row (RECALL-11: hit_count stayed 0 against 12,836
      // log rows). An atomic increment, never read-modify-write.
      await tx
        .update(schema.factTable)
        .set({
          lastRecalledAt: new Date(),
          hitCount: sql`${schema.factTable.hitCount} + 1`,
        })
        .where(
          and(
            eq(schema.factTable.id, entry.factId),
            eq(schema.factTable.workspaceId, entry.workspaceId)
          )
        );
    });
  }

  async recordRecallObservation(
    request: RecallRequestObservation,
    hits: RecallHitObservation[]
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${request.workspaceId}::uuid)`);
      const inserted = await tx.execute(recallRequestInsertSql(request));
      const rows = Array.isArray(inserted) ? inserted : ((inserted as any)?.rows ?? []);
      if (rows.length === 0) return; // replayed request: no duplicate hits or increments
      const organic = isOrganicRecall(request.trafficOrigin);
      for (const hit of hits) {
        // The transaction is pinned to request.workspaceId; a foreign hit would
        // fail RLS / the request FK and abort the whole observation.
        if (hit.workspaceId !== request.workspaceId) continue;
        await tx.execute(
          recallHitInsertSql(
            hit,
            request.sessionId,
            organic,
            request.totalDurationMs,
            request.queryText ?? null
          )
        );
      }
    });
  }

  async getTdPredecessors(
    workspaceId: string,
    sessionId: string,
    excludeFactId: string
  ): Promise<Array<{ factId: string; tdCredit: number; recalledAt: Date }>> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx
        .select({
          factId: schema.recallLogTable.factId,
          tdCredit: schema.recallLogTable.tdCredit,
          recalledAt: schema.recallLogTable.recalledAt,
        })
        .from(schema.recallLogTable)
        .where(
          and(
            eq(schema.recallLogTable.workspaceId, workspaceId),
            eq(schema.recallLogTable.sessionId, sessionId),
            isNotNull(schema.recallLogTable.factId),
            or(
              isNull(schema.recallLogTable.primitiveKind),
              eq(schema.recallLogTable.primitiveKind, "fact")
            ),
            ne(schema.recallLogTable.factId, excludeFactId),
            organicRecallLogRow // synthetic/test hits never earn TD(λ) predecessor credit
          )
        )
        .orderBy(desc(schema.recallLogTable.recalledAt))
        .limit(20);
    });
    return rows
      .filter((r): r is typeof r & { factId: string } => typeof r.factId === "string")
      .map((r) => ({
        factId: r.factId,
        tdCredit: Number(r.tdCredit ?? 0),
        recalledAt:
          r.recalledAt instanceof Date ? r.recalledAt : new Date(r.recalledAt as unknown as string),
      }));
  }

  /**
   * recall-precision-report (harden-hooks-and-measure-precision, Requirement 5/6).
   *
   * "Credited" mirrors `propagateTdCredit`'s actual gating condition
   * (packages/core/src/session/collapse.ts:622, packages/core/src/cognitive/worth.ts:85-113):
   * a hit counts as credited only when (a) its session collapsed AND created at
   * least one fact (`mnemo_session.fact_count > 0` — the exact condition collapse
   * checks before calling `propagateTdCredit` at all), and (b) it falls within the
   * 20-most-recently-recalled window for that session that `getTdPredecessors`
   * actually queries (`ORDER BY recalled_at DESC ... LIMIT 20`).
   *
   * Hits whose session never collapsed (`collapsed_at IS NULL`) are excluded from
   * every denominator, never counted as failures — see design.md for why. Hits
   * with no `session_id` are excluded entirely: credit is defined per-session,
   * so a session-less recall cannot be resolved either way.
   *
   * This is a workspace-wide aggregate read: RLS scoping (`mnemo_set_workspace`)
   * plus the explicit `workspace_id` predicate on both sides of the join is
   * belt-and-suspenders against cross-workspace leakage.
   */
  async getRecallPrecision(workspaceId: string): Promise<RecallPrecisionReport> {
    const K_VALUES = [1, 3, 5] as const;
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const result = (await tx.execute(sql`
        SELECT
          COUNT(*)                                                 AS total_hits,
          COUNT(*) FILTER (WHERE NOT collapsed_flag)               AS pending_hits,
          COUNT(*) FILTER (WHERE collapsed_flag AND hit_rank < 1)  AS denom_k1,
          COUNT(*) FILTER (WHERE credited_flag  AND hit_rank < 1)  AS num_k1,
          COUNT(*) FILTER (WHERE collapsed_flag AND hit_rank < 3)  AS denom_k3,
          COUNT(*) FILTER (WHERE credited_flag  AND hit_rank < 3)  AS num_k3,
          COUNT(*) FILTER (WHERE collapsed_flag AND hit_rank < 5)  AS denom_k5,
          COUNT(*) FILTER (WHERE credited_flag  AND hit_rank < 5)  AS num_k5
        FROM (
          SELECT
            rl.hit_rank,
            (s.collapsed_at IS NOT NULL) AS collapsed_flag,
            (
              s.collapsed_at IS NOT NULL
              AND s.fact_count > 0
              AND ROW_NUMBER() OVER (
                    PARTITION BY rl.session_id ORDER BY rl.recalled_at DESC
                  ) <= 20
            ) AS credited_flag
          FROM mnemosyne.mnemo_recall_log rl
          JOIN mnemosyne.mnemo_session s
            ON s.id = rl.session_id
            -- P133: the two columns are NOT the same type. mnemo_recall_log
            -- declares workspace_id as uuid; mnemo_session (and mnemo_fact)
            -- declare it as text. Comparing them raw raises
            -- 'operator does not exist: text = uuid', so this query threw on
            -- every call it ever made, and the route's catch turned the throw
            -- into insufficientData:true -- a broken read wearing the same face
            -- as an empty one. The session-id comparison is text=text and was
            -- always fine; only the workspace one needed the cast.
            AND s.workspace_id = rl.workspace_id::text
          WHERE rl.workspace_id = ${workspaceId}::uuid
            AND rl.fact_id IS NOT NULL
            AND (rl.primitive_kind IS NULL OR rl.primitive_kind = 'fact')
            AND rl.hit_rank IS NOT NULL
            AND rl.session_id IS NOT NULL
        ) hits
      `)) as unknown as Array<Record<string, string | number | null>>;
      return result[0];
    });

    const n = (key: string): number => {
      const v = row?.[key];
      if (v === null || v === undefined) return 0;
      const parsed = typeof v === "string" ? Number.parseInt(v, 10) : Math.trunc(v);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const precisionAtK: RecallPrecisionAtK[] = K_VALUES.map((k) => {
      const sampleSize = n(`denom_k${k}`);
      const credited = n(`num_k${k}`);
      return { k, sampleSize, precision: sampleSize > 0 ? credited / sampleSize : null };
    });

    return {
      workspaceId,
      computedAt: new Date(),
      totalHits: n("total_hits"),
      pendingHits: n("pending_hits"),
      precisionAtK,
      insufficientData: precisionAtK.every((p) => p.sampleSize === 0),
      methodologyNote: RECALL_PRECISION_METHODOLOGY_NOTE,
    };
  }

  /**
   * p50/p95 of `latency_ms` over the last `days` days of recall-log rows (one row
   * per served memory; NULL latency excluded). Same uuid cast as getRecallPrecision.
   */
  /**
   * APP-015 — served context from the recall observations (request_metadata
   * servedChars) over `days`, and the size of every live plaintext fact.
   * Encrypted tiers are left out: their stored statement is ciphertext.
   */
  async getContextEconomy(
    workspaceId: string,
    days: number,
    maxSensitivity: Sensitivity
  ): Promise<{
    recalls: number;
    servedCharsAvg: number | null;
    servedCharsP95: number | null;
    liveFacts: number;
    liveFactChars: number;
  }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const served = (await tx.execute(sql`
        SELECT COUNT(*) AS recalls,
               AVG((request_metadata->>'servedChars')::numeric) AS avg,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY (request_metadata->>'servedChars')::numeric) AS p95
        FROM mnemosyne.mnemo_recall_request
        WHERE workspace_id = ${workspaceId}::uuid
          AND request_metadata ? 'servedChars'
          AND created_at >= now() - make_interval(days => ${days}::int)
      `)) as unknown as Array<{
        recalls: string | number;
        avg: string | number | null;
        p95: string | number | null;
      }>;
      const live = (await tx.execute(sql`
        SELECT COUNT(*) AS facts, COALESCE(SUM(char_length(statement)), 0) AS chars
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${workspaceId}
          AND status = 'active' AND valid_to IS NULL
          AND sensitivity IN (${sql.join(
            tiersAtOrBelow(maxSensitivity)
              .filter((s) => s === "public" || s === "internal")
              .map((s) => sql`${s}`),
            sql`, `
          )})
      `)) as unknown as Array<{ facts: string | number; chars: string | number }>;
      const num = (v: string | number | null | undefined) =>
        v === null || v === undefined ? null : Math.round(Number(v));
      return {
        recalls: Number(served[0]?.recalls ?? 0),
        servedCharsAvg: num(served[0]?.avg),
        servedCharsP95: num(served[0]?.p95),
        liveFacts: Number(live[0]?.facts ?? 0),
        liveFactChars: Number(live[0]?.chars ?? 0),
      };
    });
  }

  async getRecallLatency(
    workspaceId: string,
    days: number
  ): Promise<{ p50Ms: number | null; p95Ms: number | null; samples: number }> {
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const result = (await tx.execute(sql`
        SELECT
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
          COUNT(*)                                                 AS samples
        FROM mnemosyne.mnemo_recall_log
        WHERE workspace_id = ${workspaceId}::uuid
          AND latency_ms IS NOT NULL
          AND recalled_at >= now() - make_interval(days => ${days}::int)
      `)) as unknown as Array<{
        p50: number | string | null;
        p95: number | string | null;
        samples: number | string;
      }>;
      return result[0];
    });
    const round = (v: number | string | null | undefined): number | null =>
      v === null || v === undefined ? null : Math.round(Number(v));
    return { p50Ms: round(row?.p50), p95Ms: round(row?.p95), samples: Number(row?.samples ?? 0) };
  }

  /**
   * Recall calls per UTC day (`days` days ending today, zero-filled) and over the
   * whole window. Calls are the `recall` audit entries (the recall log has no row
   * for a call that served nothing); a numeric `resultCount` in the detail makes
   * an entry readable for the zero-hit share (a crypto-wrapped detail is a JSON
   * string). Latency is per call: the recall log's `hit_rank = 0` rows.
   */
  async getRecallMetrics(workspaceId: string, days: number): Promise<RecallMetrics> {
    const since = sql`(((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1))::timestamp AT TIME ZONE 'UTC')`;
    type Row = {
      day: string | null;
      queries: string | number;
      known: string | number;
      zero: string | number;
      p50: string | number | null;
      p95: string | number | null;
    };
    const { perDay, total } = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // GROUPING SETS ((day), ()): a row per day with data, plus the window's total (day NULL).
      const calls = (await tx.execute(sql`
        SELECT day,
               COUNT(*) AS queries,
               COUNT(*) FILTER (WHERE known) AS known,
               COUNT(*) FILTER (WHERE known AND (metadata->>'resultCount')::numeric = 0) AS zero
        FROM (
          SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
                 jsonb_typeof(metadata->'resultCount') = 'number' AS known,
                 metadata
          FROM mnemosyne.mnemo_audit_log
          WHERE workspace_id = ${workspaceId}::uuid AND action = 'recall' AND created_at >= ${since}
        ) c
        GROUP BY GROUPING SETS ((day), ())
      `)) as unknown as Array<Omit<Row, "p50" | "p95">>;
      const latency = (await tx.execute(sql`
        SELECT day,
               percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
        FROM (
          SELECT to_char((recalled_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, latency_ms
          FROM mnemosyne.mnemo_recall_log
          WHERE workspace_id = ${workspaceId}::uuid
            AND hit_rank = 0
            AND latency_ms IS NOT NULL
            AND recalled_at >= ${since}
        ) l
        GROUP BY GROUPING SETS ((day), ())
      `)) as unknown as Array<Pick<Row, "day" | "p50" | "p95">>;
      const byDay = new Map<string | null, Partial<Row>>();
      for (const r of [...calls, ...latency]) byDay.set(r.day, { ...byDay.get(r.day), ...r });
      return { perDay: byDay, total: byDay.get(null) };
    });
    const round = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
    const window = (r: Partial<Row> | undefined): RecallMetricsWindow => {
      const known = Number(r?.known ?? 0);
      return {
        queries: Number(r?.queries ?? 0),
        zeroHitShare: known > 0 ? Number(r?.zero ?? 0) / known : null,
        p50Ms: round(r?.p50),
        p95Ms: round(r?.p95),
      };
    };
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    return {
      days: Array.from({ length: days }, (_, i) => {
        const day = new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
        return { day, ...window(perDay.get(day)) };
      }),
      totals: window(total),
    };
  }

  /**
   * Live facts (`valid_to IS NULL`, `status = 'active'`) at or under the ceiling,
   * counted by kind, sensitivity and memory type. One grouped read, tallied here.
   */
  async getFactStats(input: {
    workspaceId: string;
    maxSensitivity?: Sensitivity;
  }): Promise<FactStats> {
    const ws = input.workspaceId;
    const ceiling = input.maxSensitivity
      ? sql` AND sensitivity IN (${sql.join(
          tiersAtOrBelow(input.maxSensitivity).map((t) => sql`${t}`),
          sql`, `
        )})`
      : sql``;
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${ws}::uuid)`);
      return (await tx.execute(sql`
        SELECT kind, sensitivity, memory_type,
               COUNT(*) AS n,
               COUNT(*) FILTER (WHERE pinned) AS pinned,
               COUNT(*) FILTER (WHERE hit_count = 0) AS never,
               max(created_at) AS last_write
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${ws} AND valid_to IS NULL AND status = 'active'${ceiling}
        GROUP BY 1, 2, 3
      `)) as unknown as Array<{
        kind: string;
        sensitivity: Sensitivity;
        memory_type: string;
        n: string | number;
        pinned: string | number;
        never: string | number;
        last_write: Date | string | null;
      }>;
    });
    const lastWrite = rows.reduce<number | null>((max, r) => {
      const t = r.last_write == null ? null : new Date(r.last_write).getTime();
      return t != null && (max == null || t > max) ? t : max;
    }, null);
    // Largest group first, then by name (code-point order), like the in-memory twin.
    const tally = (key: (r: (typeof rows)[number]) => string): Array<[string, number]> => {
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + Number(r.n));
      return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    };
    const sum = (k: "n" | "pinned" | "never") => rows.reduce((t, r) => t + Number(r[k]), 0);
    return {
      live: sum("n"),
      pinned: sum("pinned"),
      neverRecalled: sum("never"),
      lastWriteAt: lastWrite == null ? null : new Date(lastWrite).toISOString(),
      byKind: tally((r) => r.kind).map(([kind, count]) => ({ kind, count })),
      bySensitivity: tally((r) => r.sensitivity).map(([s, count]) => ({
        sensitivity: s as Sensitivity,
        count,
      })),
      byMemoryType: tally((r) => r.memory_type).map(([memoryType, count]) => ({
        memoryType,
        count,
      })),
    };
  }

  // ─── Recall log (ACT-R activation — TASK-4001) ─────────────────────────────

  async getRecallLog(
    workspaceId: string,
    memoryId: string,
    limit: number
  ): Promise<Array<{ id: string; recalledAt: string; recallScore: number }>> {
    // C4: filter on fact_id (TEXT), read COALESCE(activation_score, recall_score).
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const result = (await tx.execute(
        sql`SELECT id::text, recalled_at,
                   COALESCE(activation_score, recall_score)::text AS recall_score
            FROM mnemosyne.mnemo_recall_log
            WHERE workspace_id = ${workspaceId}::uuid
              AND COALESCE(memory_id, fact_id) = ${memoryId}
              AND ${organicRecallLogRow}
            ORDER BY recalled_at DESC
            LIMIT ${limit}`
      )) as unknown as Array<{ id: string; recalled_at: Date | string; recall_score: string }>;
      return Array.from(result);
    });
    return rows.map((r) => ({
      id: r.id,
      recalledAt:
        r.recalled_at instanceof Date ? r.recalled_at.toISOString() : String(r.recalled_at),
      recallScore: parseFloat(r.recall_score ?? "0"),
    }));
  }

  async getRecallLogs(
    workspaceId: string,
    memoryIds: string[],
    limitPerMemory: number
  ): Promise<RecallLogRecord[]> {
    if (memoryIds.length === 0) return [];
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx.execute(sql`
        SELECT memory_id, id::text, recalled_at,
               COALESCE(activation_score, recall_score)::text AS recall_score
        FROM (
          SELECT COALESCE(memory_id, fact_id) AS memory_id, id, recalled_at, activation_score, recall_score,
                 row_number() OVER (PARTITION BY COALESCE(memory_id, fact_id) ORDER BY recalled_at DESC, id DESC) AS rn
          FROM mnemosyne.mnemo_recall_log
          WHERE workspace_id = ${workspaceId}::uuid
            AND (
              ${inArray(schema.recallLogTable.memoryId, memoryIds)}
              OR (memory_id IS NULL AND ${inArray(schema.recallLogTable.factId, memoryIds)})
            )
            AND ${organicRecallLogRow}
        ) ranked
        WHERE rn <= ${limitPerMemory}
        ORDER BY memory_id, recalled_at DESC, id DESC
      `) as unknown as Array<{
        memory_id: string;
        id: string;
        recalled_at: Date | string;
        recall_score: string;
      }>;
    });
    return Array.from(rows).map((row) => ({
      memoryId: row.memory_id,
      id: row.id,
      recalledAt:
        row.recalled_at instanceof Date ? row.recalled_at.toISOString() : String(row.recalled_at),
      recallScore: Number(row.recall_score ?? 0),
    }));
  }

  async getRecentQueriesForFacts(
    workspaceId: string,
    factIds: string[],
    limit: number
  ): Promise<string[]> {
    if (factIds.length === 0) return [];
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // GROUP BY query_text so DISTINCT is handled, order by the most-recent
      // recalled_at for each distinct query text (most recently used first).
      const result = (await tx.execute(
        sql`SELECT query_text
            FROM mnemosyne.mnemo_recall_log
            WHERE workspace_id = ${workspaceId}::uuid
              AND fact_id IS NOT NULL
              AND (primitive_kind IS NULL OR primitive_kind = 'fact')
              AND fact_id = ANY(${factIds}::text[])
              AND query_text IS NOT NULL
              AND query_text <> ''
            GROUP BY query_text
            ORDER BY MAX(recalled_at) DESC
            LIMIT ${limit}`
      )) as unknown as Array<{ query_text: string }>;
      return Array.from(result);
    });
    return rows.map((r) => r.query_text);
  }

  /**
   * Record a co-recall event: compute STDP delta from the inter-spike interval
   * (coRecalledAt - lastCoRecallAt), update hebbian_weight, directionality,
   * co_recall_count, and last_co_recall_at on the relation row.
   */
  async recordCoRecallStdp(
    workspaceId: string,
    relationId: string,
    coRecalledAt: Date
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select({
          hebbianWeight: schema.relationTable.hebbianWeight,
          directionality: schema.relationTable.directionality,
          coRecallCount: schema.relationTable.coRecallCount,
          lastCoRecallAt: schema.relationTable.lastCoRecallAt,
        })
        .from(schema.relationTable)
        .where(
          and(
            eq(schema.relationTable.id, relationId),
            eq(schema.relationTable.workspaceId, workspaceId)
          )
        );
      if (rows.length === 0) return;
      const row = rows[0]!;
      const prevAt = row.lastCoRecallAt;
      const deltaSeconds = prevAt ? (coRecalledAt.getTime() - prevAt.getTime()) / 1000 : 0;
      const { weight: newWeight, directionality: newDir } = stdpUpdate({
        weight: row.hebbianWeight,
        directionality: row.directionality,
        deltaSeconds,
      });
      await tx
        .update(schema.relationTable)
        .set({
          hebbianWeight: newWeight,
          directionality: newDir,
          coRecallCount: sql`co_recall_count + 1`,
          lastCoRecallAt: coRecalledAt,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(schema.relationTable.id, relationId),
            eq(schema.relationTable.workspaceId, workspaceId)
          )
        );
    });
  }

  /**
   * Homeostatic weekly rescale: normalise hebbian_weight for all active relations
   * in a workspace using PERCENT_RANK() OVER (ORDER BY hebbian_weight).
   * Returns the number of rows updated.
   */
  async normalizeHebbianWeights(workspaceId: string): Promise<number> {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const updated = await tx.execute(
        sql`UPDATE mnemosyne.mnemo_relation r
            SET hebbian_weight = ranked.pr::real,
                updated_at = NOW()
            FROM (
              SELECT id,
                PERCENT_RANK() OVER (ORDER BY hebbian_weight) AS pr
              FROM mnemosyne.mnemo_relation
              WHERE workspace_id = ${workspaceId}
                AND valid_to IS NULL
            ) ranked
            WHERE r.id = ranked.id
              AND r.workspace_id = ${workspaceId}
            RETURNING 1`
      );
      return Array.from(updated).length;
    });
    return result;
  }

  /**
   * Decay Beta evidence (worth_alpha/worth_beta) toward the (1,1) prior for all
   * active rows of the given decay class, applying the §25.2 exponential
   * half-life.
   */
  async decayKind(
    workspaceId: string,
    decayClass: DecayClass,
    halfLifeDays: number
  ): Promise<number> {
    // entity: never decays (half-life = 0 is the sentinel).
    if (halfLifeDays <= 0 || decayClass === "entity") return 0;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      // Shared relaxation factor over a per-row "days since last activity" column.
      // `lastActivity` is a SQL fragment naming the timestamp column to use.
      const decayedColumn = (
        col: "worth_alpha" | "worth_beta",
        lastActivity: ReturnType<typeof sql>
      ) =>
        sql`GREATEST(1, 1 + (${sql.raw(col)}::real - 1) * POWER(2::real, -(EXTRACT(EPOCH FROM (NOW() - ${lastActivity})) / 86400.0) / ${halfLifeDays}))`;

      let total = 0;

      if (decayClass === "semantic") {
        // §25.2 fix: ALL active facts are the semantic primitive (H=58d). The
        // prior `kind IN ('fact','decision')` filter matched zero rows because
        // mnemo_fact.kind is a CONTENT tag (preference/trait/event/…), not a
        // primitive class — so semantic decay was a latent no-op. Decay every
        // live fact by days-since-last-recall.
        const last = sql`COALESCE(last_recalled_at, created_at)`;
        const updated = await tx.execute(
          sql`UPDATE mnemosyne.mnemo_fact
              SET worth_alpha = ${decayedColumn("worth_alpha", last)},
                  worth_beta  = ${decayedColumn("worth_beta", last)},
                  updated_at  = NOW()
              WHERE workspace_id = ${workspaceId}
                AND valid_to IS NULL
                AND status = 'active'
                AND NOT (COALESCE(metadata, '{}'::jsonb) ? '__mnemoConsolidationPending')
              RETURNING 1`
        );
        total += Array.from(updated).length;
        return total;
      }

      if (decayClass === "episodic") {
        // No Beta-bearing rows are episodic (see doc comment). Event is immutable.
        return 0;
      }

      if (decayClass === "reasoning") {
        const last = sql`COALESCE(last_used_at, updated_at, created_at)`;
        const updated = await tx.execute(
          sql`UPDATE mnemosyne.mnemo_reasoning
              SET worth_alpha = ${decayedColumn("worth_alpha", last)},
                  worth_beta  = ${decayedColumn("worth_beta", last)},
                  updated_at  = NOW()
              WHERE workspace_id = ${workspaceId}
                AND status = 'active'
              RETURNING 1`
        );
        total += Array.from(updated).length;
        return total;
      }

      // procedural: strategy + workflow + skill all share the worth_alpha/worth_beta
      // pair (added in migration 0053). Each uses its own best "last activity" ts.
      const strategy = await tx.execute(
        sql`UPDATE mnemosyne.mnemo_strategy
            SET worth_alpha = ${decayedColumn("worth_alpha", sql`COALESCE(updated_at, created_at)`)},
                worth_beta  = ${decayedColumn("worth_beta", sql`COALESCE(updated_at, created_at)`)},
                updated_at  = NOW()
            WHERE workspace_id = ${workspaceId}
              AND status = 'active'
            RETURNING 1`
      );
      total += Array.from(strategy).length;

      const workflow = await tx.execute(
        sql`UPDATE mnemosyne.mnemo_workflow
            SET worth_alpha = ${decayedColumn("worth_alpha", sql`COALESCE(last_executed_at, updated_at, created_at)`)},
                worth_beta  = ${decayedColumn("worth_beta", sql`COALESCE(last_executed_at, updated_at, created_at)`)},
                updated_at  = NOW()
            WHERE workspace_id = ${workspaceId}
              AND status = 'active'
            RETURNING 1`
      );
      total += Array.from(workflow).length;

      const skill = await tx.execute(
        sql`UPDATE mnemosyne.mnemo_skill
            SET worth_alpha = ${decayedColumn("worth_alpha", sql`COALESCE(last_used_at, updated_at, created_at)`)},
                worth_beta  = ${decayedColumn("worth_beta", sql`COALESCE(last_used_at, updated_at, created_at)`)},
                updated_at  = NOW()
            WHERE workspace_id = ${workspaceId}
              AND valid_to IS NULL
            RETURNING 1`
      );
      total += Array.from(skill).length;

      return total;
    });
  }

  async lookupFactHash(
    workspaceId: string,
    statementHash: string
  ): Promise<import("@mnemo-ai/types").MnemoFactHash | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.factHashTable)
        .where(
          and(
            eq(schema.factHashTable.workspaceId, workspaceId),
            eq(schema.factHashTable.statementHash, statementHash)
          )
        )
        .limit(1);
      return rows[0] ? factHashRowToDomain(rows[0]) : null;
    });
  }

  async upsertFactHash(
    input: import("@mnemo-ai/types").UpsertFactHashInput
  ): Promise<import("@mnemo-ai/types").MnemoFactHash> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const [row] = await tx
        .insert(schema.factHashTable)
        .values({
          workspaceId: input.workspaceId,
          statementHash: input.statementHash,
          factId: input.factId,
        })
        .onConflictDoUpdate({
          target: [schema.factHashTable.workspaceId, schema.factHashTable.statementHash],
          set: {
            factId: input.factId,
            lastSeenAt: new Date(),
            seenCount: sql`${schema.factHashTable.seenCount} + 1`,
          },
        })
        .returning();
      if (!row) throw new Error("upsertFactHash: UPSERT returned no rows");
      return factHashRowToDomain(row);
    });
  }

  private static asSigned64(u: bigint): bigint {
    const MOD = 1n << 64n;
    const v = ((u % MOD) + MOD) % MOD;
    return v >= 1n << 63n ? v - MOD : v;
  }

  async getRecallPrimitives(
    workspaceId: string,
    refs: RecallPrimitiveRef[]
  ): Promise<RecallPrimitiveRecord[]> {
    if (refs.length === 0) return [];
    const idsByKind = new Map<RecallPrimitiveRef["kind"], string[]>();
    for (const ref of refs) idsByKind.set(ref.kind, [...(idsByKind.get(ref.kind) ?? []), ref.id]);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const records: RecallPrimitiveRecord[] = [];
      const add = <T>(
        kind: RecallPrimitiveRef["kind"],
        rows: T[],
        map: (row: T) => RecallPrimitiveRecord["value"]
      ) => {
        for (const row of rows) {
          const value = map(row);
          records.push({ id: value.id, kind, value });
        }
      };
      const conditions = <T extends { id: unknown; workspaceId: unknown }>(
        table: T,
        kind: RecallPrimitiveRef["kind"]
      ) =>
        and(
          eq(table.workspaceId as never, workspaceId),
          inArray(table.id as never, idsByKind.get(kind) ?? [])
        );

      if (idsByKind.has("fact"))
        add(
          "fact",
          await tx.select().from(schema.factTable).where(conditions(schema.factTable, "fact")),
          mapRowToFact
        );
      if (idsByKind.has("decision"))
        add(
          "decision",
          await tx
            .select()
            .from(schema.decisionTable)
            .where(conditions(schema.decisionTable, "decision")),
          mapRowToDecision
        );
      if (idsByKind.has("episode")) {
        const episodeIds = idsByKind.get("episode")!;
        const ancestry = Array.from(
          (await tx.execute(sql`
          WITH RECURSIVE episode_chain AS (
            SELECT id, parent_episode_id
            FROM mnemosyne.mnemo_episode
            WHERE workspace_id = ${workspaceId} AND ${inArray(schema.episodeTable.id, episodeIds)}
            UNION
            SELECT parent.id, parent.parent_episode_id
            FROM mnemosyne.mnemo_episode parent
            JOIN episode_chain child ON child.parent_episode_id = parent.id
            WHERE parent.workspace_id = ${workspaceId}
          )
          SELECT id FROM episode_chain
        `)) as unknown as Array<{ id: string }>
        );
        const chainIds = ancestry.map((row) => row.id);
        const rows =
          chainIds.length === 0
            ? []
            : await tx
                .select()
                .from(schema.episodeTable)
                .where(
                  and(
                    eq(schema.episodeTable.workspaceId, workspaceId),
                    inArray(schema.episodeTable.id, chainIds)
                  )
                );
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const id of episodeIds) {
          const leaf = byId.get(id);
          if (!leaf) continue;
          const chain: typeof rows = [];
          const seen = new Set<string>();
          let cursor: typeof leaf | undefined = leaf;
          while (cursor && !seen.has(cursor.id)) {
            seen.add(cursor.id);
            chain.push(cursor);
            cursor = cursor.parentEpisodeId ? byId.get(cursor.parentEpisodeId) : undefined;
          }
          const rootFirst = [...chain].reverse();
          let narrative = rootFirst[0]?.narrative ?? leaf.narrative;
          for (const node of rootFirst.slice(1))
            narrative = applyDelta(narrative, node.deltaContent ?? "");
          records.push({
            id,
            kind: "episode",
            value: { ...mapRowToEpisode(leaf), narrative },
          });
        }
      }
      if (idsByKind.has("entity"))
        add(
          "entity",
          await tx
            .select()
            .from(schema.entityTable)
            .where(conditions(schema.entityTable, "entity")),
          mapRowToEntity
        );
      if (idsByKind.has("strategy"))
        add(
          "strategy",
          await tx
            .select()
            .from(schema.strategyTable)
            .where(conditions(schema.strategyTable, "strategy")),
          mapRowToStrategy
        );
      if (idsByKind.has("workflow"))
        add(
          "workflow",
          await tx
            .select()
            .from(schema.workflowTable)
            .where(conditions(schema.workflowTable, "workflow")),
          mapRowToWorkflow
        );
      if (idsByKind.has("skill"))
        add(
          "skill",
          await tx.select().from(schema.skillTable).where(conditions(schema.skillTable, "skill")),
          mapRowToSkill
        );
      if (idsByKind.has("task"))
        add(
          "task",
          await tx.select().from(schema.taskTable).where(conditions(schema.taskTable, "task")),
          mapRowToTask
        );
      if (idsByKind.has("event"))
        add(
          "event",
          await tx.select().from(schema.eventTable).where(conditions(schema.eventTable, "event")),
          mapRowToEvent
        );
      if (idsByKind.has("reasoning"))
        add(
          "reasoning",
          await tx
            .select()
            .from(schema.reasoningTable)
            .where(conditions(schema.reasoningTable, "reasoning")),
          mapRowToReasoning
        );
      return records;
    });
  }

  async getRecallStructures(
    workspaceId: string,
    sourceIds: string[],
    hyperedgeLimitPerMember: number,
    maxSensitivity?: Sensitivity
  ): Promise<RecallStructures> {
    if (sourceIds.length === 0) return { relations: [], hyperedges: [] };
    const hyperedgeVisible = hyperedgeReadable(maxSensitivity);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const relationRows = await tx
        .select()
        .from(schema.relationTable)
        .where(
          and(
            eq(schema.relationTable.workspaceId, workspaceId),
            inArray(schema.relationTable.sourceId, sourceIds),
            ...relationReadable(maxSensitivity)
          )
        );
      const pairs = Array.from(
        (await tx.execute(sql`
        SELECT member_id, id AS hyperedge_id
        FROM unnest(ARRAY[${sql.join(
          sourceIds.map((id) => sql`${id}`),
          sql`, `
        )}]::text[]) AS members(member_id)
        CROSS JOIN LATERAL (
          SELECT id
          FROM mnemosyne.mnemo_hyperedge
          WHERE workspace_id = ${workspaceId}
            AND valid_to IS NULL
            AND members.member_id = ANY(member_ids)${hyperedgeVisible.length > 0 ? sql` AND ${hyperedgeVisible[0]}` : sql``}
          ORDER BY activation_count DESC, id ASC
          LIMIT ${hyperedgeLimitPerMember}
        ) selected
      `)) as unknown as Array<{ member_id: string; hyperedge_id: string }>
      );
      const hyperedgeIds = [...new Set(pairs.map((pair) => pair.hyperedge_id))];
      const hyperedgeRows =
        hyperedgeIds.length === 0
          ? []
          : await tx
              .select()
              .from(schema.hyperedgeTable)
              .where(
                and(
                  eq(schema.hyperedgeTable.workspaceId, workspaceId),
                  inArray(schema.hyperedgeTable.id, hyperedgeIds)
                )
              );
      const byId = new Map(hyperedgeRows.map((row) => [row.id, hyperedgeRowToDomain(row)]));
      return {
        relations: relationRows.map(mapRowToRelation),
        hyperedges: pairs.flatMap((pair) => {
          const hyperedge = byId.get(pair.hyperedge_id);
          return hyperedge ? [{ memberId: pair.member_id, hyperedge }] : [];
        }),
      };
    });
  }

  private candidateConditions(
    query: Pick<
      PointerCandidateQuery,
      "workspaceId" | "filter" | "includeArchived" | "includeLowWorth" | "asOf"
    >
  ): SQL[] {
    const conditions: SQL[] = [eq(schema.factTable.workspaceId, query.workspaceId)];
    conditions.push(
      query.asOf
        ? // Point-in-time: what was valid then, whatever happened to it since
          // (closed, superseded, merged). The same rule as GET /facts?asOf.
          and(
            lte(schema.factTable.validFrom, query.asOf),
            or(isNull(schema.factTable.validTo), gt(schema.factTable.validTo, query.asOf))!
          )!
        : query.includeArchived
          ? or(
              and(eq(schema.factTable.status, "active"), isNull(schema.factTable.validTo)),
              and(eq(schema.factTable.status, "forgotten"), isNotNull(schema.factTable.validTo))
            )!
          : and(eq(schema.factTable.status, "active"), isNull(schema.factTable.validTo))!
    );
    if (query.includeLowWorth === false) {
      // Ruling 1 (follow-up of PR #258): the lower bound comes from the raw
      // evidence, Wilson(2 + worth_success, 2 + worth_failure), not from the
      // decayed worth_alpha/worth_beta. Decay relaxes those toward (1,1): the
      // mean keeps its side of 0.5 but the bound erodes, which made every fact
      // judged useful long ago unservable. The decayed mean (worth > 0.5) is
      // still required. Mirrors worthGateLowerBound in core.
      const alpha = sql`(2 + ${schema.factTable.worthSuccess})`;
      const beta = sql`(2 + ${schema.factTable.worthFailure})`;
      const n = sql`(${alpha} + ${beta})`;
      const p = sql`(${alpha} / NULLIF(${n}, 0))`;
      const z2 = 1.96 ** 2;
      const lower = sql`(
        ${p} + ${z2} / (2 * ${n}) - 1.96 * sqrt((${p} * (1 - ${p})) / ${n} + ${z2} / (4 * ${n} * ${n}))
      ) / (1 + ${z2} / ${n})`;
      // BUGFIX (mirrors passesWorthGate's isUntested exemption in
      // packages/core/src/cognitive/worth.ts, dated 2026-07-22): a fact still
      // at the Beta(2,2) prior (zero observations either way) sits at exactly
      // worth=0.5, lb≈0.15 — failing `worth > 0.5` on absence of evidence, not
      // evidence of low quality. Without this OR-exemption here, this SQL
      // pre-filter excluded every untested fact from ever reaching
      // recall-pointer.ts's hydrate step, so the JS-level isUntested exemption
      // was unreachable for this candidate-fetching path and a freshly
      // remember()'d fact could never be recalled for the first time.
      // Untested = never judged (no success or failure observation). Not
      // `alpha = 2 AND beta = 2`: decay relaxes both toward 1 as a fact ages,
      // which turned every unjudged fact older than a decay run into a
      // "tested" one stuck at worth 0.5 (see isUntestedWorth in core).
      const isUntested = sql`(${schema.factTable.worthSuccess} = 0 AND ${schema.factTable.worthFailure} = 0)`;
      conditions.push(
        sql`((${schema.factTable.worth} > 0.5 AND ${lower} >= 0.3) OR ${isUntested})`
      );
    }

    const filter = query.filter;
    if (!filter) return conditions;
    if (filter.kinds && !filter.kinds.includes("fact")) conditions.push(sql`false`);
    if (filter.tags?.length) {
      conditions.push(
        sql`${schema.factTable.metadata} @> ${JSON.stringify({ tags: filter.tags })}::jsonb`
      );
    }
    if (filter.validAfter) conditions.push(gte(schema.factTable.validFrom, filter.validAfter));
    if (filter.validBefore) conditions.push(lte(schema.factTable.validFrom, filter.validBefore));
    if (filter.minWorth !== undefined) {
      conditions.push(gte(schema.factTable.worth, filter.minWorth.toString()));
    }
    if (filter.minConfidence !== undefined) {
      conditions.push(gte(schema.factTable.confidence, filter.minConfidence));
    }
    if (filter.sensitivity) {
      conditions.push(
        filter.sensitivity.length > 0
          ? inArray(schema.factTable.sensitivity, filter.sensitivity)
          : sql`false`
      );
    }
    if (filter.provenance) {
      conditions.push(
        filter.provenance.length > 0
          ? inArray(schema.factTable.attribution, filter.provenance)
          : sql`false`
      );
    }
    if (filter.entityId) conditions.push(eq(schema.factTable.entityId, filter.entityId));
    if (filter.sessionId) conditions.push(eq(schema.factTable.sessionId, filter.sessionId));
    if (filter.scope) conditions.push(eq(schema.factTable.scope, filter.scope));
    const scopeRefs = scopeRefValues(filter);
    if (scopeRefs) conditions.push(inArray(schema.factTable.scopeRef, scopeRefs));
    if (filter.actorId) conditions.push(eq(schema.factTable.actorId, filter.actorId));
    // RECALL-6: exact ownership; a NULL scope_owner never equals a label.
    if (filter.scopeOwner) conditions.push(eq(schema.factTable.scopeOwner, filter.scopeOwner));
    return conditions;
  }

  private pointerCandidate(row: typeof schema.factTable.$inferSelect): PointerCandidate {
    const fact = mapRowToFact(row);
    return {
      factId: fact.id,
      statement: fact.statement,
      embedding: (row.embedding as number[] | null) ?? null,
      sensitivity: fact.sensitivity,
      worth: fact.worth,
      worthAlpha: fact.worthAlpha,
      worthBeta: fact.worthBeta,
      worthSuccess: fact.worthSuccess,
      worthFailure: fact.worthFailure,
      attribution: fact.attribution,
      createdAt: fact.createdAt,
      validFrom: fact.validFrom,
      status: fact.status,
      validTo: fact.validTo ?? null,
      confidence: fact.confidence,
      tags: Array.isArray(fact.metadata.tags)
        ? fact.metadata.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      scope: fact.scope,
      scopeRef: fact.scopeRef,
      actorId: fact.actorId ?? null,
      entityId: fact.entityId,
      sessionId: fact.sessionId,
      ...(fact.scopeOwner ? { scopeOwner: fact.scopeOwner } : {}),
      ...(fact.topicKey ? { topicKey: fact.topicKey } : {}),
      ...(fact.subject ? { subject: fact.subject } : {}),
    };
  }

  async upsertFactLsh(input: import("@mnemo-ai/types").UpsertFactLshInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const current = await tx
        .select({ revision: schema.factTable.revisionCount })
        .from(schema.factTable)
        .where(
          and(
            eq(schema.factTable.workspaceId, input.workspaceId),
            eq(schema.factTable.id, input.factId),
            eq(schema.factTable.revisionCount, input.revision)
          )
        )
        .limit(1)
        .for("update");
      if (!current[0]) return;
      await tx
        .delete(schema.factLshTable)
        .where(
          and(
            eq(schema.factLshTable.workspaceId, input.workspaceId),
            eq(schema.factLshTable.factId, input.factId)
          )
        );
      if (input.bands.length === 0) return;
      await tx.insert(schema.factLshTable).values(
        input.bands.map((b) => ({
          workspaceId: input.workspaceId,
          factId: input.factId,
          bandIdx: b.bandIdx,
          bandHash: RecallRepository.asSigned64(b.bandHash),
        }))
      );
    });
  }

  async pointerCandidates(query: PointerCandidateQuery): Promise<PointerCandidate[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${query.workspaceId}::uuid)`);
      const tsq = query.terms.join(" ");
      const conditions = and(...this.candidateConditions(query));
      const bandMatch =
        query.bands.length > 0
          ? or(
              ...query.bands.map((band) =>
                and(
                  eq(schema.factLshTable.bandIdx, band.bandIdx),
                  eq(schema.factLshTable.bandHash, RecallRepository.asSigned64(band.bandHash))
                )
              )
            )!
          : sql`false`;
      const candidates = Array.from(
        (await tx.execute(sql`
        WITH lsh_arm AS (
          SELECT ${schema.factTable.id} AS id, count(*)::double precision AS collisions, 0::double precision AS fts_rank
          FROM ${schema.factTable}
          JOIN ${schema.factLshTable}
            ON ${schema.factLshTable.workspaceId} = ${schema.factTable.workspaceId}
           AND ${schema.factLshTable.factId} = ${schema.factTable.id}
          WHERE ${conditions} AND ${bandMatch}
          GROUP BY ${schema.factTable.id}
        ),
        fts_arm AS (
          SELECT ${schema.factTable.id} AS id, 0::double precision AS collisions,
                 ${ftsRankEither(sql`${schema.factTable.textLemmatized}`, sql`${schema.factTable.textLemmatizedEs}`, tsq)}::double precision AS fts_rank
          FROM ${schema.factTable}
          WHERE ${conditions}
            AND ${
              query.terms.length > 0
                ? ftsMatchesEither(
                    sql`${schema.factTable.textLemmatized}`,
                    sql`${schema.factTable.textLemmatizedEs}`,
                    tsq
                  )
                : sql`false`
            }
        ),
        combined AS (
          SELECT * FROM lsh_arm
          UNION ALL
          SELECT * FROM fts_arm
        ),
        ranked AS (
          SELECT id, sum(collisions) AS collisions, max(fts_rank) AS fts_rank
          FROM combined
          GROUP BY id
        )
        SELECT id
        FROM ranked
        ORDER BY (fts_rank + collisions * 0.01) DESC, fts_rank DESC, collisions DESC, id ASC
        LIMIT ${query.limit}
      `)) as unknown as Array<{ id: string }>
      );
      const ids = candidates.map((candidate) => candidate.id);
      if (ids.length === 0) return [];

      const rows = await tx
        .select()
        .from(schema.factTable)
        .where(and(inArray(schema.factTable.id, ids), ...this.candidateConditions(query)));

      const rowsById = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => {
        const row = rowsById.get(id);
        return row ? [this.pointerCandidate(row)] : [];
      });
    });
  }

  /**
   * WP-3 (AGENTSIM-4): which of `ids` sit on either end of an unresolved
   * `conflicts_with` relation — `valid_to IS NULL`, the definition GET
   * /conflicts lists and memory_judge resolves. One query for the served page.
   */
  async getUnresolvedConflictIds(
    workspaceId: string,
    ids: string[],
    maxSensitivity?: Sensitivity
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx
        .select({
          sourceId: schema.relationTable.sourceId,
          targetId: schema.relationTable.targetId,
        })
        .from(schema.relationTable)
        .where(
          and(
            eq(schema.relationTable.workspaceId, workspaceId),
            eq(schema.relationTable.relation, "conflicts_with"),
            isNull(schema.relationTable.validTo),
            or(
              inArray(schema.relationTable.sourceId, ids),
              inArray(schema.relationTable.targetId, ids)
            ),
            ...relationReadable(maxSensitivity)
          )
        );
    });
    const wanted = new Set(ids);
    const out = new Set<string>();
    for (const row of rows) {
      if (wanted.has(row.sourceId)) out.add(row.sourceId);
      if (wanted.has(row.targetId)) out.add(row.targetId);
    }
    return [...out];
  }

  /** FTS arm of hybrid Tier-3 recall using idx_fact_fts (migration 0047). */
  async ftsCandidates(query: Omit<PointerCandidateQuery, "bands">): Promise<FtsCandidate[]> {
    if (query.terms.length === 0) return [];
    const tsq = query.terms.join(" ");
    return this.db.transaction(async (tx) => {
      // GUC must be set before any workspace-scoped query to satisfy RLS policies.
      await tx.execute(sql`SELECT mnemo_set_workspace(${query.workspaceId}::uuid)`);
      const rank = ftsRankEither(
        sql`${schema.factTable.textLemmatized}`,
        sql`${schema.factTable.textLemmatizedEs}`,
        tsq
      ) as SQL<number>;
      let rows = await tx
        .select({ ...getTableColumns(schema.factTable), rank })
        .from(schema.factTable)
        .where(
          and(
            ...this.candidateConditions(query),
            ftsMatchesEither(
              sql`${schema.factTable.textLemmatized}`,
              sql`${schema.factTable.textLemmatizedEs}`,
              tsq
            )
          )
        )
        .orderBy(desc(rank))
        .limit(query.limit);
      if (rows.length === 0 && query.relaxedOnEmpty) {
        const contentTerms = await relaxedContentTerms(tx, query.terms);
        if (contentTerms.length >= 3) {
          const en = sql`${schema.factTable.textLemmatized}`;
          const es = sql`${schema.factTable.textLemmatizedEs}`;
          const matches = contentTerms.map((term) => ftsMatchesEither(en, es, term));
          const matched = sql.join(
            matches.map((match) => sql`CASE WHEN ${match} THEN 1 ELSE 0 END`),
            sql` + `
          );
          const relaxedRank = sql.join(
            contentTerms.map((term) => ftsRankEither(en, es, term)),
            sql` + `
          ) as SQL<number>;
          rows = await tx
            .select({ ...getTableColumns(schema.factTable), rank: relaxedRank })
            .from(schema.factTable)
            .where(
              and(
                ...this.candidateConditions(query),
                // The OR lets the planner use the FTS indexes before counting matches.
                or(...matches)!,
                sql`(${matched}) >= ${Math.min(2, contentTerms.length)}`
              )
            )
            .orderBy(desc(relaxedRank))
            .limit(query.limit);
        }
      }
      return rows.map(({ rank: rowRank, ...row }) => ({
        ...this.pointerCandidate(row),
        rank: Number(rowRank),
      }));
    });
  }

  /**
   * make-primitives-recallable (design.md D4/Interfaces, PR3 — Phase 5).
   * Non-fact recall candidates over `mnemo_decision` — the only
   * `RECALLABLE_KIND` besides `fact` today. `kinds` DRIVES the query (not a
   * post-filter): a `kinds` array without `"decision"` issues no query at
   * all. Semantic arm mirrors `EntityRepository.findSimilarEntities`'s
   * sequential-cosine-scan shape (`mnemo_decision.embedding` has had no ANN
   * index since migration `0009:60` — design.md Risk 3, deliberately not
   * fixed here). Lexical arm mirrors `ftsCandidates` above exactly
   * (`plainto_tsquery(mnemosyne.mnemo_fts, …)`, migration `0035` aligned
   * `text_lemmatized` to the same config). Runs whichever arm(s) the query
   * supplies (`embedding` → semantic, `terms` → lexical, both → both,
   * neither → `[]`), keeps the `mnemo_set_workspace` GUC call `ftsCandidates`
   * uses, and merges candidates by id, keeping the higher of the two scores
   * when both arms hit the same decision.
   */
  async recallableCandidates(query: PrimitiveCandidateQuery): Promise<PrimitiveCandidate[]> {
    // P65: table-driven over the requested kinds. This was hardcoded to
    // `decision` — one `if (!query.kinds.includes("decision")) return []` and a
    // single pair of queries — so a kind added to RECALLABLE_KINDS was indexed
    // on write and unreachable on read. Half a mechanism, again.
    //
    // `kinds` DRIVES the query rather than post-filtering it: a kind the caller
    // did not ask for issues no SQL at all.
    const targets = query.kinds
      .map((k): NonFactRecallSource | undefined => NON_FACT_RECALL_SOURCES[k])
      .filter((t): t is NonFactRecallSource => t !== undefined);
    // Facts are served by the vector.search / ftsCandidates arms, not here.
    if (targets.length === 0) return [];

    const hasSemantic = query.embedding !== undefined && query.embedding.length > 0;
    const hasLexical = query.terms !== undefined && query.terms.length > 0;
    if (!hasSemantic && !hasLexical) return [];

    return this.db.transaction(async (tx) => {
      // GUC must be set before any workspace-scoped query to satisfy RLS policies.
      await tx.execute(sql`SELECT mnemo_set_workspace(${query.workspaceId}::uuid)`);

      const byId = new Map<string, PrimitiveCandidate>();
      const keep = (candidate: PrimitiveCandidate) => {
        const existing = byId.get(candidate.id);
        // Same row reached by both arms: `score` keeps the better one, as it
        // always has; WP-3 keeps each arm's own evidence beside it, because a
        // cosine and a ts_rank are not on one scale.
        byId.set(candidate.id, {
          ...existing,
          ...candidate,
          score: Math.max(candidate.score, existing?.score ?? -Infinity),
          ...(existing?.similarity !== undefined && candidate.similarity === undefined
            ? { similarity: existing.similarity }
            : {}),
          ...(existing?.lexicalRank !== undefined && candidate.lexicalRank === undefined
            ? { lexicalRank: existing.lexicalRank }
            : {}),
        });
      };
      // RECALL-7: computed once, only if a strict lexical arm comes back empty.
      let relaxedTerms: string[] | undefined;

      for (const target of targets) {
        // One liveness fragment, shared by both arms, so the semantic and
        // lexical halves can never disagree about which rows exist.
        // ISO text + cast: drizzle's postgres-js driver does not serialise a
        // Date inside raw SQL.
        const at = query.asOf ? sql`${query.asOf.toISOString()}::timestamptz` : sql``;
        const live = query.asOf
          ? target.since
            ? sql`AND ${sql.raw(target.since)} <= ${at}`
            : sql`AND COALESCE(valid_from, created_at) <= ${at}
                  AND (valid_to IS NULL OR valid_to > ${at})`
          : target.live
            ? sql.raw(`AND (${target.live})`)
            : sql.raw("");
        // RECALL-6: ownership before LIMIT in both arms.
        const owned = query.scopeOwner ? sql`AND scope_owner = ${query.scopeOwner}` : sql``;
        const literal = hasSemantic ? `[${query.embedding!.join(",")}]` : "";
        // Review (RECALL-3): a lexical match still has a stored vector. Its
        // cosine comes back with it, so the caller's floor and semantic rank
        // see it — reported "lexical-only", a row the semantic arm had just
        // excluded below the floor walked back in.
        const lexicalCosine = hasSemantic
          ? sql`CASE WHEN embedding IS NOT NULL AND ${sameWidthAsQuery("embedding", query.embedding!)}
                     THEN (1 - (embedding <=> ${literal}::public.halfvec))::float8 END`
          : sql`NULL::float8`;

        if (hasSemantic) {
          const minSim = query.minSimilarity ?? 0;
          // Sequential cosine scan: these tables carry no ANN index (design.md
          // Risk 3, accepted deliberately — far fewer rows than mnemo_fact).
          // P118's width predicate keeps a mixed-width table from throwing.
          const rows = await tx.execute<{
            id: string;
            sensitivity: string;
            cosine: string | number;
          }>(sql`
            SELECT id, sensitivity,
                   (1 - (embedding <=> ${literal}::public.halfvec))::float8 AS cosine
              FROM ${sql.raw(target.sqlName)}
             WHERE workspace_id = ${query.workspaceId}
               ${live}
               ${owned}
               AND embedding IS NOT NULL
               AND ${sameWidthAsQuery("embedding", query.embedding!)}
               AND (1 - (embedding <=> ${literal}::public.halfvec)) >= ${minSim}
             ORDER BY embedding <=> ${literal}::public.halfvec
             LIMIT ${query.limit}
          `);
          for (const row of rows as unknown as Array<{
            id: string;
            sensitivity: string;
            cosine: string | number;
          }>) {
            keep({
              id: row.id,
              kind: target.kind as PrimitiveCandidate["kind"],
              score: Number(row.cosine),
              sensitivity: row.sensitivity as Sensitivity,
              similarity: Number(row.cosine),
            });
          }
        }

        if (hasLexical) {
          const tsq = query.terms!.join(" ");
          // 'english', matching every other lexical arm. A mismatched config is
          // not a small difference: the same text tokenises differently and the
          // arm silently under-returns.
          let rows = (await tx.execute<{
            id: string;
            sensitivity: string;
            rank: string | number;
            cosine: string | number | null;
          }>(sql`
            SELECT id, sensitivity,
                   ${ftsRankEither(sql.raw("text_lemmatized"), sql.raw("text_lemmatized_es"), tsq)} AS rank,
                   ${lexicalCosine} AS cosine
              FROM ${sql.raw(target.sqlName)}
             WHERE workspace_id = ${query.workspaceId}
               ${live}
               ${owned}
               AND ${ftsMatchesEither(sql.raw("text_lemmatized"), sql.raw("text_lemmatized_es"), tsq)}
             ORDER BY rank DESC
             LIMIT ${query.limit}
          `)) as unknown as Array<{
            id: string;
            sensitivity: string;
            rank: string | number;
            cosine: string | number | null;
          }>;
          // RECALL-7: plainto_tsquery ANDs every term, so a natural-language
          // question ("How many times do we retry a failed card charge in
          // Atlas?") matched no decision while "card charge retry Atlas" did.
          // Same fallback the fact arm has: strict first, then any row matching
          // at least two of the question's distinct content terms.
          if (Array.from(rows).length === 0 && query.relaxedOnEmpty) {
            relaxedTerms ??= await relaxedContentTerms(tx, query.terms!);
            if (relaxedTerms.length >= 3) {
              const en = sql.raw("text_lemmatized");
              const es = sql.raw("text_lemmatized_es");
              const matches = relaxedTerms.map((term) => ftsMatchesEither(en, es, term));
              const matched = sql.join(
                matches.map((match) => sql`CASE WHEN ${match} THEN 1 ELSE 0 END`),
                sql` + `
              );
              const relaxedRank = sql.join(
                relaxedTerms.map((term) => ftsRankEither(en, es, term)),
                sql` + `
              );
              rows = (await tx.execute(sql`
                SELECT id, sensitivity, (${relaxedRank}) AS rank, ${lexicalCosine} AS cosine
                  FROM ${sql.raw(target.sqlName)}
                 WHERE workspace_id = ${query.workspaceId}
                   ${live}
                   ${owned}
                   AND (${sql.join(matches, sql` OR `)})
                   AND (${matched}) >= 2
                 ORDER BY rank DESC
                 LIMIT ${query.limit}
              `)) as unknown as Array<{
                id: string;
                sensitivity: string;
                rank: string | number;
                cosine: string | number | null;
              }>;
            }
          }
          for (const row of rows) {
            keep({
              id: row.id,
              kind: target.kind as PrimitiveCandidate["kind"],
              score: Number(row.rank),
              sensitivity: row.sensitivity as Sensitivity,
              lexicalRank: Number(row.rank),
              ...(row.cosine !== null && row.cosine !== undefined
                ? { similarity: Number(row.cosine) }
                : {}),
            });
          }
        }
      }

      return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, query.limit);
    });
  }

  /**
   * Federated items (mnemo_federated_item) as recall candidates. They have no
   * embedding, so only the lexical arm exists: the same strict-then-relaxed
   * match as the other kinds, over the statement the peer sent, through the
   * expression indexes of migration 0065. A tier outside the four the peer may
   * have sent reads as `restricted`, never as something more readable.
   */
  async federatedRecallCandidates(
    query: FederatedRecallQuery
  ): Promise<FederatedRecallCandidate[]> {
    if (query.terms.length === 0 || query.sensitivity.length === 0) return [];
    const tsq = query.terms.join(" ");
    // Spelled exactly as the 0065 index expressions, so the planner uses them.
    const en = sql`to_tsvector(${ftsConfig()}, payload->>'statement')`;
    const es = sql`to_tsvector(${ftsConfigEs()}, payload->>'statement')`;
    const tier = sql.raw(
      `CASE WHEN payload->>'sensitivity' IN ('public', 'internal', 'confidential', 'restricted')
            THEN payload->>'sensitivity' ELSE 'restricted' END`
    );
    const select = (match: SQL, rank: SQL) => sql`
      SELECT local_id::text AS id, peer_domain, payload->>'statement' AS statement,
             ${tier} AS sensitivity, payload->>'validFrom' AS valid_from,
             payload->>'validTo' AS valid_to, (${rank})::float8 AS rank
        FROM mnemosyne.mnemo_federated_item
       WHERE workspace_id = ${query.workspaceId}::uuid
         AND NOT archived
         AND ${tier} IN (${sql.join(
           query.sensitivity.map((s) => sql`${s}`),
           sql`, `
         )})
         AND ${match}
       ORDER BY rank DESC, local_id
       LIMIT ${query.limit}`;
    type Row = {
      id: string;
      peer_domain: string;
      statement: string;
      sensitivity: Sensitivity;
      valid_from: string | null;
      valid_to: string | null;
      rank: number;
    };

    const rows = await this.db.transaction(async (tx) => {
      // Both GUCs: the table's policy (baseline 0011) reads app.current_workspace_id.
      await tx.execute(sql`SELECT mnemo_set_workspace(${query.workspaceId}::uuid)`);
      await tx.execute(
        sql`SELECT set_config('app.current_workspace_id', ${query.workspaceId}, true)`
      );
      let found = (await tx.execute(
        select(ftsMatchesEither(en, es, tsq), ftsRankEither(en, es, tsq))
      )) as unknown as Row[];
      if (found.length === 0) {
        // RECALL-7: a natural-language question rarely contains every term.
        const terms = await relaxedContentTerms(tx, query.terms);
        if (terms.length >= 3) {
          const matches = terms.map((term) => ftsMatchesEither(en, es, term));
          const matched = sql.join(
            matches.map((m) => sql`CASE WHEN ${m} THEN 1 ELSE 0 END`),
            sql` + `
          );
          found = (await tx.execute(
            select(
              sql`(${sql.join(matches, sql` OR `)}) AND (${matched}) >= 2`,
              sql.join(
                terms.map((term) => ftsRankEither(en, es, term)),
                sql` + `
              )
            )
          )) as unknown as Row[];
        }
      }
      return Array.from(found);
    });
    return rows.map((row) => ({
      id: row.id,
      peerDomain: row.peer_domain,
      statement: row.statement,
      sensitivity: row.sensitivity,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      lexicalRank: Number(row.rank),
    }));
  }

  // ─── Consolidation admin lock (spec §12) ───────────────────────────────────

  /**
   * Admin lock-out: returns true when a row exists in mnemo_consolidation_lock
   * for the given workspace (spec §12 condition 6).
   */
  async isConsolidationLocked(workspaceId: string): Promise<boolean> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx.execute(
        sql`SELECT 1 FROM mnemosyne.mnemo_consolidation_lock
            WHERE workspace_id = ${workspaceId}::uuid
            LIMIT 1`
      );
    });
    return (rows as unknown[]).length > 0;
  }

  // ── Wave Y §25.1 — review queue + drift detection ────────────────────────────

  /**
   * `skipIfPending` makes the call idempotent for sweeps that re-flag the same
   * primitive on every run (governance demote, stale tasks): no new row while
   * one with the same primitive and reason is still pending. Event-driven
   * callers (contradictions, anomalies) leave it off, since each call there
   * carries its own detail.
   */
  async enqueueReviewItem(
    input: {
      workspaceId: string;
      primitiveId: string;
      primitiveKind?: string;
      reason: string;
      detail?: Record<string, unknown>;
    },
    opts: { skipIfPending?: boolean } = {}
  ): Promise<void> {
    const kind = input.primitiveKind ?? "fact";
    // ponytail: NOT EXISTS is not race-proof; two concurrent sweeps of one
    // workspace could both insert. The governance cron runs once a day.
    const onlyIfAbsent = opts.skipIfPending
      ? sql`WHERE NOT EXISTS (
          SELECT 1 FROM mnemosyne.mnemo_review_item
          WHERE workspace_id = ${input.workspaceId}::uuid
            AND primitive_id = ${input.primitiveId}
            AND primitive_kind = ${kind}
            AND reason = ${input.reason}
            AND status = 'pending')`
      : sql``;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_review_item (workspace_id, primitive_id, primitive_kind, reason, detail)
        SELECT ${input.workspaceId}::uuid, ${input.primitiveId}, ${kind}, ${input.reason}, ${JSON.stringify(input.detail ?? {})}::jsonb
        ${onlyIfAbsent}
      `);
    });
  }

  async queryDriftCandidates(workspaceId: string): Promise<
    Array<{
      id: string;
      statement: string;
      metadata: Record<string, unknown>;
      sensitivity: Sensitivity;
    }>
  > {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute<{
        id: string;
        statement: string;
        metadata: Record<string, unknown>;
        sensitivity: Sensitivity;
      }>(sql`
        SELECT id::text AS id, statement, metadata, sensitivity
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${workspaceId}
          AND valid_to IS NULL
          AND metadata->>'source_type' IN ('codebase', 'config', 'infrastructure')
      `);
      return Array.from(
        rows as unknown as Array<{
          id: string;
          statement: string;
          metadata: Record<string, unknown>;
          sensitivity: Sensitivity;
        }>
      );
    });
  }
}

// ─── Local helpers ────────────────────────────────────────────────────────────

/**
 * The distinct content terms a relaxed lexical fallback counts, or `[]` when
 * there are fewer than three: a term repeats a counted concept when either
 * language reduces it to a lexeme already seen ("chatbots" stems to "chatbot"
 * in English only). Shared by the fact and the non-fact lexical arms.
 */
async function relaxedContentTerms(
  tx: { execute: (query: SQL) => Promise<unknown> },
  terms: string[]
): Promise<string[]> {
  const normalizedTerms = recallContentTerms(terms);
  if (normalizedTerms.length < 3) return [];
  const lexemesSql = ftsTermLexemes(sql`term`);
  const lexemes = (await tx.execute(sql`
    SELECT term,
      ${lexemesSql.en} AS en,
      ${lexemesSql.es} AS es
    FROM (VALUES ${sql.join(
      normalizedTerms.map((term) => sql`(${term})`),
      sql`, `
    )}) AS terms(term)
  `)) as Array<{ term: string; en: string; es: string }>;
  const seenEn = new Set<string>();
  const seenEs = new Set<string>();
  const contentTerms = lexemes.flatMap(({ term, en, es }) => {
    if (!en && !es) return [];
    if ((en && seenEn.has(en)) || (es && seenEs.has(es))) return [];
    if (en) seenEn.add(en);
    if (es) seenEs.add(es);
    return [term];
  });
  return contentTerms.length >= 3 ? contentTerms : [];
}

function factHashRowToDomain(
  row: typeof schema.factHashTable.$inferSelect
): import("@mnemo-ai/types").MnemoFactHash {
  return {
    workspaceId: row.workspaceId,
    statementHash: row.statementHash,
    factId: row.factId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    seenCount: row.seenCount,
  };
}

function stdpUpdate(input: { weight: number; directionality: number; deltaSeconds: number }): {
  weight: number;
  directionality: number;
} {
  const dt = input.deltaSeconds;
  const deltaWeight = dt >= 0 ? 0.1 * Math.exp(-dt / 20) : -0.12 * Math.exp(dt / 20);
  return {
    weight: Math.max(0, Math.min(1, input.weight + deltaWeight)),
    directionality: Math.max(0, Math.min(1, 0.9 * input.directionality + 0.1 * (dt >= 0 ? 1 : 0))),
  };
}
