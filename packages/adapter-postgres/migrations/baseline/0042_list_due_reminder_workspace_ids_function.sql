-- Migration 0042: SECURITY DEFINER due-reminder workspace enumeration.
--
-- The reminder poller has no workspace id before discovery, so it cannot set
-- mnemosyne.workspace_id for the mnemo_reminder RLS policy. A direct SELECT
-- fails under the production NOSUPERUSER NOBYPASSRLS role and time-only
-- reminders never fire. Like 0041, this narrow function returns workspace ids
-- only, without changing table grants or per-workspace isolation.

CREATE FUNCTION mnemosyne.mnemo_list_due_reminder_workspace_ids()
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'public'
    AS $$
  SELECT DISTINCT workspace_id::text
  FROM mnemosyne.mnemo_reminder
  WHERE status = 'pending'
    AND trigger_at IS NOT NULL
    AND trigger_at <= now()
    AND (condition IS NULL OR btrim(condition) = '');
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_list_due_reminder_workspace_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_list_due_reminder_workspace_ids() TO mnemo_app_role;
