-- migrate:no-transaction
-- Reverts 0065. Recall still works without them, scanning instead.
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_federated_item_fts_es;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_federated_item_fts;
