-- Migration 0062: a workspace's home region (data residency, spec §35).
--
-- * mnemo_workspace.region: the MNEMO_REGION of the instance that created the
--   workspace. Its default reads the transaction setting mnemosyne.region, which
--   every server path that creates a workspace sets from MNEMO_REGION (bootstrap,
--   the tenant routes, the dashboard's own workspaces, the dashboard-password
--   script). That way the provisioning functions (0047, 0056) stamp it too,
--   unchanged. NULL for workspaces created before this migration or by an
--   instance without MNEMO_REGION: the region lock lets those through. Nothing
--   updates it afterwards.
-- * mnemo_workspace_region: the region of a workspace, past RLS, for the region
--   lock that runs right after authentication (as mnemo_workspace_tenant_id, 0047).
--
-- DEPLOYMENT ORDER. Before the server code that reads the column.
SET LOCAL lock_timeout = '5s';

-- Two steps, so the rows already there keep NULL.
ALTER TABLE mnemosyne.mnemo_workspace ADD COLUMN region text;
ALTER TABLE mnemosyne.mnemo_workspace
    ALTER COLUMN region SET DEFAULT NULLIF(current_setting('mnemosyne.region', true), '');

CREATE FUNCTION mnemosyne.mnemo_workspace_region(p_workspace_id text)
    RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
  SELECT region FROM mnemosyne.mnemo_workspace WHERE id = p_workspace_id;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_region(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_workspace_region(text) TO app_user, mnemo_app_role;
