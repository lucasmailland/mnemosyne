-- migrate:allow-drop reason=reverts the region column 0062 adds
-- Reverts 0062. Roll the server back first: the region lock reads the column.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_region(text);
ALTER TABLE mnemosyne.mnemo_workspace DROP COLUMN IF EXISTS region;
COMMIT;
