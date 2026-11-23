-- Migration 0052 (accounts stage A): the instance plane's user management.
--
-- * mnemo_instance_list_users: every user of the installation, with the
--   workspaces they belong to and their role there, for a superadmin.
-- * mnemo_instance_set_disabled: disable or re-enable a user. Disabling ends
--   the user's sessions and keeps the last-superadmin rule of 0050.
-- * mnemo_instance_grant_admin (0050) now refuses a disabled or unknown user.
-- * disabled_at is no longer writable by the app roles: only the definer
--   functions above (and the migration owner) change it.
--
-- Every function runs as the migration owner (which must bypass RLS, as for
-- 0047, 0049 and 0050) and re-checks the actor with mnemo_instance_is_admin.
--
-- DEPLOYMENT ORDER. Before the server code that calls these functions. Old code
-- never writes disabled_at.
SET LOCAL lock_timeout = '5s';

-- is_superadmin means "holds the grant" here, unlike mnemo_user_status: with
-- disabled_at beside it the caller sees a disabled superadmin as such.
CREATE FUNCTION mnemosyne.mnemo_instance_list_users(p_actor text)
    RETURNS TABLE (
      id text, email text, display_name text, created_at timestamptz,
      last_login_at timestamptz, disabled_at timestamptz, is_superadmin boolean,
      workspaces jsonb
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT u.id, u.email, u.display_name, u.created_at, u.last_login_at, u.disabled_at,
           EXISTS (SELECT 1 FROM mnemosyne.mnemo_instance_admin a WHERE a.user_id = u.id),
           COALESCE(
             (SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'role', m.role)
                               ORDER BY w.name, w.id)
              FROM mnemosyne.mnemo_workspace_member m
              JOIN mnemosyne.mnemo_workspace w ON w.id = m.workspace_id
              WHERE m.user_id = u.id),
             '[]'::jsonb)
    FROM mnemosyne.mnemo_user u
    ORDER BY lower(u.email), u.id;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_list_users(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_list_users(text) TO app_user, mnemo_app_role;

-- Disabling sets disabled_at once (a repeat keeps the first time) and moves
-- sessions_valid_after, so every open session ends. Enabling clears
-- disabled_at only: sessions from before the disable stay dead.
--
-- Same advisory lock as grant and revoke (0050). A disabled superadmin is no
-- longer active, so disabling the last active one is refused; that rule is
-- checked before the actor's own standing under the lock, as in revoke. Nobody
-- disables themselves.
CREATE FUNCTION mnemosyne.mnemo_instance_set_disabled(p_actor text, p_user text, p_disabled boolean)
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
  IF p_disabled AND p_actor = p_user THEN
    RAISE EXCEPTION 'self' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('mnemo_instance_admin'));
  PERFORM 1 FROM mnemosyne.mnemo_user WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_disabled AND mnemosyne.mnemo_instance_is_admin(p_user) THEN
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
  END IF;
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_disabled THEN
    UPDATE mnemosyne.mnemo_user
    SET disabled_at = COALESCE(disabled_at, clock_timestamp()),
        sessions_valid_after = clock_timestamp()
    WHERE id = p_user;
  ELSE
    UPDATE mnemosyne.mnemo_user SET disabled_at = NULL WHERE id = p_user;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_set_disabled(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_set_disabled(text, text, boolean) TO app_user, mnemo_app_role;

-- 0050's grant, plus: the user must exist and be enabled, checked under the
-- lock set_disabled takes, so a concurrent disable cannot slip in between.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_grant_admin(p_actor text, p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_disabled_at timestamptz;
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('mnemo_instance_admin'));
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT u.disabled_at INTO v_disabled_at FROM mnemosyne.mnemo_user u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'user_disabled' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by)
  VALUES (p_user, p_actor)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- disabled_at is written only by the definer functions. A column REVOKE has no
-- effect while the table-level UPDATE grant stands, so take the table-level
-- grant back and hand UPDATE on every other column again. sessions_valid_after
-- and last_login_at stay writable: password changes and sign-ins write them as
-- app_user, under mnemo_user_own. docker/scripts/provision-app-role.mjs repeats
-- this for mnemo_app_role after its blanket grant on every deploy, and picks up
-- columns added later; a migration that adds a column app code updates must
-- grant it too.
DO $grant$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_columns
  FROM pg_attribute
  WHERE attrelid = 'mnemosyne.mnemo_user'::regclass
    AND attnum > 0 AND NOT attisdropped AND attname <> 'disabled_at';
  REVOKE UPDATE ON TABLE mnemosyne.mnemo_user FROM app_user, mnemo_app_role;
  EXECUTE format('GRANT UPDATE (%s) ON TABLE mnemosyne.mnemo_user TO app_user, mnemo_app_role', v_columns);
END $grant$;
