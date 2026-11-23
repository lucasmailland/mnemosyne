-- migrate:allow-drop reason=reverts the policy change table, trigger and functions 0067 adds
-- Reverts 0067. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: it polls the
-- table. Without it, other replicas see a policy change within the 60 s cache TTL.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS mnemo_access_policy_changed ON mnemosyne.mnemo_access_policy;
DROP FUNCTION IF EXISTS mnemosyne.mnemo_access_policy_changed();
DROP FUNCTION IF EXISTS mnemosyne.mnemo_access_policy_changes(bigint);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_purge_access_policy_changes();
DROP TABLE IF EXISTS mnemosyne.mnemo_access_policy_change;
COMMIT;
