-- Reverts 0042. The reminder poller can no longer enumerate due workspaces.
DROP FUNCTION IF EXISTS mnemosyne.mnemo_list_due_reminder_workspace_ids();
