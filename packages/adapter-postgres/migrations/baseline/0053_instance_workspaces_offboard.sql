-- Migration 0053 (accounts stage A): the instance plane's workspaces and
-- offboarding.
--
-- * mnemo_instance_list_workspaces: every workspace of the installation, with
--   its tenant, member count and owners, for a superadmin.
-- * mnemo_instance_workspace_members: the members of any workspace.
-- * mnemo_instance_set_member_role / mnemo_instance_remove_member: a
--   superadmin manages the members of any workspace. A workspace keeps at
--   least one owner.
-- * mnemo_instance_offboard: disable a user, move ownership where they are the
--   last owner, drop every membership outside their personal tenant and revoke
--   the API keys bound to them, in one transaction.
--
-- A workspace is personal when its tenant is some user's personal_tenant_id,
-- never by mnemo_tenant.kind: an install's first team workspace can sit in a
-- tenant of kind 'personal' created by the original bootstrap.
--
-- Every function runs as the migration owner (which must bypass RLS, as for
-- 0047, 0049, 0050 and 0052) and checks the actor with mnemo_instance_is_admin.
-- Owner changes in a workspace serialize on its mnemo_workspace row (FOR
-- UPDATE), so two concurrent changes cannot both remove its last owners.
--
-- A workspace keeps at least one owner who can act: the last-owner rules
-- (demote, remove, offboard) count only owners whose user is not disabled.
--
-- DEPLOYMENT ORDER. Before the server code that calls these functions.
SET LOCAL lock_timeout = '5s';

-- is_personal: the tenant is some user's personal tenant. owners: id, email,
-- display_name of each owner, by email.
CREATE FUNCTION mnemosyne.mnemo_instance_list_workspaces(p_actor text)
    RETURNS TABLE (
      id text, name text, tenant_id text, tenant_name text, is_personal boolean,
      visibility text, member_count integer, owners jsonb
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT w.id, w.name, w.tenant_id, t.name,
           EXISTS (SELECT 1 FROM mnemosyne.mnemo_user pu WHERE pu.personal_tenant_id = w.tenant_id),
           w.visibility,
           (SELECT count(*)::integer FROM mnemosyne.mnemo_workspace_member m WHERE m.workspace_id = w.id),
           COALESCE(
             (SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email,
                                                  'display_name', u.display_name)
                               ORDER BY lower(u.email), u.id)
              FROM mnemosyne.mnemo_workspace_member m
              JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
              WHERE m.workspace_id = w.id AND m.role = 'owner'),
             '[]'::jsonb)
    FROM mnemosyne.mnemo_workspace w
    JOIN mnemosyne.mnemo_tenant t ON t.id = w.tenant_id
    ORDER BY lower(w.name), w.id;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_list_workspaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_list_workspaces(text) TO app_user, mnemo_app_role;

