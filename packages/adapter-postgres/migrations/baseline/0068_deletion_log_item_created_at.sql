-- Migration 0068: hard-deleted facts reach federation peers as tombstones.
--
-- GET /memory/federation/items serves a fact deleted outright (DELETE
-- /facts/:id/hard, DELETE /facts/purge, the hard mode of forget()) as a
-- tombstone read from mnemo_deletion_log, so peers archive their copy. Like
-- every tombstone it goes only to a peer that may hold the fact: one whose
-- previous sync ended after the fact was created. The fact row is gone, so the
-- log keeps that instant in item_created_at. NULL on rows written before this
-- migration and on other kinds: those are never served (fail closed). A
-- nullable column with no default: a catalog-only change, no rewrite.
ALTER TABLE mnemosyne.mnemo_deletion_log ADD COLUMN IF NOT EXISTS item_created_at timestamptz;

-- The application role may only INSERT into the log (0001, 0046), and the log
-- has no RLS. Rather than grant it SELECT on every workspace's rows, one narrow
-- read runs as the function owner (same mechanism as 0021 and 0041) and returns
-- only the workspace the transaction set with mnemo_set_workspace: no GUC, no
-- rows. A log row whose fact still exists is not a deletion and is left out.
-- Keyset order (deleted_at, id), after (after_at, after_id) when given; the
-- sort key is the instant with all six fractional digits, the cursor format of
-- FactRepository.queryFactsPage.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_deleted_facts(
    after_at timestamptz, after_id text, since timestamptz, lim integer)
    RETURNS TABLE (id text, deleted_at timestamptz, item_created_at timestamptz, sort_key text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'public'
    AS $$
  SELECT d.deleted_item_id::text, d.deleted_at, d.item_created_at,
         to_char(d.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM mnemosyne.mnemo_deletion_log d
  WHERE d.workspace_id = NULLIF(current_setting('mnemosyne.workspace_id', true), '')::uuid
    AND d.deleted_item_type = 'fact'
    AND d.deletion_type IN ('hard', 'gdpr_erasure')
    AND NOT EXISTS (
      SELECT 1 FROM mnemosyne.mnemo_fact f
      WHERE f.workspace_id = d.workspace_id::text AND f.id = d.deleted_item_id::text
    )
    AND (since IS NULL OR d.deleted_at > since)
    AND (after_at IS NULL OR (d.deleted_at, d.deleted_item_id::text) > (after_at, after_id))
  ORDER BY d.deleted_at, d.deleted_item_id::text
  LIMIT lim;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_deleted_facts(timestamptz, text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_deleted_facts(timestamptz, text, timestamptz, integer) TO mnemo_app_role;
