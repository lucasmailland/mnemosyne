-- Reverse migration 0028_narrow_fact_scope_check.sql

ALTER TABLE mnemosyne.mnemo_fact
  DROP CONSTRAINT mnemo_fact_scope_check;

ALTER TABLE mnemosyne.mnemo_fact
  ADD CONSTRAINT mnemo_fact_scope_check
  CHECK (scope = ANY (ARRAY['global', 'conversation', 'employee', 'team']::text[])) NOT VALID;

ALTER TABLE mnemosyne.mnemo_fact
  VALIDATE CONSTRAINT mnemo_fact_scope_check;
