-- Migration 0055 (accounts stage A): the security audit for superadmins.
--
-- mnemo_instance_audit reads mnemo_audit_log across every workspace, the
-- global sentinel (instance-level events) included, and returns only the
-- security actions: the ones 0050 added (sign-ins, accounts, superadmin grants,
-- members, invitations, links, passwords, settings and opened workspaces) plus
-- API key creation, rotation and revocation (spec §6). Fact and other
-- operational rows (recall, create, ...) never come out of it.
--
-- Newest first, keyset-paginated on (created_at, id): a page ends at the last
-- row's pair and the next one starts strictly below it, so rows written while
-- someone pages never repeat or shift a page. created_at is the partition key
-- and idx_audit_action (action, created_at DESC) exists on every partition, so
-- the query reads only the security actions' index entries, and the time
-- bounds (from, to, cursor) prune partitions; the bounds are never NULL in the
-- WHERE clause (COALESCE to +-infinity) so pruning also works on a generic plan.
--
-- Runs as the migration owner (which must bypass RLS, as for 0047, 0049, 0050,
-- 0052, 0053 and 0054) and checks the actor with mnemo_instance_is_admin.
--
-- DEPLOYMENT ORDER. Before the server code that calls it.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION mnemosyne.mnemo_instance_audit(
    p_actor text,
    p_action text DEFAULT NULL,
    p_actor_id text DEFAULT NULL,
    p_from timestamptz DEFAULT NULL,
    p_to timestamptz DEFAULT NULL,
    p_cursor_at timestamptz DEFAULT NULL,
    p_cursor_id bigint DEFAULT NULL,
    p_limit integer DEFAULT 50)
    RETURNS TABLE (
      id bigint, workspace_id uuid, actor_type text, actor_id text, actor_email text,
      action text, resource text, resource_id text, metadata jsonb, created_at timestamptz
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  -- The security actions of 0050 and the API key actions, and only those.
  v_security text[] := ARRAY[
    'login_success', 'login_failure', 'user_created', 'user_disabled', 'user_enabled',
    'user_offboarded', 'superadmin_granted', 'superadmin_revoked', 'member_added',
    'member_removed', 'member_role_changed', 'invitation_created', 'invitation_revoked',
    'invitation_accepted', 'link_created', 'password_changed', 'password_reset',
    'settings_changed', 'workspace_opened', 'key_create', 'key_rotate', 'key_revoke'];
  v_actions text[];
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 201);
BEGIN
  -- COALESCE: a NULL here must refuse, never let the caller through.
  IF NOT COALESCE(mnemosyne.mnemo_instance_is_admin(p_actor), false) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_cursor_at IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- An action outside the list matches nothing (empty array), never everything.
  v_actions := CASE
    WHEN p_action IS NULL THEN v_security
    WHEN p_action = ANY (v_security) THEN ARRAY[p_action]
    ELSE ARRAY[]::text[]
  END;
  RETURN QUERY
    SELECT page.id, page.workspace_id, page.actor_type, page.actor_id, u.email,
           page.action, page.resource, page.resource_id, page.metadata, page.created_at
    FROM (
      SELECT a.id, a.workspace_id, a.actor_type, a.actor_id, a.action, a.resource,
             a.resource_id, a.metadata, a.created_at
      FROM mnemosyne.mnemo_audit_log a
      WHERE a.action = ANY (v_actions)
        AND a.created_at >= COALESCE(p_from, '-infinity'::timestamptz)
        AND a.created_at <= COALESCE(p_to, 'infinity'::timestamptz)
        AND a.created_at <= COALESCE(p_cursor_at, 'infinity'::timestamptz)
        AND (p_cursor_at IS NULL OR (a.created_at, a.id) < (p_cursor_at, p_cursor_id))
        AND (p_actor_id IS NULL OR a.actor_id = p_actor_id)
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT v_limit
    ) page
    LEFT JOIN mnemosyne.mnemo_user u
      ON page.actor_id LIKE 'user:%' AND u.id = substr(page.actor_id, 6)
    ORDER BY page.created_at DESC, page.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_audit(text, text, text, timestamptz, timestamptz, timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_audit(text, text, text, timestamptz, timestamptz, timestamptz, bigint, integer) TO app_user, mnemo_app_role;
