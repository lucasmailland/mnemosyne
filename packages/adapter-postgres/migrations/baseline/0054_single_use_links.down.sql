-- Reverts 0054. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: the member,
-- invitation and link routes of this change call these functions.
--
-- Every single-use link is dropped with its table: links already handed out
-- stop working. Memberships and accounts created by accepted links stay, and
-- keys revoked by a member removal stay revoked (the 0053 removal revokes none).
-- The 0053 instance member functions get their 0053 bodies back.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_link_consume(text, text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_link_describe(text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_invitation_revoke(text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_invitation_regenerate(text, text, text, text, interval);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_link_issue(text, text, text, text, text, text, interval, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_remove_member(text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_set_member_role(text, text, text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_invitations(text, text);

-- 0053's definitions.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_workspace_members(p_actor text, p_workspace text)
    RETURNS TABLE (
      user_id text, email text, display_name text, role text, joined_at timestamptz
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM mnemosyne.mnemo_workspace w WHERE w.id = p_workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
    SELECT u.id, u.email, u.display_name, m.role, m.joined_at
    FROM mnemosyne.mnemo_workspace_member m
    JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
    WHERE m.workspace_id = p_workspace
    ORDER BY lower(u.email), u.id;
END;
$$;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_set_member_role(
    p_actor text, p_workspace text, p_user text, p_role text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_role text;
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'write', 'read') THEN
    RAISE EXCEPTION 'invalid_role' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM mnemosyne.mnemo_workspace w WHERE w.id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT m.role INTO v_role FROM mnemosyne.mnemo_workspace_member m
  WHERE m.workspace_id = p_workspace AND m.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role = 'owner' AND p_role <> 'owner' AND NOT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_workspace_member m
    JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
    WHERE m.workspace_id = p_workspace AND m.role = 'owner' AND m.user_id <> p_user
      AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'last_owner' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE mnemosyne.mnemo_workspace_member m SET role = p_role
  WHERE m.workspace_id = p_workspace AND m.user_id = p_user;
END;
$$;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_remove_member(p_actor text, p_workspace text, p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_role text;
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM mnemosyne.mnemo_workspace w WHERE w.id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT m.role INTO v_role FROM mnemosyne.mnemo_workspace_member m
  WHERE m.workspace_id = p_workspace AND m.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_workspace_member m
    JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
    WHERE m.workspace_id = p_workspace AND m.role = 'owner' AND m.user_id <> p_user
      AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'last_owner' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM mnemosyne.mnemo_workspace_member m
  WHERE m.workspace_id = p_workspace AND m.user_id = p_user;
END;
$$;

DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_member_profiles(text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_link_usable(mnemosyne.mnemo_link_token);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_link_email_lock(text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_member_apply(text, text, text, boolean, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_lock_as_admin(text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_lock(text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_active_role(text, text);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_workspace_is_personal(text);
DROP TABLE IF EXISTS mnemosyne.mnemo_link_token;
COMMIT;
