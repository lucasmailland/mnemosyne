-- migrate:allow-drop reason=reverts the similarity column added by 0072 (telemetry only, no reader depends on it)
-- migrate:allow-non-concurrent-index reason=indexes belong to the materialized views this rollback recreates; nothing can read them before commit
-- Down 0072: restore the pre-0072 anticipation views and drop similarity.
SET LOCAL lock_timeout = '5s';

DROP MATERIALIZED VIEW mnemosyne.mv_sequential_patterns;
DROP MATERIALIZED VIEW mnemosyne.mv_periodic_patterns;

CREATE MATERIALIZED VIEW mnemosyne.mv_sequential_patterns AS
 WITH ordered AS (
         SELECT mnemo_recall_log.workspace_id,
            mnemo_recall_log.fact_id,
            mnemo_recall_log.recalled_at
           FROM mnemosyne.mnemo_recall_log
          WHERE ((mnemo_recall_log.recalled_at > (now() - '30 days'::interval)) AND (mnemo_recall_log.fact_id IS NOT NULL))
        ), pairs AS (
         SELECT a.workspace_id,
            a.fact_id AS predecessor_id,
            b.fact_id AS successor_id,
            (EXTRACT(epoch FROM (b.recalled_at - a.recalled_at)))::integer AS lag_seconds
           FROM (ordered a
             JOIN ordered b ON (((a.workspace_id = b.workspace_id) AND (b.recalled_at > a.recalled_at) AND (b.recalled_at <= (a.recalled_at + (COALESCE(current_setting('mnemosyne.anticipation_successor_window'::text, true), '5 minutes'::text))::interval)) AND (a.fact_id <> b.fact_id))))
        ), pair_counts AS (
         SELECT pairs.workspace_id,
            pairs.predecessor_id,
            pairs.successor_id,
            (count(*))::integer AS support,
            (avg(pairs.lag_seconds))::integer AS avg_lag_seconds
           FROM pairs
          GROUP BY pairs.workspace_id, pairs.predecessor_id, pairs.successor_id
         HAVING (count(*) >= 5)
        ), pred_totals AS (
         SELECT pair_counts.workspace_id,
            pair_counts.predecessor_id,
            (sum(pair_counts.support))::integer AS total_outgoing
           FROM pair_counts
          GROUP BY pair_counts.workspace_id, pair_counts.predecessor_id
        )
 SELECT pc.workspace_id,
    pc.predecessor_id,
    pc.successor_id,
    pc.support,
    pc.avg_lag_seconds,
    round(((pc.support)::numeric / (pt.total_outgoing)::numeric), 4) AS confidence
   FROM (pair_counts pc
     JOIN pred_totals pt ON (((pt.workspace_id = pc.workspace_id) AND (pt.predecessor_id = pc.predecessor_id))))
  WHERE (((pc.support)::numeric / (pt.total_outgoing)::numeric) >= 0.30);

CREATE MATERIALIZED VIEW mnemosyne.mv_periodic_patterns AS
 WITH base AS (
         SELECT mnemo_recall_log.workspace_id,
            mnemo_recall_log.fact_id,
            (EXTRACT(dow FROM (mnemo_recall_log.recalled_at AT TIME ZONE 'UTC'::text)))::integer AS day_of_week,
            ((EXTRACT(hour FROM (mnemo_recall_log.recalled_at AT TIME ZONE 'UTC'::text)))::integer / 3) AS hour_bucket,
            date_trunc('week'::text, (mnemo_recall_log.recalled_at AT TIME ZONE 'UTC'::text)) AS week_bucket,
            mnemo_recall_log.recalled_at
           FROM mnemosyne.mnemo_recall_log
          WHERE ((mnemo_recall_log.recalled_at > (now() - (COALESCE(current_setting('mnemosyne.anticipation_periodic_window'::text, true), '90 days'::text))::interval)) AND (mnemo_recall_log.fact_id IS NOT NULL))
        ), totals AS (
         SELECT base.workspace_id,
            base.fact_id,
            (count(*))::integer AS total
           FROM base
          GROUP BY base.workspace_id, base.fact_id
        ), slot AS (
         SELECT base.workspace_id,
            base.fact_id,
            base.day_of_week,
            base.hour_bucket,
            (count(*))::integer AS slot_recalls,
            (count(DISTINCT base.week_bucket))::integer AS distinct_weeks
           FROM base
          GROUP BY base.workspace_id, base.fact_id, base.day_of_week, base.hour_bucket
        )
 SELECT s.workspace_id,
    s.fact_id AS memory_id,
    s.day_of_week,
    s.hour_bucket,
    s.slot_recalls,
    s.distinct_weeks,
    round(((s.slot_recalls)::numeric / (t.total)::numeric), 4) AS slot_share
   FROM (slot s
     JOIN totals t USING (workspace_id, fact_id))
  WHERE ((s.distinct_weeks >= 3) AND (((s.slot_recalls)::numeric / (t.total)::numeric) >= 0.20));

CREATE UNIQUE INDEX uq_mv_sequential_patterns ON mnemosyne.mv_sequential_patterns USING btree (workspace_id, predecessor_id, successor_id);
CREATE INDEX idx_mv_sequential_patterns_pred ON mnemosyne.mv_sequential_patterns USING btree (workspace_id, predecessor_id, confidence DESC);
CREATE UNIQUE INDEX uq_mv_periodic_patterns ON mnemosyne.mv_periodic_patterns USING btree (workspace_id, memory_id, day_of_week, hour_bucket);
CREATE INDEX idx_mv_periodic_patterns_slot ON mnemosyne.mv_periodic_patterns USING btree (workspace_id, day_of_week, hour_bucket, slot_share DESC);
GRANT SELECT ON TABLE mnemosyne.mv_sequential_patterns TO mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mv_periodic_patterns TO mnemo_app_role;

ALTER TABLE mnemosyne.mnemo_recall_log DROP COLUMN similarity;
