-- migrate:allow-drop reason=reverts the disabled_at, sessions_valid_after and last_login_at columns 0050 adds to mnemo_user
-- Reverts 0050. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit); any failure rolls everything back. Roll the
-- server back first: the code of this change calls these functions.
--
-- DESTRUCTIVE:
-- * every superadmin grant is lost (mnemo_instance_admin is dropped);
-- * disabled users can sign in again (disabled_at is dropped);
-- * sessions ended by a password change, disable or revocation become valid
--   again until their own expiry (sessions_valid_after is dropped);
-- * last login times are lost.
-- Re-applying 0050 restores none of them.
--
-- Audit rows written with a 0050 action stay: the log is append-only (S3), so
-- they can be neither deleted nor relabelled. The previous CHECK therefore comes
-- back NOT VALID: it holds for every new row, not for that history.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_revoke_admin(text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_grant_admin(text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_user_status(text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_is_admin(text);
-- Drops its grants and RLS settings with it.
DROP TABLE IF EXISTS mnemosyne.mnemo_instance_admin;

ALTER TABLE mnemosyne.mnemo_user
    DROP COLUMN IF EXISTS disabled_at,
    DROP COLUMN IF EXISTS sessions_valid_after,
    DROP COLUMN IF EXISTS last_login_at;

ALTER TABLE mnemosyne.mnemo_audit_log
    DROP CONSTRAINT mnemo_audit_log_action_check,
    ADD CONSTRAINT mnemo_audit_log_action_check
    CHECK (action = ANY (ARRAY[
      'recall'::text, 'create'::text, 'update'::text, 'delete'::text, 'hard_delete'::text,
      'export'::text, 'self_edit'::text, 'session_open'::text, 'session_close'::text,
      'key_create'::text, 'key_rotate'::text, 'key_revoke'::text, 'admin_access'::text,
      'federation_sync'::text, 'erasure_initiated'::text, 'erasure_complete'::text,
      'federation_cert_pin_mismatch'::text, 'federation_cert_rotated'::text,
      'plugin_installed'::text, 'plugin_removed'::text, 'workspace_created'::text,
      'workspace_deleted'::text, 'rls_policy_changed'::text, 'mfa_verified'::text,
      'ip_denied'::text]))
    NOT VALID;
COMMIT;
