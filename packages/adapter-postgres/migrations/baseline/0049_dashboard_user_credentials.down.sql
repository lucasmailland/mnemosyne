-- Reverts 0049. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit); any failure rolls everything back.
--
-- DESTRUCTIVE: dropping mnemo_user_credential deletes every dashboard password.
-- Users fall back to API key login; their mnemo_user rows and memberships are
-- untouched. Re-applying 0049 does not restore the hashes — set them again with
-- packages/server/scripts/dashboard-password.mjs.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- The function returns rows of the table, so it goes first.
DROP FUNCTION IF EXISTS mnemosyne.mnemo_dashboard_credential_lookup(text);
-- Drops its policy, grants and RLS settings with it.
DROP TABLE IF EXISTS mnemosyne.mnemo_user_credential;
COMMIT;
