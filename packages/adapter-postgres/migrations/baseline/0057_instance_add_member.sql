-- 0057: a superadmin adds an existing user to any team workspace.
--
-- Until now the instance plane could change a member's role and remove one,
-- but not add anybody, so a workspace with no owner (created with an operator
-- key, or left behind) could not be managed by anyone. This lets a superadmin
-- give it an owner, or add any other member, from Installation > All workspaces.
--
-- mnemo_instance_add_member(p_actor, p_workspace, p_email, p_role) returns the
-- added user's id. Errors:
--   not_superadmin      42501   the actor is not a superadmin
--   invalid_role        22023   p_role not owner/admin/write/read
--   workspace_not_found P0002   no such workspace
--   personal_workspace  23514   the workspace is some user's personal one
--   unknown_email       23514   no account with that email
--   ambiguous_email     23514   more than one account with that email
--   user_disabled       23514   the account is disabled
--   already_member      23514   the user already belongs to the workspace
-- The user also joins the workspace's tenant as member when not in it yet, as
-- accepting an invitation does (and as offboarding does for a new owner).
CREATE FUNCTION mnemosyne.mnemo_instance_add_member(
    p_actor text, p_workspace text, p_email text, p_role text)
    RETURNS text
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_tenant text;
  v_user text;
  v_accounts integer;
  v_disabled boolean;
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'write', 'read') THEN
    RAISE EXCEPTION 'invalid_role' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT w.tenant_id INTO v_tenant FROM mnemosyne.mnemo_workspace w
  WHERE w.id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM mnemosyne.mnemo_user u WHERE u.personal_tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'personal_workspace' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), min(u.id), bool_or(u.disabled_at IS NOT NULL)
    INTO v_accounts, v_user, v_disabled
  FROM mnemosyne.mnemo_user u WHERE lower(btrim(u.email)) = v_email;
  IF v_email = '' OR v_accounts = 0 THEN
    RAISE EXCEPTION 'unknown_email' USING ERRCODE = 'check_violation';
  ELSIF v_accounts > 1 THEN
    RAISE EXCEPTION 'ambiguous_email' USING ERRCODE = 'check_violation';
  ELSIF v_disabled THEN
    RAISE EXCEPTION 'user_disabled' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role, invited_by)
  VALUES (p_workspace, v_user, p_role, p_actor)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role, invited_by)
  VALUES (v_tenant, v_user, 'member', p_actor)
  ON CONFLICT (tenant_id, user_id) DO NOTHING;
  RETURN v_user;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_add_member(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_add_member(text, text, text, text) TO app_user, mnemo_app_role;
