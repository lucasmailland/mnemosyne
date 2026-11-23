-- migrate:allow-rls-no-policy reason=mnemo_instance_admin is reachable only through the SECURITY DEFINER functions below; no policy is deliberate, so app roles see and write nothing
-- Migration 0050 (accounts stage A): user lifecycle, superadmin and the
-- security audit actions.
--
-- * mnemo_user gains disabled_at (no login while set), sessions_valid_after
--   (a dashboard session issued before it is dead; 'epoch' = every session
--   counts) and last_login_at.
-- * mnemo_instance_admin lists the installation's superadmins. It is a
--   cross-tenant principal, so no app role reads or writes it directly: FORCE
--   RLS with no policy. Everything goes through the functions below, which run
--   as the migration owner. As for the provisioning helpers (0047, 0049), that
--   owner must bypass RLS: mnemo_user is FORCE RLS too.
-- * mnemo_audit_log accepts the actions the account, invitation and instance
--   routes write.
--
-- DEPLOYMENT ORDER. Before the server code that calls these functions or
-- writes these actions. Old code never reads the new columns.
SET LOCAL lock_timeout = '5s';

-- Constant defaults: catalog-only, no table rewrite.
ALTER TABLE mnemosyne.mnemo_user
    ADD COLUMN disabled_at timestamptz,
    ADD COLUMN sessions_valid_after timestamptz NOT NULL DEFAULT 'epoch',
    ADD COLUMN last_login_at timestamptz;

CREATE TABLE mnemosyne.mnemo_instance_admin (
    user_id text PRIMARY KEY REFERENCES mnemosyne.mnemo_user(id) ON DELETE CASCADE,
    granted_by text NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mnemosyne.mnemo_instance_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_instance_admin FORCE ROW LEVEL SECURITY;
-- SELECT only, so a stray direct query returns no rows instead of an error.
-- 0015's default privileges hand mnemo_app_role all four DML rights on every
-- new table; take the write rights back. RLS with no policy refuses writes
-- either way (provision-app-role.mjs re-grants them on each deploy).
REVOKE ALL ON TABLE mnemosyne.mnemo_instance_admin FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE mnemosyne.mnemo_instance_admin FROM app_user, mnemo_app_role;
GRANT SELECT ON TABLE mnemosyne.mnemo_instance_admin TO app_user, mnemo_app_role;

-- True only for an existing, enabled user listed as superadmin.
CREATE FUNCTION mnemosyne.mnemo_instance_is_admin(p_actor text)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT EXISTS (
        SELECT 1
        FROM mnemosyne.mnemo_instance_admin a
        JOIN mnemosyne.mnemo_user u ON u.id = a.user_id
        WHERE a.user_id = p_actor AND u.disabled_at IS NULL
      );
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_is_admin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_is_admin(text) TO app_user, mnemo_app_role;

-- Session check for any user, whatever tenant the caller is in. Zero rows when
-- the user does not exist. is_superadmin means the same as
-- mnemo_instance_is_admin: a disabled superadmin is not one.
CREATE FUNCTION mnemosyne.mnemo_user_status(p_user_id text)
    RETURNS TABLE (disabled_at timestamptz, sessions_valid_after timestamptz, is_superadmin boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT u.disabled_at, u.sessions_valid_after,
             u.disabled_at IS NULL
               AND EXISTS (SELECT 1 FROM mnemosyne.mnemo_instance_admin a WHERE a.user_id = u.id)
      FROM mnemosyne.mnemo_user u
      WHERE u.id = p_user_id;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_user_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_user_status(text) TO app_user, mnemo_app_role;

-- Grant and revoke serialize on one advisory lock (any later function that
-- disables or offboards a superadmin takes it too) and check the actor again
-- once they hold it: a concurrent revoke or disable may have just removed them.
-- Each statement after the lock sees what the previous holder committed (READ
-- COMMITTED); under a stronger isolation level the FOR UPDATE in revoke makes
-- a concurrent change fail with a serialization error instead of being missed.
CREATE FUNCTION mnemosyne.mnemo_instance_grant_admin(p_actor text, p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('mnemo_instance_admin'));
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by)
  VALUES (p_user, p_actor)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_grant_admin(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_grant_admin(text, text) TO app_user, mnemo_app_role;

-- Refuses to leave the installation without an active superadmin. That rule is
-- checked before the actor's own standing under the lock, so of two
-- superadmins revoking each other at once the second is told last_superadmin.
-- Ends the revoked user's sessions.
CREATE FUNCTION mnemosyne.mnemo_instance_revoke_admin(p_actor text, p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_remaining integer;
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('mnemo_instance_admin'));
  SELECT count(*) INTO v_remaining
  FROM (
    SELECT 1
    FROM mnemosyne.mnemo_instance_admin a
    JOIN mnemosyne.mnemo_user u ON u.id = a.user_id
    WHERE u.disabled_at IS NULL AND a.user_id <> p_user
    FOR UPDATE OF a
  ) active;
  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'last_superadmin' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = p_user;
  IF FOUND THEN
    UPDATE mnemosyne.mnemo_user SET sessions_valid_after = clock_timestamp() WHERE id = p_user;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_revoke_admin(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_revoke_admin(text, text) TO app_user, mnemo_app_role;

-- The action CHECK, previous values plus the security actions. Declared on the
-- parent, it recurses to every attached partition (0001 attached them with a
-- matching constraint, which makes theirs inherited), and create_audit_partition
-- builds new partitions with PARTITION OF, which copies it.
--
-- NOT VALID and never validated here: the new CHECK is strictly looser than
-- the one every existing row passed, and VALIDATE inside this transaction would
-- hold the ACCESS EXCLUSIVE lock from ADD CONSTRAINT for a scan of the whole
-- log. Postgres still enforces it on every new row. An operator may run
-- ALTER TABLE mnemosyne.mnemo_audit_log VALIDATE CONSTRAINT
-- mnemo_audit_log_action_check later; it takes only SHARE UPDATE EXCLUSIVE.
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
      'ip_denied'::text,
      'login_success'::text, 'login_failure'::text, 'user_created'::text,
      'user_disabled'::text, 'user_enabled'::text, 'user_offboarded'::text,
      'superadmin_granted'::text, 'superadmin_revoked'::text, 'member_added'::text,
      'member_removed'::text, 'member_role_changed'::text, 'invitation_created'::text,
      'invitation_revoked'::text, 'invitation_accepted'::text, 'link_created'::text,
      'password_changed'::text, 'password_reset'::text, 'settings_changed'::text,
      'workspace_opened'::text]))
    NOT VALID;
