-- Migration 0047: tenant and workspace provisioning under RLS (SEC-5,
-- PRIM-17, RECALL-14, CLIENTS-11, AGENTSIM-12).
--
-- With a tenant-bound key, the tenant routes run with
-- mnemosyne.actor_tenant_id and mnemosyne.actor_user_id set, and every
-- provisioning write failed on RLS with a 500:
--
--   * POST /tenants, POST /users and an invitation with createIfMissing
--     insert a mnemo_tenant row whose generated id is never the caller's
--     tenant (mnemo_tenant_write), then a mnemo_user row that is never the
--     caller (mnemo_user_own), then memberships of that new tenant
--     (mnemo_tenant_member_write).
--   * POST /tenants/:tenantId/workspaces with an owner inserts the first
--     mnemo_workspace_member row, and mnemo_workspace_member_write only lets
--     an existing owner/admin of that workspace write one. A new workspace
--     has none, so the only call that worked created a workspace nobody
--     belonged to.
--   * An invitation looked the email up through mnemo_user_own, which hides
--     every user but the caller: a member of the tenant read as missing.
--
-- Only a key with no tenant and no user passed, through the empty-GUC
-- fallbacks those policies keep for it (AUTH-TENANT-RLS-FALLBACK).
--
-- Two mechanisms, both narrow:
--
-- 1. SECURITY DEFINER functions that create a whole new tenant or account in
--    one call. They generate every id themselves and take no existing tenant,
--    user or workspace as input, so they cannot write into anything that
--    already exists. They refuse a caller with a user GUC who is not owner or
--    admin of the tenant in mnemosyne.actor_tenant_id; a caller with no user
--    GUC (a key with no user) keeps what the fallbacks already give it. They
--    run inside the caller's transaction: a later failure rolls them back.
--    Same mechanism as 0021 and 0041: the body runs as the function owner,
--    the role that applies migrations, which bypasses RLS.
--
-- 2. An INSERT-only policy for the first owner of a workspace. It admits one
--    row shape: role 'owner', for the user the workspace row declares as its
--    owner_user_id, in a workspace that has no member yet, of the tenant in
--    mnemosyne.actor_tenant_id, written by an owner or admin of that tenant,
--    for a user who belongs to it. The workspace row itself still goes
--    through mnemo_workspace_write. UPDATE and DELETE are untouched: a tenant
--    admin gets no say over a workspace that already has members.
--
-- 3. Part of AUTH-TENANT-RLS-FALLBACK. A key with no tenant and no user (the
--    bootstrap and setup keys, the keys minted from them, every mk_* key) ran
--    the tenant routes with no GUC, and the empty-GUC branches let it see and
--    write every tenant's workspaces and memberships: the AUTH-TENANT-NULL
--    guards were the only barrier. The routes now set its home tenant as
--    mnemosyne.actor_tenant_id, found through mnemo_workspace_tenant_id below
--    instead of through the fallback itself, and the two
--    mnemo_workspace_member policies admit a caller with no user only in the
--    workspaces of that tenant. With no GUC at all they admit nothing. The
--    fallbacks of mnemo_tenant, mnemo_tenant_member, mnemo_user and
--    mnemo_workspace stay: the bootstrap, the setup wizard and the personal
--    workspace lookup of multi-level recall still write or read through them.
--
-- Safe on a live database: new functions and policies, and one nullable column
-- on mnemo_user (no default, so no rewrite); no data change.
-- CREATE POLICY takes a short ACCESS EXCLUSIVE lock on mnemo_workspace_member.
-- Re-runnable by hand (CREATE OR REPLACE, DROP POLICY IF EXISTS).

-- ── Who may provision ────────────────────────────────────────────────────────
-- Internal: called only from the functions below, as their owner.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_actor_may_provision()
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
  SELECT COALESCE(current_setting('mnemosyne.actor_user_id', true), '') = ''
      OR EXISTS (
        SELECT 1 FROM mnemosyne.mnemo_tenant_member
        WHERE tenant_id = current_setting('mnemosyne.actor_tenant_id', true)
          AND user_id = current_setting('mnemosyne.actor_user_id', true)
          AND role = ANY (ARRAY['owner'::text, 'admin'::text])
      );
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_actor_may_provision() FROM PUBLIC;

-- ── A new tenant, owned by the caller ────────────────────────────────────────
-- A caller with a user becomes the tenant's owner: a tenant nobody belongs to
-- can only ever be reached by a key with no user. With p_workspace_name, the
-- same call also creates the tenant's first workspace, owned by that user, so
-- the route can mint the user a token bound to the new tenant
-- (POST /tenants issueOwnerToken): its current key acts in its old tenant.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_provision_tenant(
    p_name text, p_kind text, p_plan text, p_workspace_name text)
    RETURNS TABLE (
      tenant_id text,
      tenant_name text,
      tenant_kind text,
      tenant_plan text,
      tenant_created_at text,
      workspace_id text,
      workspace_name text,
      workspace_slug text,
      workspace_visibility text,
      workspace_created_at text
    )
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  v_actor text := NULLIF(current_setting('mnemosyne.actor_user_id', true), '');
  v_tenant mnemosyne.mnemo_tenant;
  v_workspace mnemosyne.mnemo_workspace;
