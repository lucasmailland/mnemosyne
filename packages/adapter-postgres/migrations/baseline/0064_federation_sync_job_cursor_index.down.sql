-- migrate:no-transaction
-- Reverts 0064.
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_mnemo_fed_sync_job_peer_completed;
