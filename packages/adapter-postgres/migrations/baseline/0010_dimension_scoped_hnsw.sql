-- migrate:no-transaction
-- Migration 0010: Restore HNSW indexes as dimension-scoped partial expression indexes.
--
-- CONCURRENTLY cannot run inside a transaction (spec §35 line 4031), so this
-- file runs outside one.
--
-- If a CONCURRENTLY build fails midway, Postgres leaves the index INVALID and
-- IF NOT EXISTS will NOT rebuild it on retry (it matches by name only).
-- Recovery: SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- DROP INDEX the invalid one, DELETE this file's row from
-- mnemosyne.schema_migrations, and re-run migrate.
--
-- 0009 unconstrained the halfvec embedding columns, which required dropping the
-- fixed-dimension HNSW indexes (a plain HNSW index on an unconstrained halfvec
-- column pins the first dimension inserted and rejects all others -- see the
-- 2026-07-22 merge-fallout plan, Task 2 experiment). This migration restores
-- indexed cosine search on the hot column (mnemo_fact.embedding) for the two
-- dimensions in production use: OpenAI text-embedding-3-small (1536) and
-- Bedrock Titan/Cohere (1024). Each index covers only rows of its dimension,
-- so mixed-dimension workspaces coexist and INSERTs of either size work.
--
-- The planner uses these when the query casts to the same fixed dimension and
-- carries a matching public.vector_dims() predicate (adapter change lands
-- separately). vector_dims is schema-qualified here (like every pgvector type
-- and opclass reference in this migration set) because migration 0001 runs
-- `SELECT pg_catalog.set_config('search_path', '', false)`, which persists
-- for the rest of the migrate session (a single reused connection) and makes
-- unqualified function/opclass names unresolvable.
-- The other 8 formerly-indexed embedding columns (reasoning, entity, hyperedge,
-- skill, strategy, reminder, decision, query_cache) intentionally stay
-- unindexed: they are cold-path or low-volume lookups, and each new dimension
-- would multiply index count; revisit per-column if profiling says otherwise.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_fact_embedding_hnsw_1536
  ON mnemosyne.mnemo_fact
  USING hnsw ((embedding::public.halfvec(1536)) public.halfvec_cosine_ops)
  WITH (m='16', ef_construction='64')
  WHERE public.vector_dims(embedding) = 1536;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_fact_embedding_hnsw_1024
  ON mnemosyne.mnemo_fact
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops)
  WITH (m='16', ef_construction='64')
  WHERE public.vector_dims(embedding) = 1024;
