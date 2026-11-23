-- Migration 0022: let a tenant owner/admin read ANOTHER user's
-- mnemo_workspace_member row for a workspace inside their own tenant.
--
-- Found while building S6 (user-token provisioning, multi-tenancy closure
-- plan): POST /tenants/:tenantId/users/:userId/tokens
-- (packages/server/src/routes/user-tokens.ts) has a tenant owner/admin
-- (already verified via requireTenantAdmin, which reads mnemo_tenant_member
-- -- a purely tenant-scoped policy, see 0001_v3_complete_baseline.sql)
-- look up a DIFFERENT user's role in the target workspace via
-- TenantRepository.getWorkspaceMemberRole(homeWorkspaceId, targetUserId).
--
-- mnemo_workspace_member_read (0012_workspace_member_rls_recursion.sql)
-- only allows: (a) the row being read is the CALLER's own
-- (user_id = actor_user_id), or (b) the caller happens to ALSO be a member
-- of that same workspace (is_workspace_member). Neither holds for a tenant
-- admin who oversees a workspace without personally being a member of it --
-- a very plausible shape (an org admin managing many workspaces they don't
-- do day-to-day work in). RLS silently filters the row out, and
-- user-tokens.ts's getWorkspaceMemberRole(...) === null branch reports back
-- "Target user is not a member of homeWorkspaceId" even though they
-- genuinely are -- a false negative, not a real authorization decision.
-- Every OTHER existing tenants.ts route that calls getWorkspaceMemberRole
-- only ever checks the CALLER's own row (requireWorkspaceAdmin), so this
-- gap was invisible until S6 introduced the first "read someone else's
-- membership row" access pattern.
--
-- Fix: same SECURITY DEFINER mechanism 0012 already established (breaks the
-- self-referential-policy recursion problem by evaluating the check through
-- a privileged path). This one is NOT self-referential -- it joins
-- mnemo_workspace (to resolve the workspace's tenant_id) and
-- mnemo_tenant_member (to check the caller's tenant role) -- but SECURITY
-- DEFINER is used regardless so the helper's internal reads are never
-- themselves re-filtered by the RLS policies on those two tables, keeping
-- this a single, auditable, narrowly-scoped boundary rather than a query
-- shape that happens to work today and could silently break if those
-- tables' own policies change.
CREATE OR REPLACE FUNCTION mnemosyne.is_tenant_admin_for_workspace(p_workspace_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = mnemosyne, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM mnemosyne.mnemo_workspace w
    JOIN mnemosyne.mnemo_tenant_member tm ON tm.tenant_id = w.tenant_id
    WHERE w.id = p_workspace_id
      AND tm.user_id = p_user_id
      AND tm.role = ANY (ARRAY['owner'::text, 'admin'::text])
  );
$$;

GRANT EXECUTE ON FUNCTION mnemosyne.is_tenant_admin_for_workspace(text, text) TO app_user, mnemo_app_role;

DROP POLICY IF EXISTS mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member FOR SELECT USING (
  mnemosyne.is_workspace_member(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (user_id = current_setting('mnemosyne.actor_user_id', true))
  OR mnemosyne.is_tenant_admin_for_workspace(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (current_setting('mnemosyne.actor_user_id', true) = ''::text)
  OR (current_setting('mnemosyne.actor_user_id', true) IS NULL)
);
