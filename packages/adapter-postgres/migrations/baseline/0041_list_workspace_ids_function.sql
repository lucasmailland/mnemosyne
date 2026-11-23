-- Migration 0041: SECURITY DEFINER workspace enumeration for background jobs.
--
-- Every per-workspace background job enumerates workspaces by reading
-- mnemo_fact (and, since 0040, mnemo_session) with no workspace to set
-- `mnemosyne.workspace_id` to — there is none, by design. The server refuses to
-- boot as a superuser or a BYPASSRLS role, so in a correctly-secured deployment
-- it runs as a plain login role holding mnemo_app_role, and FORCE ROW LEVEL
-- SECURITY hides every row from that query. Enumeration returned [] while the
-- workspace held live facts, and the embedding migration, decay, retention and
-- health-snapshot crons, the consolidation scheduler and the session sweeps
-- all iterated zero workspaces without a single error. Measured on a production
-- deployment: 165 live facts, 0 workspaces enumerated, and one fact left
-- without an embedding for weeks because the job that re-embeds it never ran.
--
-- Same mechanism and the same reasoning as 0021
-- (mnemo_claim_pending_webhook_deliveries): one narrow, read-only query runs as
-- the function owner, which bypasses RLS, and returns workspace ids only. The
-- tables keep their per-workspace isolation for every other access path, and no
-- table grant changes. The query is WorkspaceRepository.listWorkspaceIds' own,
-- moved behind the function boundary.

CREATE FUNCTION mnemosyne.mnemo_list_workspace_ids()
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'public'
    AS $$
  SELECT DISTINCT workspace_id::text
  FROM mnemosyne.mnemo_fact
  WHERE status = 'active'
  UNION
  SELECT DISTINCT session.workspace_id
  FROM mnemosyne.mnemo_session AS session
  WHERE session.source_host IS NOT NULL
    AND (
      session.status NOT IN ('collapsed', 'archived')
      OR EXISTS (
        SELECT 1 FROM mnemosyne.mnemo_session_turn AS turn
        WHERE turn.session_id = session.id
          AND turn.workspace_id::text = session.workspace_id
      )
    );
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_list_workspace_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_list_workspace_ids() TO mnemo_app_role;
