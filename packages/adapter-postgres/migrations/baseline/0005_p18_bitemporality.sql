-- migrate:no-transaction
-- P18: Uniform bitemporality — validFrom/validTo on 5 primitives.
-- Safe: ADD COLUMN DEFAULT now() uses Pg11+ fast-path (no full table rewrite).
-- Two-step backfill: valid_from = created_at for pre-existing rows.
-- CONCURRENTLY indexes cannot run inside a transaction; this file runs outside one.

-- ── Episode ──────────────────────────────────────────────────────────────────
ALTER TABLE mnemosyne.mnemo_episode
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

UPDATE mnemosyne.mnemo_episode
  SET valid_from = created_at
  WHERE valid_from != created_at;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_episode_valid_from
  ON mnemosyne.mnemo_episode (workspace_id, valid_from);

-- ── Entity ───────────────────────────────────────────────────────────────────
ALTER TABLE mnemosyne.mnemo_entity
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

UPDATE mnemosyne.mnemo_entity
  SET valid_from = created_at
  WHERE valid_from != created_at;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_valid_from
  ON mnemosyne.mnemo_entity (workspace_id, valid_from);

-- ── Workflow ─────────────────────────────────────────────────────────────────
ALTER TABLE mnemosyne.mnemo_workflow
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

UPDATE mnemosyne.mnemo_workflow
  SET valid_from = created_at
  WHERE valid_from != created_at;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_valid_from
  ON mnemosyne.mnemo_workflow (workspace_id, valid_from);

-- ── Skill ────────────────────────────────────────────────────────────────────
ALTER TABLE mnemosyne.mnemo_skill
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

UPDATE mnemosyne.mnemo_skill
  SET valid_from = created_at
  WHERE valid_from != created_at;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skill_valid_from
  ON mnemosyne.mnemo_skill (workspace_id, valid_from);

-- ── Task ─────────────────────────────────────────────────────────────────────
ALTER TABLE mnemosyne.mnemo_task
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

UPDATE mnemosyne.mnemo_task
  SET valid_from = created_at
  WHERE valid_from != created_at;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_valid_from
  ON mnemosyne.mnemo_task (workspace_id, valid_from);
