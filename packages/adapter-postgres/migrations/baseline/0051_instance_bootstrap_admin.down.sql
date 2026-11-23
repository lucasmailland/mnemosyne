-- Reverts 0051. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: the bootstrap
-- route of this change calls the function. Superadmin rows it wrote stay.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_bootstrap_admin(text);
COMMIT;
