-- Reverts 0059. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: sign-out and
-- every live session check call these functions. Signed-out sessions that have
-- not expired yet work again until their expiry once the table is gone.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_dashboard_session_revoked(text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_dashboard_session_revoke(text, timestamptz);
DROP TABLE IF EXISTS mnemosyne.mnemo_dashboard_session_revocation;
COMMIT;
