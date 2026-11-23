-- migrate:no-transaction

DO $$
DECLARE
  duplicate_workspace text;
  duplicate_topic text;
  duplicate_count bigint;
BEGIN
  SELECT workspace_id, topic_key, COUNT(*)
    INTO duplicate_workspace, duplicate_topic, duplicate_count
  FROM mnemosyne.mnemo_fact
  WHERE topic_key IS NOT NULL AND status = 'active'
  GROUP BY workspace_id, topic_key
  HAVING COUNT(*) > 1
  ORDER BY workspace_id, topic_key
  LIMIT 1;

  IF duplicate_workspace IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create idx_fact_topic_active_unique: duplicate active fact topic key (workspace_id=%, topic_key=%, count=%)',
      duplicate_workspace, duplicate_topic, duplicate_count
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

-- An interrupted concurrent build can leave this fixed-name index INVALID.
-- Drop it first so rerunning this unrecorded migration always rebuilds it.
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_fact_topic_active_unique;

CREATE UNIQUE INDEX CONCURRENTLY idx_fact_topic_active_unique
  ON mnemosyne.mnemo_fact (workspace_id, topic_key)
  WHERE topic_key IS NOT NULL AND status = 'active';
