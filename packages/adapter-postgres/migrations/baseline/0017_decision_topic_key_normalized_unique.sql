-- migrate:no-transaction

-- Migration 0017: normalize the decision topic_key uniqueness check.
--
-- DECIDE-1 (docs/STATUS.md memory_decide finding, 2026-07-28): the tool's own
-- description promises the upsert is "idempotente por topic_key normalizado",
-- but createDecision()'s lookup (packages/core/src/primitives/decision.ts)
-- was a raw eq() on the literal topic_key string, and this unique index was a
-- plain btree over the raw column -- neither normalized anything.
-- topicKey:"Auth-Strategy" followed by "auth-strategy" (or the same string
-- with a trailing space) created a SECOND independent active decision
-- instead of upserting the first.
--
-- Fixed at both layers: the application-level upsert lookup now compares
-- lower(btrim(topic_key)) (see decision.ts), and this index is rebuilt as an
-- expression index over the same normalized form, so concurrent writes with
-- differently-cased/whitespaced topic_key values that race past the
-- application-level SELECT still collide at the DB level instead of
-- silently creating duplicate active decisions.
--
-- Does NOT rewrite already-stored topic_key values -- only the matching
-- logic is case/whitespace-insensitive now; a decision's stored topic_key
-- keeps whatever casing its creating caller supplied.
--
-- CONCURRENTLY (same shape as 0007_fact_topic_key_unique.sql's precedent for
-- mnemo_fact): mnemo_decision is a pre-existing table, so a plain CREATE
-- INDEX would take a ShareLock and block writes for the build's duration.

DO $$
DECLARE
  duplicate_workspace uuid;
  duplicate_topic text;
  duplicate_count bigint;
BEGIN
  SELECT workspace_id, lower(btrim(topic_key)), COUNT(*)
    INTO duplicate_workspace, duplicate_topic, duplicate_count
  FROM mnemosyne.mnemo_decision
  WHERE topic_key IS NOT NULL AND status = 'active' AND valid_to IS NULL
  GROUP BY workspace_id, lower(btrim(topic_key))
  HAVING COUNT(*) > 1
  ORDER BY workspace_id, lower(btrim(topic_key))
  LIMIT 1;

  IF duplicate_workspace IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create uniq_mnemo_decision_topic (normalized): existing active decisions already collide once case/whitespace-normalized (workspace_id=%, normalized_topic_key=%, count=%). Resolve the duplicate active decisions for this topic before re-running.',
      duplicate_workspace, duplicate_topic, duplicate_count
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

-- An interrupted concurrent build can leave this fixed-name index INVALID.
-- Drop it first so rerunning this unrecorded migration always rebuilds it.
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.uniq_mnemo_decision_topic;

CREATE UNIQUE INDEX CONCURRENTLY uniq_mnemo_decision_topic
  ON mnemosyne.mnemo_decision (workspace_id, lower(btrim(topic_key)))
  WHERE topic_key IS NOT NULL AND status = 'active' AND valid_to IS NULL;
