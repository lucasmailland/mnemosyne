-- Migration 0056: users create workspaces they own.
--
-- Any enabled user may create a team workspace from the dashboard. Each one
-- gets its own organization tenant, with the creator as tenant owner and
-- workspace owner, so it is never confused with a personal workspace
-- (mnemo_workspace_is_personal is tenant-based) and takes members and
-- invitations like any team workspace.
--
-- A user who is not a superadmin may own at most p_limit team workspaces
-- (their personal workspace does not count). The server passes the limit from
-- the installation setting workspaceLimitPerUser; the count runs under a
-- per-user advisory lock, so two concurrent requests cannot both pass it.
--
--   mnemo_user_create_workspace(p_actor, p_name, p_limit) → (workspace_id, tenant_id)
--     raises: user_not_allowed (42501), invalid_name (22023),
--             workspace_limit (54000, the detail carries the limit)
--   mnemo_user_workspaces(p_actor) → id, name, role, is_personal, owned_team_count
--
-- Runs as the migration owner (which must bypass RLS, as for 0047 and
-- 0049–0055). DEPLOYMENT ORDER: before the server code that calls it.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION mnemosyne.mnemo_user_owned_team_workspaces(p_user text)
    RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT count(*)::integer
      FROM mnemosyne.mnemo_workspace_member m
      JOIN mnemosyne.mnemo_workspace w ON w.id = m.workspace_id
      JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
      WHERE m.user_id = p_user
        AND m.role = 'owner'
        AND w.tenant_id IS DISTINCT FROM u.personal_tenant_id;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_user_owned_team_workspaces(text) FROM PUBLIC;

CREATE FUNCTION mnemosyne.mnemo_user_create_workspace(
    p_actor text, p_name text, p_limit integer)
    RETURNS TABLE (workspace_id text, tenant_id text)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  v_name text := btrim(COALESCE(p_name, ''));
  v_tenant mnemosyne.mnemo_tenant;
  v_workspace mnemosyne.mnemo_workspace;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_user WHERE id = p_actor AND disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'user_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(v_name) < 1 OR char_length(v_name) > 100 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One creation at a time per user: the count below cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('mnemo_user_create_workspace:' || p_actor, 0));

  IF NOT COALESCE(mnemosyne.mnemo_instance_is_admin(p_actor), false)
     AND mnemosyne.mnemo_user_owned_team_workspaces(p_actor) >= GREATEST(COALESCE(p_limit, 0), 0)
  THEN
    RAISE EXCEPTION 'workspace_limit'
      USING ERRCODE = 'program_limit_exceeded', DETAIL = GREATEST(COALESCE(p_limit, 0), 0)::text;
  END IF;

  INSERT INTO mnemosyne.mnemo_tenant (name, kind, plan)
  VALUES (v_name, 'organization', 'free')
  RETURNING * INTO v_tenant;

  INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role)
  VALUES (v_tenant.id, p_actor, 'owner');

  INSERT INTO mnemosyne.mnemo_workspace (name, tenant_id, owner_user_id, visibility)
  VALUES (v_name, v_tenant.id, p_actor, 'private')
  RETURNING * INTO v_workspace;

  INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
  VALUES (v_workspace.id, p_actor, 'owner');

  RETURN QUERY SELECT v_workspace.id, v_tenant.id;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_user_create_workspace(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_user_create_workspace(text, text, integer) TO app_user, mnemo_app_role;

-- The actor's own workspaces, for the dashboard's workspace switcher.
CREATE FUNCTION mnemosyne.mnemo_user_workspaces(p_actor text)
    RETURNS TABLE (id text, name text, role text, is_personal boolean, owned_team_count integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
#variable_conflict use_column
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_user WHERE id = p_actor AND disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'user_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT w.id, w.name, m.role,
           w.tenant_id IS NOT DISTINCT FROM u.personal_tenant_id,
           mnemosyne.mnemo_user_owned_team_workspaces(p_actor)
    FROM mnemosyne.mnemo_workspace_member m
    JOIN mnemosyne.mnemo_workspace w ON w.id = m.workspace_id
    JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
    WHERE m.user_id = p_actor
    ORDER BY (w.tenant_id IS NOT DISTINCT FROM u.personal_tenant_id) DESC, w.name, w.id;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_user_workspaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_user_workspaces(text) TO app_user, mnemo_app_role;
