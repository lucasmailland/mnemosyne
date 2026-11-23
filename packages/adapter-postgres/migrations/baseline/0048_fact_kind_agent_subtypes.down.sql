-- Reverts 0048. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit); any failure rolls everything back.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Refuse BEFORE changing anything if a fact uses a kind 0048 added: the
-- narrower CHECK cannot hold it. Re-kind those rows first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_fact
     WHERE kind IN ('architecture', 'bugfix', 'config', 'discovery', 'policy', 'process')
  ) THEN
    RAISE EXCEPTION '0048 down: facts with kind architecture/bugfix/config/discovery/policy/process exist; re-kind them first';
  END IF;
END $$;

ALTER TABLE mnemosyne.mnemo_fact
  DROP CONSTRAINT IF EXISTS mnemo_fact_kind_check,
  ADD CONSTRAINT mnemo_fact_kind_check CHECK (kind = ANY (ARRAY['preference'::text, 'trait'::text, 'event'::text, 'relationship'::text, 'skill'::text, 'concern'::text, 'other'::text]));
COMMIT;
