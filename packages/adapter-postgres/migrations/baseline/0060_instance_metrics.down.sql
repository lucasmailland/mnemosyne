-- Reverts 0060. Roll the server back first: the Installation rooms call these.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_audit_stats(text, timestamptz);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_workspace_figures(text, text[]);
COMMIT;
