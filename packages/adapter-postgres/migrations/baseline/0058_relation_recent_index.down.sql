-- migrate:no-transaction
-- Reverts 0058.
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_mnemo_rel_ws_created;
