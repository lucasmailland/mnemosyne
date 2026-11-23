-- migrate:no-transaction
--
-- Legacy continuity uses the existing source tuple, with source_host NULL.
-- Managed sessions retain their independent fencing and generation constraints.
-- The indexes are built CONCURRENTLY so they don't block writes to the
-- existing mnemo_session and mnemo_session_turn tables. Outside a transaction
-- every statement must be safe to rerun: the columns use IF NOT EXISTS, and an
-- interrupted concurrent build leaves an INVALID index that IF NOT EXISTS would
-- skip (it matches by name only), so each index is dropped first (as 0058).
ALTER TABLE mnemosyne.mnemo_session ADD COLUMN IF NOT EXISTS continuity_root_id text;
ALTER TABLE mnemosyne.mnemo_session_turn ADD COLUMN IF NOT EXISTS continuity_root_id text;

DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_legacy_source_generation_unique;
CREATE UNIQUE INDEX CONCURRENTLY idx_session_legacy_source_generation_unique
  ON mnemosyne.mnemo_session(workspace_id, source_client_instance_id, source_session_id, source_generation)
  WHERE source_host IS NULL AND source_client_instance_id IS NOT NULL AND source_session_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_legacy_successor_unique;
CREATE UNIQUE INDEX CONCURRENTLY idx_session_legacy_successor_unique
  ON mnemosyne.mnemo_session(workspace_id, predecessor_session_id)
  WHERE source_host IS NULL AND predecessor_session_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_session_turn_legacy_occurrence_unique;
CREATE UNIQUE INDEX CONCURRENTLY idx_session_turn_legacy_occurrence_unique
  ON mnemosyne.mnemo_session_turn(workspace_id, continuity_root_id, source_message_id)
  WHERE continuity_root_id IS NOT NULL AND source_message_id IS NOT NULL;
