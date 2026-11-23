-- P15: Add sensitivity column to all 9 non-fact cognitive primitive tables.
-- Replicates the proven mnemo_fact.sensitivity pattern:
--   text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN (...))
-- All pre-existing rows will default to 'internal' (safe baseline).

ALTER TABLE mnemosyne.mnemo_decision ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_episode ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_entity ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_strategy ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_workflow ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_skill ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_task ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_event ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));

ALTER TABLE mnemosyne.mnemo_reasoning ADD COLUMN sensitivity text NOT NULL DEFAULT 'internal'
  CHECK (sensitivity IN ('public','internal','confidential','restricted'));
