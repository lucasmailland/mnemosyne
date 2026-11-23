-- migrate:allow-drop reason=reverts the user_id column 0069 adds
-- Reverts 0069. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: it writes
-- user_id. Issued keys keep working, without their user binding.
BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE INSERT ON TABLE mnemosyne.mnemo_scoped_key_escrow FROM mnemo_app_role;
REVOKE SELECT, INSERT ON TABLE mnemosyne.mnemo_scoped_key_usage FROM mnemo_app_role;
REVOKE SELECT, INSERT, UPDATE ON TABLE mnemosyne.mnemo_scoped_api_keys FROM mnemo_app_role;
ALTER TABLE mnemosyne.mnemo_scoped_api_keys DROP COLUMN IF EXISTS user_id;
COMMIT;
