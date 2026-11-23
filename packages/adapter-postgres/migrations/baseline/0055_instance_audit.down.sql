-- Reverts 0055. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: GET
-- /instance/audit calls this function. The audit rows themselves are untouched,
-- and so are the instance_* settings rows in mnemo_workspace_config (older
-- servers never read them).
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_audit(text, text, text, timestamptz, timestamptz, timestamptz, bigint, integer);
COMMIT;
