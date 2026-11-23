-- Migration 0012: fix infinite recursion in mnemo_workspace_member's RLS
-- policies (and, as a direct consequence, every read of mnemo_workspace
-- that depends on them).
--
-- mnemo_workspace_member_read's USING clause (0001_v3_complete_baseline.sql)
-- does:
--   EXISTS (SELECT 1 FROM mnemosyne.mnemo_workspace_member self WHERE
--           self.workspace_id = mnemo_workspace_member.workspace_id AND
--           self.user_id = current_setting('mnemosyne.actor_user_id', true))
-- — a policy ON mnemo_workspace_member that subqueries mnemo_workspace_member
-- itself. Evaluating that EXISTS requires re-applying mnemo_workspace_member's
-- own RLS policy to the subquery's rows, which requires evaluating the same
-- EXISTS again, forever. Postgres detects this and throws
-- "infinite recursion detected in policy for relation \"mnemo_workspace_member\""
-- for ANY real, non-bypassing (NOSUPERUSER/NOBYPASSRLS) read of this table —
-- confirmed this reproduces unconditionally, not just for edge cases, in
-- both the memory_status audit (docs/STATUS.md, GET /me's personalWorkspaceId
-- resolution — silently swallowed to null there) and the memory_workspace
-- audit (docs/STATUS.md — surfaces as an unhandled HTTP 500 on
-- GET /workspaces/mine, GET /tenants/:tenantId/workspaces, and
-- GET /workspaces/:workspaceId, since mnemo_workspace_read's own policy
-- ALSO subqueries mnemo_workspace_member and inherits the same recursion).
-- mnemo_workspace_member_write has the identical shape (an "admin_check"
-- self-subquery).
--
-- Standard fix for this well-known Postgres RLS anti-pattern (a policy that
-- subqueries its own table to check "is there ANOTHER row for this
-- workspace/user", as opposed to "is THIS row mine"): move the self-check
-- into a SECURITY DEFINER function. The function runs with the privileges
-- of its owner (whichever role applies this migration — the same
-- superuser/BYPASSRLS-equivalent role every other migration in this
-- directory already runs as, confirmed by every integration test in this
-- repo applying migrations via a plain superuser connection before
-- provisioning the restricted NOSUPERUSER mnemo_app role), so its internal
-- query bypasses RLS entirely instead of re-triggering the same policy.
-- This breaks the cycle without weakening the actual authorization check —
-- the function still requires an exact (workspace_id, user_id[, role])
-- match; it just evaluates that match through a privileged path instead of
-- one that RLS reapplies to itself.

-- mnemo_workspace_member.workspace_id is `text`, not `uuid` (see its
-- CREATE TABLE above this migration) — matching that exactly here, since
-- passing a mismatched type would fail to resolve against this overload
-- (or silently pick a different one) rather than erroring loudly.
CREATE OR REPLACE FUNCTION mnemosyne.is_workspace_member(p_workspace_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = mnemosyne, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_workspace_member
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION mnemosyne.is_workspace_admin(p_workspace_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = mnemosyne, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_workspace_member
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id
      AND role = ANY (ARRAY['owner'::text, 'admin'::text])
  );
$$;

-- Neither function is meant to be called directly by application code —
-- they exist solely as RLS-policy building blocks — but EXECUTE must be
-- granted explicitly since PostgreSQL revokes PUBLIC EXECUTE by default
-- only for functions created by non-superusers; being deliberate here
-- either way costs nothing and documents the intent.
GRANT EXECUTE ON FUNCTION mnemosyne.is_workspace_member(text, text) TO app_user, mnemo_app_role;
GRANT EXECUTE ON FUNCTION mnemosyne.is_workspace_admin(text, text) TO app_user, mnemo_app_role;

DROP POLICY IF EXISTS mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member FOR SELECT USING (
  mnemosyne.is_workspace_member(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (user_id = current_setting('mnemosyne.actor_user_id', true))
  OR (current_setting('mnemosyne.actor_user_id', true) = ''::text)
  OR (current_setting('mnemosyne.actor_user_id', true) IS NULL)
);

DROP POLICY IF EXISTS mnemo_workspace_member_write ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_write ON mnemosyne.mnemo_workspace_member USING (
  mnemosyne.is_workspace_admin(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (current_setting('mnemosyne.actor_user_id', true) = ''::text)
  OR (current_setting('mnemosyne.actor_user_id', true) IS NULL)
);
