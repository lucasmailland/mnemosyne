-- Reverts 0045. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit); any failure rolls everything back.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Refuse BEFORE mutating anything if relations over the widened kinds exist:
-- the narrower vocabulary cannot represent them. Delete or re-point them first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_relation
     WHERE source_kind NOT IN ('fact','decision','entity','episode')
        OR target_kind NOT IN ('fact','decision','entity','episode')
  ) THEN
    RAISE EXCEPTION '0045 down: relations over strategy/workflow/skill/task/event/reasoning exist; remove them first';
  END IF;
END $$;

-- Closed entities may now share a (workspace_id, name, kind) with a live one,
-- which the old full constraint forbids. Rename the colliding CLOSED rows
-- (never the live one) so the constraint can be restored without data loss.
UPDATE mnemosyne.mnemo_entity e
   SET name = e.name || ' [closed ' || e.id || ']'
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY workspace_id, name, kind
             ORDER BY (valid_to IS NULL) DESC, created_at DESC, id DESC
           ) AS rn
      FROM mnemosyne.mnemo_entity
  ) d
 WHERE e.id = d.id AND d.rn > 1;

ALTER TABLE mnemosyne.mnemo_entity
  ADD CONSTRAINT mnemo_entity_workspace_id_name_kind_key UNIQUE (workspace_id, name, kind);
DROP INDEX IF EXISTS mnemosyne.uq_mnemo_entity_live_name_kind;

ALTER TABLE mnemosyne.mnemo_relation
  DROP CONSTRAINT IF EXISTS mnemo_relation_no_self_loop,
  DROP CONSTRAINT IF EXISTS mnemo_relation_source_kind_check,
  DROP CONSTRAINT IF EXISTS mnemo_relation_target_kind_check,
  ADD CONSTRAINT mnemo_relation_source_kind_check CHECK (source_kind = ANY (ARRAY['fact'::text, 'decision'::text, 'entity'::text, 'episode'::text])),
  ADD CONSTRAINT mnemo_relation_target_kind_check CHECK (target_kind = ANY (ARRAY['fact'::text, 'decision'::text, 'entity'::text, 'episode'::text]));
COMMIT;
