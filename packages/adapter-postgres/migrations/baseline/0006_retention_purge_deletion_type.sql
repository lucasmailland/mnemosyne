-- Migration 0006: Extend mnemo_deletion_log.deletion_type CHECK to include 'retention_purge'
--
-- SOC2 CF3 — The retention-purge cron appends one summary row per (workspace, run)
-- with deletion_type='retention_purge'. This migration widens the 4-value CHECK
-- constraint to a 5-value set so those inserts are accepted.
--
-- This migration CAN run inside a transaction (no CONCURRENTLY, no ALTER TYPE).

ALTER TABLE mnemosyne.mnemo_deletion_log
  DROP CONSTRAINT mnemo_deletion_log_deletion_type_check;

ALTER TABLE mnemosyne.mnemo_deletion_log
  ADD CONSTRAINT mnemo_deletion_log_deletion_type_check
  CHECK (deletion_type = ANY (ARRAY['soft'::text, 'hard'::text, 'gdpr_erasure'::text, 'federation_tombstone'::text, 'retention_purge'::text]));

-- migrate:down
-- ALTER TABLE mnemosyne.mnemo_deletion_log
--   DROP CONSTRAINT mnemo_deletion_log_deletion_type_check;
-- ALTER TABLE mnemosyne.mnemo_deletion_log
--   ADD CONSTRAINT mnemo_deletion_log_deletion_type_check
--   CHECK (deletion_type = ANY (ARRAY['soft'::text, 'hard'::text, 'gdpr_erasure'::text, 'federation_tombstone'::text]));
