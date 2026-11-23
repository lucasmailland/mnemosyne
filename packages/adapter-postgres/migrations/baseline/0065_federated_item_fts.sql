-- migrate:no-transaction
--
-- Migration 0065: recall reads the items a federation sync brought in
-- (mnemo_federated_item). They carry no embedding, so recall matches their
-- statement lexically, in both FTS configurations (0035/0036), like every other
-- kind. Without these indexes each recall would build two tsvectors for every
-- federated item of the workspace. Expression indexes, so the payload stays the
-- only copy of the statement; RecallRepository.federatedRecallCandidates spells
-- the same expressions. CONCURRENTLY, so the build doesn't block a running sync.

-- An interrupted concurrent build leaves an INVALID index that IF NOT EXISTS
-- would skip on the rerun; drop first so a rerun always rebuilds (as 0058).
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_federated_item_fts;
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_federated_item_fts_es;

CREATE INDEX CONCURRENTLY idx_federated_item_fts
  ON mnemosyne.mnemo_federated_item
  USING gin (to_tsvector('mnemosyne.mnemo_fts'::regconfig, payload->>'statement'))
  WHERE NOT archived;

CREATE INDEX CONCURRENTLY idx_federated_item_fts_es
  ON mnemosyne.mnemo_federated_item
  USING gin (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, payload->>'statement'))
  WHERE NOT archived;
