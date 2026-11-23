-- migrate:allow-type-change reason=unconstrain_halfvec_columns_for_multi_dimension_support
--
-- Migration 0009: Unconstrain halfvec/vector embedding columns for multi-dimension
-- support (Bedrock/Titan 1024, OpenAI text-embedding-3-small 1536, future
-- 2048/4096). Migration 0010 restores dimension-scoped HNSW indexes.
--
-- ROOT CAUSE (measured on pgvector 0.8.2 / Postgres 17, see
-- docs/superpowers/plans/2026-07-22-merge-fallout-remediation.md, Execution
-- notes, Task 1 + Task 2):
--   * mnemo_reminder.condition_embedding's HNSW index is PARTIAL
--     (WHERE condition_embedding IS NOT NULL AND status = 'pending'). Rebuilding
--     a partial HNSW index during ALTER TYPE ... TYPE public.halfvec (dropping
--     the fixed dimension) fails with "ERROR: column does not have dimensions".
--   * mnemo_decision.embedding and mnemo_query_cache.query_embedding start out
--     as `public.vector(1536)`, not `halfvec(1536)`. Their HNSW indexes use
--     `vector_cosine_ops`, which is incompatible with the target `halfvec` type:
--     ALTER TYPE fails with "ERROR: operator class "vector_cosine_ops" does not
--     accept data type halfvec". Their indexes must be dropped regardless of
--     partial/plain shape.
--   * The other 5 baseline HNSW indexes (mnemo_fact, mnemo_reasoning,
--     mnemo_hyperedge, mnemo_skill, mnemo_strategy) are plain halfvec indexes
--     and their ALTER TYPE succeeds without dropping them first.
--
-- DESIGN FORK: Option A (drop only the 3 indexes strictly required to make the
-- ALTERs succeed, keep the other 5 baseline HNSW indexes) vs. Option B (drop
-- all 8 baseline embedding HNSW indexes). Resolved empirically in favor of
-- OPTION B:
--   A live probe against Option A confirmed the ALTERs succeed and the 5
--   surviving plain HNSW indexes (fact/reasoning/hyperedge/skill/strategy)
--   remain valid and get used by the planner for same-dimension queries
--   (EXPLAIN with enable_seqscan=off picks `idx_mnemo_fact_embedding_hnsw`).
--   BUT: once a plain (non-partial, non-dimension-scoped) HNSW index has
--   indexed one vector dimension, pgvector REJECTS an insert of a different
--   dimension into that same indexed column: inserting a 1024-dim vector after
--   a 1536-dim vector already exists on mnemo_fact.embedding (or
--   mnemo_reasoning.embedding) fails with "ERROR: different halfvec dimensions
--   1024 and 1536". This was confirmed to be caused specifically by the
--   surviving index: the same insert sequence on mnemo_decision (whose index
--   was already dropped by Option A too) succeeds for both dimensions. This is
--   exactly the deployment-blocking failure mode this migration exists to fix
--   (switching an embedding provider / dimension on a live table with data of
--   the old dimension already present), so per the decision rule Option B
--   (predictable, uniformly unconstrained, no index silently pins the first
--   dimension seen) is the correct choice. Migration 0010 recreates indexed
--   search via dimension-scoped partial expression HNSW indexes instead.
--
-- SCOPE NOTE: also drops idx_entity_embedding_hnsw. It was not one of the 8
-- indexes created by baseline 0001 (it was added later by migration 0004,
-- `0004_entity_embedding.sql`, as a plain halfvec_cosine_ops HNSW index with
-- the identical shape to the other 5 "survives ALTER TYPE" indexes above) and
-- was therefore missing from the original index inventory. It exhibits the
-- exact same mixed-dimension-INSERT-rejection behavior confirmed above
-- (verified empirically: a 1536-dim mnemo_entity.embedding insert followed by
-- a 1024-dim insert fails with "different halfvec dimensions" while the index
-- is present). Left undropped it would silently reintroduce the very bug this
-- migration exists to fix, just on mnemo_entity instead of mnemo_fact.

DROP INDEX IF EXISTS mnemosyne.idx_entity_embedding_hnsw;
DROP INDEX IF EXISTS mnemosyne.idx_hyperedge_context_hnsw;
DROP INDEX IF EXISTS mnemosyne.idx_mnemo_dec_embedding_hnsw;
DROP INDEX IF EXISTS mnemosyne.idx_mnemo_fact_embedding_hnsw;
DROP INDEX IF EXISTS mnemosyne.idx_mnemo_qc_embedding_hnsw;
DROP INDEX IF EXISTS mnemosyne.idx_mnemo_reminder_condition_embedding;
DROP INDEX IF EXISTS mnemosyne.idx_reasoning_embedding_hnsw;
DROP INDEX IF EXISTS mnemosyne.idx_skill_embedding_hnsw;
DROP INDEX IF EXISTS mnemosyne.idx_strategy_embedding_hnsw;

ALTER TABLE mnemosyne.mnemo_fact        ALTER COLUMN embedding           TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_reasoning   ALTER COLUMN embedding           TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_entity      ALTER COLUMN embedding           TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_episode     ALTER COLUMN embedding           TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_hyperedge   ALTER COLUMN context_embedding   TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_skill       ALTER COLUMN embedding           TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_strategy    ALTER COLUMN embedding           TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_reminder    ALTER COLUMN condition_embedding TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_decision    ALTER COLUMN embedding           TYPE public.halfvec;
ALTER TABLE mnemosyne.mnemo_query_cache ALTER COLUMN query_embedding     TYPE public.halfvec;
