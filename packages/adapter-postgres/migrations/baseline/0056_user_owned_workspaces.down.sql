-- Reverts 0056. Workspaces and tenants created through it stay.
DROP FUNCTION IF EXISTS mnemosyne.mnemo_user_workspaces(text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_user_create_workspace(text, text, integer);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_user_owned_team_workspaces(text);
