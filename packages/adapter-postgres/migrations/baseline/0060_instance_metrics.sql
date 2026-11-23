-- Migration 0060: the Installation rooms' figures, for superadmins.
--
-- * mnemo_instance_workspace_figures: per workspace, the live facts at or under
--   the given sensitivity tiers and the latest of those facts' writes. One grouped
--   read over mnemo_fact, the same "live" as /facts/stats (valid_to IS NULL, active).
-- * mnemo_instance_audit_stats: the security actions mnemo_instance_audit lists
--   (0055), counted per UTC day and action since p_since. The list function
--   pages 50 at a time and caps a page at 201 rows, so it cannot be counted.
--
-- Both run as the migration owner (which must bypass RLS, as for 0053 and 0055)
-- and check the actor with mnemo_instance_is_admin.
--
-- DEPLOYMENT ORDER. Before the server code that calls these functions.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION mnemosyne.mnemo_instance_workspace_figures(p_actor text, p_tiers text[])
    RETURNS TABLE (workspace_id text, facts_live integer, last_write_at timestamptz)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT COALESCE(mnemosyne.mnemo_instance_is_admin(p_actor), false) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One predicate for both figures: the last write is the latest live fact the
  -- caller can read, so a closed or above-ceiling fact never shows through its
  -- timestamp. A workspace with no such fact has no row (the route reads 0 / null).
  RETURN QUERY
    SELECT f.workspace_id, count(*)::integer, max(f.created_at)
    FROM mnemosyne.mnemo_fact f
    WHERE f.valid_to IS NULL AND f.status = 'active' AND f.sensitivity = ANY (p_tiers)
    GROUP BY f.workspace_id;
END;
$$;

CREATE FUNCTION mnemosyne.mnemo_instance_audit_stats(p_actor text, p_since timestamptz)
    RETURNS TABLE (day text, action text, n integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  -- The same list as mnemo_instance_audit (0055).
  v_security text[] := ARRAY[
    'login_success', 'login_failure', 'user_created', 'user_disabled', 'user_enabled',
    'user_offboarded', 'superadmin_granted', 'superadmin_revoked', 'member_added',
    'member_removed', 'member_role_changed', 'invitation_created', 'invitation_revoked',
    'invitation_accepted', 'link_created', 'password_changed', 'password_reset',
    'settings_changed', 'workspace_opened', 'key_create', 'key_rotate', 'key_revoke'];
BEGIN
  IF NOT COALESCE(mnemosyne.mnemo_instance_is_admin(p_actor), false) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT to_char((a.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD'), a.action,
           count(*)::integer
    FROM mnemosyne.mnemo_audit_log a
    WHERE a.action = ANY (v_security) AND a.created_at >= p_since
    GROUP BY 1, 2;
END;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_workspace_figures(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_workspace_figures(text, text[]) TO app_user, mnemo_app_role;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_audit_stats(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_audit_stats(text, timestamptz) TO app_user, mnemo_app_role;