-- Raises workspace_not_found (no_data_found) for an unknown workspace, so the
-- caller can tell it from a workspace without members.
CREATE FUNCTION mnemosyne.mnemo_instance_workspace_members(p_actor text, p_workspace text)
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
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_workspace_members(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_workspace_members(text, text) TO app_user, mnemo_app_role;

-- Locks the workspace row, then the membership. Demoting the only enabled
-- owner raises last_owner. Unknown workspace or member: workspace_not_found /
-- member_not_found (no_data_found).
CREATE FUNCTION mnemosyne.mnemo_instance_set_member_role(
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
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_set_member_role(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_set_member_role(text, text, text, text) TO app_user, mnemo_app_role;

-- Same locks and errors as set_member_role. Removing the only enabled owner
-- raises last_owner.
CREATE FUNCTION mnemosyne.mnemo_instance_remove_member(p_actor text, p_workspace text, p_user text)
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
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_remove_member(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_remove_member(text, text, text) TO app_user, mnemo_app_role;

-- Offboarding, in one transaction:
--   1. mnemo_instance_set_disabled (0052) disables the user and ends their
--      sessions. It takes the superadmin advisory lock, refuses the actor
--      themselves (self), an unknown user (user_not_found) and the last active
--      superadmin (last_superadmin), and re-checks the actor under the lock.
--   2. p_new_owners ({workspace id: user id}) names a new owner for a workspace
--      outside the user's personal tenant where the user is an owner. Each new
--      owner must be an enabled user other than the offboarded one; anything
--      else raises invalid_new_owner. A member is promoted; a non-member joins
--      as owner, and joins the workspace's tenant as member if not in it yet
--      (as accepting an invitation does).
--   3. If the user is still the only enabled owner of a workspace outside
--      their personal tenant, raises owner_required:<ids, comma-separated,
--      sorted>, with DETAIL a JSON array of {id, name} of those workspaces.
--   4. Deletes every workspace and tenant membership outside the personal
--      tenant, and revokes every mnemo_api_keys row bound to the user.
--   5. Removes the user's superadmin grant, if any, so re-enabling them later
--      does not restore it. Step 1 already refused the last active superadmin,
--      and the advisory lock it took is still held.
-- The personal tenant, its workspaces, memberships and data stay. Returns
-- whether a superadmin grant was removed (the caller audits it).
CREATE FUNCTION mnemosyne.mnemo_instance_offboard(p_actor text, p_user text, p_new_owners jsonb)
    RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_personal text;
  v_entry record;
  v_owners text;
  v_detail jsonb;
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_new_owners IS NOT NULL AND jsonb_typeof(p_new_owners) <> 'object' THEN
    RAISE EXCEPTION 'invalid_new_owner' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM mnemosyne.mnemo_instance_set_disabled(p_actor, p_user, true);
  SELECT u.personal_tenant_id INTO v_personal FROM mnemosyne.mnemo_user u WHERE u.id = p_user;

  -- Every workspace the user belongs to outside the personal tenant, locked in
  -- id order (the same order as any other owner change takes them one by one).
  PERFORM 1
  FROM mnemosyne.mnemo_workspace w
  WHERE w.tenant_id <> v_personal
    AND w.id IN (SELECT m.workspace_id FROM mnemosyne.mnemo_workspace_member m WHERE m.user_id = p_user)
  ORDER BY w.id
  FOR UPDATE;

  FOR v_entry IN SELECT key AS workspace_id, value AS owner FROM jsonb_each(COALESCE(p_new_owners, '{}'::jsonb))
  LOOP
    IF jsonb_typeof(v_entry.owner) <> 'string'
       OR v_entry.owner #>> '{}' = p_user
       OR NOT EXISTS (
         SELECT 1 FROM mnemosyne.mnemo_user u
         WHERE u.id = v_entry.owner #>> '{}' AND u.disabled_at IS NULL)
       OR NOT EXISTS (
         SELECT 1 FROM mnemosyne.mnemo_workspace_member m
         JOIN mnemosyne.mnemo_workspace w ON w.id = m.workspace_id
         WHERE m.workspace_id = v_entry.workspace_id AND m.user_id = p_user
           AND m.role = 'owner' AND w.tenant_id <> v_personal)
    THEN
      RAISE EXCEPTION 'invalid_new_owner' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role, invited_by)
    VALUES (v_entry.workspace_id, v_entry.owner #>> '{}', 'owner', p_actor)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner';
    INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role, invited_by)
    SELECT w.tenant_id, v_entry.owner #>> '{}', 'member', p_actor
    FROM mnemosyne.mnemo_workspace w WHERE w.id = v_entry.workspace_id
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  END LOOP;

  SELECT string_agg(w.id, ',' ORDER BY w.id),
         jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name) ORDER BY w.id)
  INTO v_owners, v_detail
  FROM mnemosyne.mnemo_workspace_member m
  JOIN mnemosyne.mnemo_workspace w ON w.id = m.workspace_id
  WHERE m.user_id = p_user AND m.role = 'owner' AND w.tenant_id <> v_personal
    AND NOT EXISTS (
      SELECT 1 FROM mnemosyne.mnemo_workspace_member o
      JOIN mnemosyne.mnemo_user ou ON ou.id = o.user_id
      WHERE o.workspace_id = m.workspace_id AND o.role = 'owner' AND o.user_id <> p_user
        AND ou.disabled_at IS NULL);
  IF v_owners IS NOT NULL THEN
    RAISE EXCEPTION 'owner_required:%', v_owners
      USING ERRCODE = 'check_violation', DETAIL = v_detail::text;
  END IF;

  DELETE FROM mnemosyne.mnemo_workspace_member m
  USING mnemosyne.mnemo_workspace w
  WHERE w.id = m.workspace_id AND m.user_id = p_user AND w.tenant_id <> v_personal;
  DELETE FROM mnemosyne.mnemo_tenant_member tm
  WHERE tm.user_id = p_user AND tm.tenant_id <> v_personal;
  UPDATE mnemosyne.mnemo_api_keys k SET revoked_at = clock_timestamp()
  WHERE k.user_id = p_user AND k.revoked_at IS NULL;
  DELETE FROM mnemosyne.mnemo_instance_admin a WHERE a.user_id = p_user;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_offboard(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_offboard(text, text, jsonb) TO app_user, mnemo_app_role;
