-- migrate:no-transaction
-- migrate:allow-drop reason=drop+re-add is the only way to change a GENERATED
--   column's expression; Postgres has no ALTER ... ALTER GENERATED clause.
--
-- Migration 0029: align mnemo_decision.text_lemmatized to the 'english' text
-- search configuration (make-primitives-recallable, design.md D3).
--
-- ============================================================================
-- OPERATIONAL WARNING — READ BEFORE RUNNING
--
-- The ALTER TABLE ... ADD COLUMN ... GENERATED ... STORED statement below
-- REWRITES THE ENTIRE mnemo_decision TABLE and holds an ACCESS EXCLUSIVE
-- lock on mnemo_decision for the full duration of that rewrite. All reads
-- AND writes against mnemo_decision block until it completes. Postgres has
-- no online/concurrent path for adding a STORED generated column -- this is
-- unavoidable, not a bug in this migration.
--
-- RUN THIS IN A LOW-TRAFFIC WINDOW. Before running, capture a baseline row
-- count for a sanity check after: SELECT count(*) FROM mnemosyne.mnemo_decision;
--
-- Safe today because mnemo_decision is small and text_lemmatized is a
-- provably-dead column (nothing queries it yet -- see design.md's
-- root-cause correction: both FTS arms are fact-only pre-PR3 of this
-- change). Re-assess this migration's blast radius before any deployment
-- with a materially larger mnemo_decision table.
--
-- The two index statements (DROP/CREATE INDEX CONCURRENTLY) are online and
-- do not block reads or writes; only the column drop+re-add is blocking.
-- Rollout order for this change is migrate -> deploy -> backfill (see
-- scripts/backfill-decision-embeddings.mjs). This file is FORWARD-ONLY (no
-- .down.sql): reverting would restore a knowingly-broken 'simple' config,
-- and pre-1.0 there is no backward-compat obligation to preserve it.
-- ============================================================================
--
-- Before: text_lemmatized GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || body)) STORED
--   'simple' does no stemming and keeps stopwords -- a query for "caching
--   strategies" would miss a body saying "caching strategy", and ts_rank
--   values from a 'simple'-config column are not comparable to mnemo_fact's
--   'english'-config column (mnemo_fact.text_lemmatized, baseline 0001:1244),
--   which breaks the spec's "rank is comparable to a fact hit" scenario.
-- After:  text_lemmatized GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
--   Matches mnemo_fact's configuration exactly, so ts_rank scores across the
--   two tables become comparable and English stemming applies to decisions
--   the same way it already does to facts.

-- 1) Drop the index first: it depends on the generated column we're about to
--    drop, and dropping it CONCURRENTLY here (rather than implicitly via
--    CASCADE on the column drop) keeps this migration's DDL each explicit
--    and online except for the one unavoidable step below.
DROP INDEX CONCURRENTLY IF EXISTS mnemosyne.idx_mnemo_dec_fts;

-- 2) Drop the 'simple'-config generated column. Immediate (catalog-only) --
--    the ACCESS EXCLUSIVE window is entirely in step 3's re-add.
ALTER TABLE mnemosyne.mnemo_decision
  DROP COLUMN IF EXISTS text_lemmatized;

-- 3) Re-add as an 'english'-config generated column. THIS is the statement
--    that rewrites the table under ACCESS EXCLUSIVE -- see the warning above.
ALTER TABLE mnemosyne.mnemo_decision
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(title, ''::text) || ' '::text) || COALESCE(body, ''::text))
  ) STORED;

-- 4) Rebuild the GIN index online. Safe to run even though the column is
--    freshly populated by step 3's rewrite -- CONCURRENTLY still applies.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_dec_fts
  ON mnemosyne.mnemo_decision
  USING gin (text_lemmatized);
