-- Reverts 0041. Background jobs fall back to enumerating under RLS, which
-- returns no workspaces for a non-superuser application role.
DROP FUNCTION IF EXISTS mnemosyne.mnemo_list_workspace_ids();
