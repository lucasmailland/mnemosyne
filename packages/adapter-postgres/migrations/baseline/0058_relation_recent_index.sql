-- migrate:no-transaction
--
-- Migration 0058: GET /relations lists a workspace's relations newest first.
-- Under a sensitivity ceiling each candidate row also pays an endpoint check
-- (GraphRepository.getRelations), and with no index in that order Postgres
-- checked every relation in the workspace before taking the page. Ordered by
-- created_at, the scan stops once the page is full of readable rows.
-- CONCURRENTLY, so the build doesn't block writes to mnemo_relation.

-- An interrupted concurrent build leaves this fixed-name index INVALID, and
-- IF NOT EXISTS would skip it on the rerun (it matches by name only). Drop it
-- first so rerunning this unrecorded migration always rebuilds it (as 0007).
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_mnemo_rel_ws_created;

CREATE INDEX CONCURRENTLY idx_mnemo_rel_ws_created
  ON mnemosyne.mnemo_relation USING btree (workspace_id, created_at DESC);
