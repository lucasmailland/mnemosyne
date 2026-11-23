-- migrate:allow-drop reason=reverts columns added by 0058; refuses (RAISE) before dropping if any row would lose data
-- migrate:allow-type-change reason=restores memory_id to uuid; guarded by the non-UUID check below
-- Down 0058. Refuses rather than lose non-fact or non-UUID memory ids.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_recall_log
     WHERE fact_id IS NULL
        OR primitive_kind IS DISTINCT FROM 'fact'
        OR (memory_id IS NOT NULL AND memory_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'cannot roll back 0058: recall log has non-fact or non-UUID memory ids'
      USING ERRCODE = 'data_exception';
  END IF;
END $$;

DROP INDEX IF EXISTS mnemosyne.uq_mnemo_recall_log_request_rank;
DROP INDEX IF EXISTS mnemosyne.idx_mnemo_recall_log_memory_time;
ALTER TABLE mnemosyne.mnemo_recall_log DROP CONSTRAINT IF EXISTS mnemo_recall_log_request_fkey;
ALTER TABLE mnemosyne.mnemo_recall_log
    DROP COLUMN request_id,
    DROP COLUMN primitive_kind,
    ALTER COLUMN memory_id TYPE uuid USING memory_id::uuid,
    ALTER COLUMN fact_id SET NOT NULL;
CREATE INDEX idx_mnemo_recall_log_memory_time ON mnemosyne.mnemo_recall_log
    USING btree (workspace_id, memory_id, recalled_at DESC) WHERE (memory_id IS NOT NULL);
DROP TABLE mnemosyne.mnemo_recall_request;
