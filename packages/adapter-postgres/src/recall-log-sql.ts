/**
 * Pure SQL builder for recall log inserts (C4).
 *
 * Keeps fact_id as TEXT (not cast to ::uuid) and writes both
 * activation_score and recall_score to satisfy the ACT-R read path.
 */
import { sql } from "drizzle-orm";
import type { RecallHitObservation, RecallRequestObservation } from "@mnemo-ai/types";

/** Synthetic/test traffic is recorded but never reinforces memories. */
export const isOrganicRecall = (o: string): boolean => o !== "synthetic" && o !== "test";

/**
 * Conflict-safe request insert; RETURNING is empty when the request was replayed.
 * A retry reuses X-Request-Id, so an error-only attempt (which never has hits)
 * is upgraded by a later completed attempt — that one returns the row and its
 * hits/counters are recorded. A completed request is never overwritten.
 */
export function recallRequestInsertSql(r: RecallRequestObservation) {
  // queryText never enters the request row: only the hash is request metadata.
  const { workspaceId, requestId, queryHash, status, totalDurationMs, queryText: _q, ...rest } = r;
  const meta = JSON.stringify({ ...rest, totalDurationMs });
  return sql`INSERT INTO mnemosyne.mnemo_recall_request
      (workspace_id, request_id, request_metadata, query_hash, status, duration_ms)
    VALUES (${workspaceId}::uuid, ${requestId}, ${meta}::jsonb, ${queryHash}, ${status},
      ${Math.round(totalDurationMs)}::int)
    ON CONFLICT (workspace_id, request_id) DO UPDATE SET
      request_metadata = EXCLUDED.request_metadata, query_hash = EXCLUDED.query_hash,
      status = EXCLUDED.status, duration_ms = EXCLUDED.duration_ms, created_at = NOW()
    WHERE mnemo_recall_request.status = 'error' AND EXCLUDED.status <> 'error'
    RETURNING request_id`;
}

/**
 * One hit insert; organic fact hits also bump the counters in the same statement.
 * The ranking score fills activation_score/recall_score; the raw cosine of a
 * semantic/hybrid hit is kept apart in `similarity` (NULL when not measured).
 * mnemo_fact.workspace_id is TEXT (mnemo_recall_log's is uuid): comparing it to
 * a ::uuid parameter raises `text = uuid` and rolls back the whole observation.
 */
export function recallHitInsertSql(
  h: RecallHitObservation,
  sessionId: string | null,
  organic: boolean,
  /** Request wall-clock latency; feeds mnemo_metacognition_trends(). */
  latencyMs: number | null = null,
  /**
   * Raw query, kept on organic fact rows only — the same column the legacy
   * writer filled. Consolidation replay (getRecentQueriesForFacts) and
   * mv_conditional_patterns read it; synthetic/test traffic never feeds them.
   */
  queryText: string | null = null
) {
  const isFact = h.primitiveKind === "fact";
  const qt = isFact && organic && queryText ? queryText : null;
  const ins = sql`INSERT INTO mnemosyne.mnemo_recall_log
      (workspace_id, request_id, primitive_kind, memory_id, fact_id, session_id, query_text,
       hit_rank, activation_score, recall_score, similarity, td_credit, latency_ms, recalled_at)
    VALUES (${h.workspaceId}::uuid, ${h.requestId}, ${h.primitiveKind}, ${h.memoryId},
      ${isFact ? h.memoryId : null}, ${sessionId}, ${qt}, ${h.rank}::int,
      ${h.score.toString()}, ${h.score}::real,
      ${h.similarity !== undefined && Number.isFinite(h.similarity) ? h.similarity : null}::real,
      ${isFact ? String(h.tdCredit ?? 0) : "0"},
      ${latencyMs === null || !Number.isFinite(latencyMs) ? null : Math.max(0, Math.round(latencyMs))}::int, NOW())
    ON CONFLICT (workspace_id, request_id, hit_rank)
      WHERE request_id IS NOT NULL AND hit_rank IS NOT NULL DO NOTHING`;
  if (!(isFact && organic)) return ins;
  return sql`WITH ins AS (${ins} RETURNING fact_id)
    UPDATE mnemosyne.mnemo_fact SET hit_count = hit_count + 1, last_recalled_at = NOW()
    WHERE workspace_id = ${h.workspaceId}::text AND id IN (SELECT fact_id FROM ins)`;
}

/**
 * Activation-history guard for reads of mnemo_recall_log: rows written by a
 * synthetic/test request stay as telemetry but never feed Petrov activation.
 * Legacy rows (request_id NULL) are organic.
 */
export const organicRecallLogRow = sql.raw(`NOT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_recall_request rr
     WHERE rr.workspace_id = mnemo_recall_log.workspace_id
       AND rr.request_id = mnemo_recall_log.request_id
       AND rr.request_metadata->>'trafficOrigin' IN ('synthetic', 'test'))`);

export function buildLogRecallInsert(
  workspaceId: string,
  factId: string,
  score: number
): { text: string; params: unknown[] } {
  return {
    text: `INSERT INTO mnemosyne.mnemo_recall_log
             (workspace_id, fact_id, activation_score, recall_score, recalled_at)
           VALUES ($1::uuid, $2, $3, $4, NOW())`,
    params: [workspaceId, factId, score.toString(), score.toString()],
  };
}
