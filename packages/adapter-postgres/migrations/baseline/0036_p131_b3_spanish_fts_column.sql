-- migrate:no-transaction
--
-- P131 B3 — a second lexical index, stemmed for Spanish.
--
-- One text-search configuration cannot serve two languages. The manual's recipe
-- is to chain the stemmers, and it does not work: ts_lexize('spanish_stem',
-- 'running') returns {running} — non-NULL, so the dictionary chain stops there
-- and english_stem never runs. Chaining silently costs English its stemming.
--
-- So each row gets indexed BOTH ways and the query ORs the two arms, each under
-- its own configuration. No language detection anywhere: a per-row `language`
-- column was the alternative and it buys nothing here while adding a classifier
-- that is silently wrong when it guesses badly.
--
-- MEASURED BEFORE BUILDING, because the easy cases suggested this was not worth
-- doing. On simple Spanish (plurals, accents) the English config already
-- matches everything — english_stem strips -s/-es, which covers the commonest
-- Spanish inflection by coincidence, and 0035's unaccent covers the accents.
-- The difference only appears on verb morphology. Eight hard cases:
--
--   query                      english   spanish
--   corriendo / corre             no       YES
--   correr / corren               no       YES
--   guardar / guardamos           no       YES
--   almacenamiento / almacena     no       YES
--   configuracion/configuraciones YES       no
--   desplegamos / despliega       no        no
--   enviar / envia                no        no
--   revision / revisamos          no        no
--
-- English alone: 1/8. Spanish alone: 4/8. The two ORed: 5/8 — which is why this
-- adds a column instead of switching one. Spanish is better on average and
-- English still wins a case; picking either loses real matches.
--
-- WHAT THIS DOES NOT DO — it does not revisit P130's AND semantics. Replacing
-- AND with OR was measured again here and is still unsafe: the English arm
-- keeps Spanish stopwords ('el', 'de', 'es') as indexed terms, so an OR query
-- matches unrelated rows through them even with this column present. P130 is
-- closed by cosine candidates, so nothing needs OR.
--
-- ⚠️ Same hazard as 0035: ALTERING mnemosyne.mnemo_fts_es later does NOT
-- recompute these stored columns. Any change to its dictionary chain must be
-- followed by a SET EXPRESSION sweep in the same migration.

CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;

-- Mirrors mnemosyne.mnemo_fts exactly, swapping the stemmer. unaccent still
-- runs first so the stemmer sees folded text.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config c
      JOIN pg_namespace n ON n.oid = c.cfgnamespace
     WHERE n.nspname = 'mnemosyne' AND c.cfgname = 'mnemo_fts_es'
  ) THEN
    CREATE TEXT SEARCH CONFIGURATION mnemosyne.mnemo_fts_es (COPY = spanish);
  END IF;
END $$;

ALTER TEXT SEARCH CONFIGURATION mnemosyne.mnemo_fts_es
  ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
  WITH unaccent, spanish_stem;

-- ── The Spanish column, on the same ten tables 0035 aligned ─────────────────
-- Expressions mirror each table's existing text_lemmatized, changing only the
-- regconfig. ADD COLUMN of a STORED generated column rewrites the table, same
-- cost profile as 0035's SET EXPRESSION sweep.

ALTER TABLE mnemosyne.mnemo_fact
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, COALESCE(statement, ''::text))) STORED;

ALTER TABLE mnemosyne.mnemo_fact_archive
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, COALESCE(statement, ''::text))) STORED;

ALTER TABLE mnemosyne.mnemo_decision
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(body, ''::text)))) STORED;

ALTER TABLE mnemosyne.mnemo_episode
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(narrative, ''::text)))) STORED;

ALTER TABLE mnemosyne.mnemo_event
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)))) STORED;

ALTER TABLE mnemosyne.mnemo_reasoning
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(question, ''::text) || ' '::text) || COALESCE(conclusion, ''::text)))) STORED;

ALTER TABLE mnemosyne.mnemo_skill
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(prompt_template, ''::text)))) STORED;

ALTER TABLE mnemosyne.mnemo_strategy
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(trigger, ''::text) || ' '::text) || COALESCE(action, ''::text)))) STORED;

ALTER TABLE mnemosyne.mnemo_task
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))) STORED;

ALTER TABLE mnemosyne.mnemo_workflow
  ADD COLUMN IF NOT EXISTS text_lemmatized_es tsvector
  GENERATED ALWAYS AS (to_tsvector('mnemosyne.mnemo_fts_es'::regconfig, ((COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)))) STORED;

-- ── GIN indexes, mirroring the existing idx_mnemo_*_fts ────────────────────
-- CONCURRENTLY (hence the no-transaction marker at the top): the column is new
-- but the tables are not, so these are real builds over existing rows.
-- mnemo_fact_archive has no FTS index today and does not get one here — it is
-- not a recall source, and 0011 added its text_lemmatized for shape parity
-- rather than for querying.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_fact_fts_es ON mnemosyne.mnemo_fact USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_dec_fts_es ON mnemosyne.mnemo_decision USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_episode_fts_es ON mnemosyne.mnemo_episode USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_event_fts_es ON mnemosyne.mnemo_event USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_reasoning_fts_es ON mnemosyne.mnemo_reasoning USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_skill_fts_es ON mnemosyne.mnemo_skill USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_strategy_fts_es ON mnemosyne.mnemo_strategy USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_task_fts_es ON mnemosyne.mnemo_task USING gin (text_lemmatized_es);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_workflow_fts_es ON mnemosyne.mnemo_workflow USING gin (text_lemmatized_es);
