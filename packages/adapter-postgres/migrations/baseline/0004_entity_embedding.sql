-- migrate:no-transaction
-- P16: Add embedding columns to mnemo_entity and create HNSW cosine index.
-- CONCURRENTLY index cannot run inside a transaction; this file runs outside one.

ALTER TABLE mnemosyne.mnemo_entity
  ADD COLUMN IF NOT EXISTS embedding public.halfvec(1536),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_stale boolean NOT NULL DEFAULT false;

-- Mark all pre-existing rows as stale so the OutboxWorker picks them up.
UPDATE mnemosyne.mnemo_entity SET embedding_stale = true WHERE embedding IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_embedding_hnsw
  ON mnemosyne.mnemo_entity
  USING hnsw (embedding public.halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