BEGIN
  IF NOT mnemosyne.mnemo_actor_may_provision() THEN
    RAISE EXCEPTION 'tenant owner or admin role required to create a tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_workspace_name IS NOT NULL AND v_actor IS NULL THEN
    RAISE EXCEPTION 'a first workspace needs a caller with a user to own it'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO mnemosyne.mnemo_tenant (name, kind, plan)
  VALUES (p_name, p_kind, COALESCE(p_plan, 'free'))
  RETURNING * INTO v_tenant;

  IF v_actor IS NOT NULL THEN
    INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role)
    VALUES (v_tenant.id, v_actor, 'owner');
  END IF;

  IF p_workspace_name IS NOT NULL THEN
    INSERT INTO mnemosyne.mnemo_workspace (name, tenant_id, owner_user_id, visibility)
    VALUES (p_workspace_name, v_tenant.id, v_actor, 'private')
    RETURNING * INTO v_workspace;

    INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
    VALUES (v_workspace.id, v_actor, 'owner');
  END IF;

  RETURN QUERY SELECT
    v_tenant.id, v_tenant.name, v_tenant.kind, v_tenant.plan, v_tenant.created_at::text,
    v_workspace.id, v_workspace.name, v_workspace.slug, v_workspace.visibility,
    v_workspace.created_at::text;
END;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_provision_tenant(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_provision_tenant(text, text, text, text) TO mnemo_app_role;

-- ── Which tenant provisioned an account ──────────────────────────────────────
-- Set by mnemo_provision_user to the caller's tenant. That tenant's admins may
-- find the account by email and bring it in (mnemo_find_user_id_by_email):
-- they created it, as a createIfMissing invitation does in one call. NULL for
-- accounts created before 0047 and by the bootstrap. Nullable, no default:
-- adding it rewrites nothing.
ALTER TABLE mnemosyne.mnemo_user ADD COLUMN IF NOT EXISTS provisioned_by_tenant_id text;

-- ── A new account: user, personal tenant, personal workspace ─────────────────
-- The flow POST /users and a createIfMissing invitation share. A taken email
-- raises unique_violation on mnemo_user_email_key.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_provision_user(
    p_email text, p_display_name text, p_workspace_name text)
    RETURNS TABLE (
      user_id text,
      user_email text,
      user_display_name text,
      user_created_at text,
      tenant_id text,
      tenant_name text,
      tenant_kind text,
      tenant_plan text,
      tenant_created_at text,
      workspace_id text,
      workspace_name text,
      workspace_slug text,
      workspace_visibility text,
      workspace_created_at text
    )
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  v_tenant mnemosyne.mnemo_tenant;
  v_user mnemosyne.mnemo_user;
  v_workspace mnemosyne.mnemo_workspace;
BEGIN
  IF NOT mnemosyne.mnemo_actor_may_provision() THEN
    RAISE EXCEPTION 'tenant owner or admin role required to create a user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO mnemosyne.mnemo_tenant (name, kind, plan)
  VALUES (p_email, 'personal', 'free')
  RETURNING * INTO v_tenant;

  INSERT INTO mnemosyne.mnemo_user (email, display_name, personal_tenant_id, provisioned_by_tenant_id)
  VALUES (p_email, p_display_name, v_tenant.id,
          NULLIF(current_setting('mnemosyne.actor_tenant_id', true), ''))
  RETURNING * INTO v_user;

  INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role)
  VALUES (v_tenant.id, v_user.id, 'owner');

  INSERT INTO mnemosyne.mnemo_workspace (name, tenant_id, owner_user_id, visibility)
  VALUES (p_workspace_name, v_tenant.id, v_user.id, 'private')
  RETURNING * INTO v_workspace;

  INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
  VALUES (v_workspace.id, v_user.id, 'owner');

  RETURN QUERY SELECT
    v_user.id, v_user.email, v_user.display_name, v_user.created_at::text,
    v_tenant.id, v_tenant.name, v_tenant.kind, v_tenant.plan, v_tenant.created_at::text,
    v_workspace.id, v_workspace.name, v_workspace.slug, v_workspace.visibility,
    v_workspace.created_at::text;
END;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_provision_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_provision_user(text, text, text) TO mnemo_app_role;

