-- P131 B1+B2 — one named text-search configuration, accent-insensitive.
--
-- TWO DEFECTS, ONE FIX, because both live in the same place.
--
-- B1 — the two halves disagreed. Every generated column indexes with
-- to_tsvector('english'), but three FactRepository query sites asked with
-- plainto_tsquery('simple'). Measured on pg17:
--
--   to_tsvector('english','los mensajes se guardan cifrados')
--     @@ plainto_tsquery('simple','mensajes cifrados')   →  FALSE
--
-- 'english' stems mensajes→mensaj; 'simple' does not. The lexemes never met.
-- This is the first half of P130's cause: findContradictingFacts could not find
-- a contradiction it was looking straight at.
--
-- B2 — accents. Also measured:
--
--   to_tsvector('spanish','la configuracion')
--     @@ plainto_tsquery('spanish','configuración')      →  FALSE
--
-- People type Spanish without accents constantly, and this workspace is
-- Spanish-majority. Every such query missed silently.
--
-- THE FIX is a single named configuration, mnemosyne.mnemo_fts, that both sides
-- reference by name. The disagreement above was possible because there was no
-- name to be wrong about — each site spelled its own config as a string literal
-- and nothing compared them. A name is the thing a test can assert on, and
-- packages/adapter-postgres/src/__tests__/fts-config-is-single-sourced.test.ts
-- now does exactly that.
--
-- WHAT THIS DOES NOT DO — the stemmer stays English (COPY = english). That is
-- P131 B3, and it needs a decision rather than a migration: one configuration
-- cannot stem two languages. Chaining spanish_stem + english_stem is the
-- manual's recipe and it does not work, because ts_lexize('spanish_stem','running')
-- returns {running} — non-NULL, so the dictionary chain stops there and
-- english_stem never runs. Spanish stopwords therefore survive indexing today
-- ('los','se','en','la' are indexed as terms, inflating ts_rank_cd). Fixing
-- that is B3's job; this migration deliberately leaves the stemmer alone so the
-- alignment and the accent fix can ship without waiting on that decision.
--
-- ⚠️ ALTERING mnemo_fts LATER DOES NOT RECOMPUTE THESE COLUMNS. Stored
-- generated columns are computed on write. Change the dictionary chain and
-- every existing row keeps lexemes from the OLD chain while new rows get the
-- new one — a split index that matches nothing consistently and raises no
-- error. Any future ALTER of this configuration MUST be followed by the same
-- SET EXPRESSION sweep below, in the same migration.
--
-- ⚠️ SET EXPRESSION REWRITES THE TABLE under ACCESS EXCLUSIVE. Instant on a
-- dev-sized database, a stall proportional to row count on a large one. It is
-- used here in preference to migration 0029's DROP COLUMN + ADD COLUMN +
-- recreate-index dance because pg17 added the clause (0029's comment "Postgres
-- has no ALTER ... ALTER GENERATED clause" was true when it was written) and
-- because it keeps every dependent GIN index in place instead of dropping and
-- rebuilding it.

-- unaccent is not a trusted extension: this runs as the migrate role, which is
-- the superuser connection, same as vector and pg_trgm in the baseline.
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;

-- COPY = english preserves the current stemmer and stopword list exactly, so
-- the ONLY behavioural change here is accent folding plus the single name.
--
-- Created conditionally rather than DROP + CREATE, and that is load-bearing.
-- Once the ten generated columns below reference this configuration they DEPEND
-- on it, and Postgres refuses the drop:
--
--   ERROR: cannot drop text search configuration mnemosyne.mnemo_fts
--          because other objects depend on it
--
-- A DROP here therefore works exactly once — on a database where the columns do
-- not yet point at it — and fails on every re-run. Worse, it would wall off
-- B3: changing the dictionary chain later must be an ALTER of this same
-- configuration, never a replacement of it. (`CREATE TEXT SEARCH CONFIGURATION`
-- has no `IF NOT EXISTS`, hence the DO block.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config c
      JOIN pg_namespace n ON n.oid = c.cfgnamespace
     WHERE n.nspname = 'mnemosyne' AND c.cfgname = 'mnemo_fts'
  ) THEN
    CREATE TEXT SEARCH CONFIGURATION mnemosyne.mnemo_fts (COPY = english);
  END IF;
END $$;

-- unaccent runs BEFORE the stemmer so the stemmer sees folded text. Mapping
-- every word token type, not just `word`: `asciiword` covers unaccented input
-- and `hword*` covers hyphenated compounds, which Spanish and English both use.
-- Unconditional and re-runnable: ALTER MAPPING ... WITH replaces the dictionary
-- list for those token types rather than appending to it.
ALTER TEXT SEARCH CONFIGURATION mnemosyne.mnemo_fts
  ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
  WITH unaccent, english_stem;

-- ── Re-express all ten generated columns against the named configuration ─────
-- Expressions are otherwise byte-identical to what pg_get_expr reports today;
-- only the regconfig argument changes.

ALTER TABLE mnemosyne.mnemo_fact
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, COALESCE(statement, ''::text)));

ALTER TABLE mnemosyne.mnemo_fact_archive
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, COALESCE(statement, ''::text)));

ALTER TABLE mnemosyne.mnemo_decision
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(body, ''::text))));

ALTER TABLE mnemosyne.mnemo_episode
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(narrative, ''::text))));

ALTER TABLE mnemosyne.mnemo_event
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text))));

ALTER TABLE mnemosyne.mnemo_reasoning
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(question, ''::text) || ' '::text) || COALESCE(conclusion, ''::text))));

ALTER TABLE mnemosyne.mnemo_skill
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(prompt_template, ''::text))));

ALTER TABLE mnemosyne.mnemo_strategy
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(trigger, ''::text) || ' '::text) || COALESCE(action, ''::text))));

ALTER TABLE mnemosyne.mnemo_task
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text))));

ALTER TABLE mnemosyne.mnemo_workflow
  ALTER COLUMN text_lemmatized
  SET EXPRESSION AS (to_tsvector('mnemosyne.mnemo_fts'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text))));
