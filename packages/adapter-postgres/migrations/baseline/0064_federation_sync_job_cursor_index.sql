-- migrate:no-transaction
--
-- Migration 0064: each federation sync resumes where the previous sync from
-- the same peer into the same workspace stopped. DrizzleSyncJobStore.lastCursor
-- reads the latest finished job of (workspace_id, peer_id) by completed_at, and
-- a workspace keeps every job it ever ran. This index serves that lookup
-- without scanning the workspace's job history.
-- CONCURRENTLY, so the build doesn't block writes to mnemo_federation_sync_job.

-- An interrupted concurrent build leaves this fixed-name index INVALID, and
-- IF NOT EXISTS would skip it on the rerun (it matches by name only). Drop it
-- first so rerunning this unrecorded migration always rebuilds it (as 0058).
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_mnemo_fed_sync_job_peer_completed;

CREATE INDEX CONCURRENTLY idx_mnemo_fed_sync_job_peer_completed
  ON mnemosyne.mnemo_federation_sync_job
  USING btree (workspace_id, peer_id, completed_at DESC NULLS LAST);
