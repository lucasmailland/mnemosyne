-- Reverts 0053. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: the instance
-- routes of this change call these functions.
--
-- Data stays as the functions left it: offboarded users stay disabled, their
-- removed memberships and revoked keys stay removed and revoked, and owners
-- promoted during an offboarding keep the role.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_offboard(text, text, jsonb);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_remove_member(text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_set_member_role(text, text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_workspace_members(text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_list_workspaces(text);
COMMIT;
