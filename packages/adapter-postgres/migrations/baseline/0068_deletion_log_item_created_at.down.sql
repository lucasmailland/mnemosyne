-- migrate:allow-drop reason=reverts the item_created_at column 0068 adds
-- Reverts 0068. Hard-deleted facts stop reaching peers as tombstones.
DROP FUNCTION IF EXISTS mnemosyne.mnemo_deleted_facts(timestamptz, text, timestamptz, integer);
ALTER TABLE mnemosyne.mnemo_deletion_log DROP COLUMN IF EXISTS item_created_at;
