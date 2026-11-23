-- P65 waves 2 and 3 — the last five write-only kinds get what recall needs.
--
-- skill, episode, reasoning already had `embedding` and needed only the lexical
-- column. task and event had neither.
--
-- 'english' throughout, matching mnemo_fact (baseline 0001), mnemo_decision
-- (0029) and strategy/workflow (0033). A mismatched config is not a small
-- difference: the same query text tokenises differently and the arm silently
-- under-returns.
--
-- Text projections mirror PRIMITIVE_TEXT_PROJECTION exactly. Where they drift,
-- the semantic arm and the lexical arm search different text for the same row —
-- which shows up as "recall finds it by keyword but not by meaning", the
-- hardest class of bug to attribute.

-- ── skill: name + prompt_template ────────────────────────────────────────────
-- The template IS the skill; the name alone is a label.
ALTER TABLE mnemosyne.mnemo_skill
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(name, ''::text) || ' '::text) || COALESCE(prompt_template, ''::text))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_mnemo_skill_fts ON mnemosyne.mnemo_skill USING gin (text_lemmatized);

-- ── episode: title + narrative ───────────────────────────────────────────────
-- Matches the createEpisode producer's text-form outbox payload, so a §36 model
-- migration re-embeds the same text the lexical column indexes.
ALTER TABLE mnemosyne.mnemo_episode
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(title, ''::text) || ' '::text) || COALESCE(narrative, ''::text))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_mnemo_episode_fts ON mnemosyne.mnemo_episode USING gin (text_lemmatized);

-- ── reasoning: question + conclusion ─────────────────────────────────────────
ALTER TABLE mnemosyne.mnemo_reasoning
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(question, ''::text) || ' '::text) || COALESCE(conclusion, ''::text))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_mnemo_reasoning_fts ON mnemosyne.mnemo_reasoning USING gin (text_lemmatized);

-- ── task: had no vector columns at all ───────────────────────────────────────
-- `embedding_stale` defaults TRUE, as workflow's did in 0033: every existing row
-- has no vector, and stale is the honest state — the re-embed sweep is what
-- backfills them. A default of false would claim a fresh vector for rows that
-- have none.
ALTER TABLE mnemosyne.mnemo_task
  ADD COLUMN IF NOT EXISTS embedding public.halfvec,
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_stale boolean NOT NULL DEFAULT true;
ALTER TABLE mnemosyne.mnemo_task
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_mnemo_task_fts ON mnemosyne.mnemo_task USING gin (text_lemmatized);

-- ── event: had no vector columns at all ──────────────────────────────────────
ALTER TABLE mnemosyne.mnemo_event
  ADD COLUMN IF NOT EXISTS embedding public.halfvec,
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_stale boolean NOT NULL DEFAULT true;
ALTER TABLE mnemosyne.mnemo_event
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text))
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_mnemo_event_fts ON mnemosyne.mnemo_event USING gin (text_lemmatized);

-- No ANN indexes, matching mnemo_decision and 0033: these arms are sequential
-- cosine scans over tables far smaller than mnemo_fact. An HNSW index is a later
-- optimisation, not a correctness requirement.

GRANT SELECT ON mnemosyne.mnemo_skill TO mnemo_app_role;
GRANT SELECT ON mnemosyne.mnemo_episode TO mnemo_app_role;
GRANT SELECT ON mnemosyne.mnemo_reasoning TO mnemo_app_role;
GRANT SELECT ON mnemosyne.mnemo_task TO mnemo_app_role;
GRANT SELECT ON mnemosyne.mnemo_event TO mnemo_app_role;