-- ── An email to a user id, for invitations ───────────────────────────────────
-- Returns the id only, NULL when nobody the caller may invite has the email.
-- A caller with a user finds members of its own tenant and accounts its tenant
-- provisioned (POST /users, then the invitation). Anyone else would be an
-- account it could pull into its tenant without that user's say, then
-- mint a token for (POST /tenants/:tenantId/users/:userId/tokens), and a user
-- token switches into every workspace its user belongs to, in any tenant: the
-- personal workspace included. A caller with no user keeps what the fallbacks
-- already showed it.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_find_user_id_by_email(p_email text)
    RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_actor_may_provision() THEN
    RAISE EXCEPTION 'tenant owner or admin role required to look up a user by email'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (
    SELECT u.id FROM mnemosyne.mnemo_user u
    WHERE u.email = p_email
      AND (
        COALESCE(current_setting('mnemosyne.actor_user_id', true), '') = ''
        OR EXISTS (
          SELECT 1 FROM mnemosyne.mnemo_tenant_member tm
          WHERE tm.tenant_id = current_setting('mnemosyne.actor_tenant_id', true)
            AND tm.user_id = u.id
        )
        OR u.provisioned_by_tenant_id = current_setting('mnemosyne.actor_tenant_id', true)
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_find_user_id_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_find_user_id_by_email(text) TO mnemo_app_role;

-- ── The first owner of a workspace ───────────────────────────────────────────
-- Policy building block, like is_workspace_admin (0012): every role that
-- inserts into mnemo_workspace_member evaluates it, so both get EXECUTE.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_can_seed_workspace_owner(
    p_workspace_id text, p_user_id text, p_actor_user_id text, p_actor_tenant_id text)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM mnemosyne.mnemo_workspace w
    WHERE w.id = p_workspace_id
      AND w.owner_user_id = p_user_id
      AND w.tenant_id = p_actor_tenant_id
      AND EXISTS (
        SELECT 1 FROM mnemosyne.mnemo_tenant_member actor
        WHERE actor.tenant_id = w.tenant_id
          AND actor.user_id = p_actor_user_id
          AND actor.role = ANY (ARRAY['owner'::text, 'admin'::text])
      )
      AND EXISTS (
        SELECT 1 FROM mnemosyne.mnemo_tenant_member seeded
        WHERE seeded.tenant_id = w.tenant_id AND seeded.user_id = p_user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mnemosyne.mnemo_workspace_member m WHERE m.workspace_id = w.id
      )
  );
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_can_seed_workspace_owner(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_can_seed_workspace_owner(text, text, text, text)
  TO app_user, mnemo_app_role;

DROP POLICY IF EXISTS mnemo_workspace_member_seed_owner ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_seed_owner ON mnemosyne.mnemo_workspace_member
  FOR INSERT WITH CHECK (
    role = 'owner'::text
    AND mnemosyne.mnemo_can_seed_workspace_owner(
      workspace_id,
      user_id,
      current_setting('mnemosyne.actor_user_id', true),
      current_setting('mnemosyne.actor_tenant_id', true)
    )
  );

-- ── The tenant of a workspace, past RLS ──────────────────────────────────────
-- For the home tenant of a key with no tenant (resolveCallerTenant), and for
-- the policies below: reading mnemo_workspace from a mnemo_workspace_member
-- policy under RLS would recurse through mnemo_workspace_read.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_workspace_tenant_id(p_workspace_id text)
    RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
  SELECT tenant_id FROM mnemosyne.mnemo_workspace WHERE id = p_workspace_id;
$$;

REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_tenant_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_workspace_tenant_id(text) TO app_user, mnemo_app_role;

-- ── Memberships for a caller with no user: its actor tenant only ─────────────
-- The user branches are 0022's and 0012's, unchanged. The empty-user branch
-- was "everything"; it is now "the workspaces of the actor tenant".
DROP POLICY IF EXISTS mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_read ON mnemosyne.mnemo_workspace_member FOR SELECT USING (
  mnemosyne.is_workspace_member(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (user_id = current_setting('mnemosyne.actor_user_id', true))
  OR mnemosyne.is_tenant_admin_for_workspace(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (
    COALESCE(current_setting('mnemosyne.actor_user_id', true), '') = ''
    AND mnemosyne.mnemo_workspace_tenant_id(workspace_id) = current_setting('mnemosyne.actor_tenant_id', true)
  )
);

DROP POLICY IF EXISTS mnemo_workspace_member_write ON mnemosyne.mnemo_workspace_member;
CREATE POLICY mnemo_workspace_member_write ON mnemosyne.mnemo_workspace_member USING (
  mnemosyne.is_workspace_admin(workspace_id, current_setting('mnemosyne.actor_user_id', true))
  OR (
    COALESCE(current_setting('mnemosyne.actor_user_id', true), '') = ''
    AND mnemosyne.mnemo_workspace_tenant_id(workspace_id) = current_setting('mnemosyne.actor_tenant_id', true)
  )
);
