-- P65 wave 1 — give `strategy` and `workflow` the columns recall needs.
--
-- The backlog item described adding a kind as "one PRIMITIVE_TEXT_PROJECTION
-- entry, one DEFAULT_RECALL_KINDS entry, and a backfill". That is true of the
-- registry plumbing and false of the schema, which is why this migration
-- exists: measured against a live database, of the seven write-only kinds only
-- `episode`, `skill`, `strategy` and `reasoning` even have an `embedding`
-- column, and NONE of the seven has `text_lemmatized`. `workflow`, `task` and
-- `event` have neither.
--
-- Recall needs both arms. Semantic alone is not enough — `recallCold`'s non-fact
-- path runs a lexical `ts_rank` arm beside the cosine one, exactly as the
-- `decision` reference implementation does.
--
-- Scope here is wave 1 only: strategy and workflow. They come first because they
-- hold reusable heuristics and processes — the content an agent most benefits
-- from finding unprompted.
--
-- 'english' config, matching mnemo_fact (baseline 0001) and mnemo_decision
-- (migration 0029). A mismatched config is not a small difference: the same
-- query text tokenises differently and the arm silently under-returns.

-- ── strategy: has embedding already, needs the lexical arm ───────────────────
-- Projected text is `trigger || ' ' || action` — the trigger→action pair IS the
-- heuristic, and either half alone is unsearchable ("when the build is red"
-- means nothing without what to do about it).
ALTER TABLE mnemosyne.mnemo_strategy
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(trigger, ''::text) || ' '::text) || COALESCE(action, ''::text))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_mnemo_strategy_fts
  ON mnemosyne.mnemo_strategy
  USING gin (text_lemmatized);

-- ── workflow: had no vector columns at all ───────────────────────────────────
-- Dimensionless `halfvec`, matching every other primitive's embedding column
-- (migration 0009, multi-dimension support) — and now covered by the P118 width
-- predicate, so mixed widths degrade instead of throwing.
ALTER TABLE mnemosyne.mnemo_workflow
  ADD COLUMN IF NOT EXISTS embedding public.halfvec,
  ADD COLUMN IF NOT EXISTS embedding_model text,
  -- Defaults to TRUE, unlike the other tables' FALSE, and deliberately: every
  -- workflow that already exists has no embedding, so `stale` is the honest
  -- state and the re-embed sweep will pick them up. A default of false would
  -- claim a fresh vector for rows that have none.
  ADD COLUMN IF NOT EXISTS embedding_stale boolean NOT NULL DEFAULT true;

ALTER TABLE mnemosyne.mnemo_workflow
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, (COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_mnemo_workflow_fts
  ON mnemosyne.mnemo_workflow
  USING gin (text_lemmatized);

-- No ANN index on either embedding column, matching `mnemo_decision`: its
-- similarity arm is a sequential cosine scan (design.md Risk 3, accepted
-- deliberately). Strategies and workflows are far fewer than facts; an HNSW
-- index is a later optimisation, not a correctness requirement.

-- The app role must be able to read the new columns.
GRANT SELECT ON mnemosyne.mnemo_strategy TO mnemo_app_role;
GRANT SELECT ON mnemosyne.mnemo_workflow TO mnemo_app_role;
