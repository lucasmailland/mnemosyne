-- migrate:allow-rls-no-policy reason=mnemo_link_token holds single-use link hashes; only the SECURITY DEFINER functions below read or write it, so no policy is deliberate
-- migrate:allow-no-grant reason=no app role touches mnemo_link_token directly; every access goes through the SECURITY DEFINER functions below
-- Migration 0054 (accounts stage A): workspace members with email, invitations
-- and single-use links.
--
-- * mnemo_link_token: one row per single-use link (invitation, account setup,
--   password reset). Only the SHA-256 of the token is stored; the raw token
--   is shown once, in the link. FORCE RLS, no policy, no grant: everything
--   goes through the functions below.
-- * Workspace members: the members of a workspace with email and display name
--   for its members (and superadmins); role changes and removals by the
--   workspace's owners and admins. An admin neither touches an owner nor makes
--   one. The 0053 instance functions now share the same rules
--   (mnemo_workspace_member_apply) instead of a copy of them.
-- * Links: mnemo_link_issue, mnemo_invitation_regenerate / _revoke,
--   mnemo_link_describe and mnemo_link_consume.
--
-- Lock order, everywhere: the mnemo_workspace row (FOR UPDATE), then the
-- per-email advisory lock, then link rows. Owner changes in a workspace
-- serialize on its row, as in 0053; a link's email and workspace never change,
-- so consume can take both locks before it locks the link row.
--
-- A workspace is personal when its tenant is some user's personal_tenant_id,
-- never by mnemo_tenant.kind. Emails are compared as lower(btrim(email)), the
-- server's normalizeEmail; an email shared by several accounts is ambiguous
-- and never resolved to one of them.
--
-- Every function runs as the migration owner (which must bypass RLS, as for
-- 0047, 0049, 0050, 0052 and 0053). The internal helpers have no EXECUTE grant.
--
-- DEPLOYMENT ORDER. Before the server code that calls these functions.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_link_token (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    purpose text NOT NULL CHECK (purpose IN ('invite', 'account_setup', 'password_reset')),
    email text NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
    -- The name a superadmin gave an account to set up; the person may replace it.
    display_name text,
    -- A deleted workspace takes its pending invitations with it.
    workspace_id text REFERENCES mnemosyne.mnemo_workspace(id) ON DELETE CASCADE,
    role text CHECK (role IN ('owner', 'admin', 'write', 'read')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT mnemo_link_token_target CHECK (
      CASE WHEN purpose = 'invite' THEN workspace_id IS NOT NULL AND role IS NOT NULL
           ELSE workspace_id IS NULL AND role IS NULL END)
);
CREATE INDEX mnemo_link_token_workspace_idx ON mnemosyne.mnemo_link_token (workspace_id)
    WHERE workspace_id IS NOT NULL;
CREATE INDEX mnemo_link_token_pending_email_idx ON mnemosyne.mnemo_link_token (email, purpose)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE mnemosyne.mnemo_link_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_link_token FORCE ROW LEVEL SECURITY;
-- 0015's default privileges hand mnemo_app_role all four DML rights on every
-- new table; take them back (provision-app-role.mjs does too on each deploy).
REVOKE ALL ON TABLE mnemosyne.mnemo_link_token FROM PUBLIC, app_user, mnemo_app_role;

-- ── Internal helpers (no EXECUTE grant) ──────────────────────────────────────

-- The tenant of the workspace is some user's personal tenant.
CREATE FUNCTION mnemosyne.mnemo_workspace_is_personal(p_workspace text)
    RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT EXISTS (
        SELECT 1 FROM mnemosyne.mnemo_workspace w
        JOIN mnemosyne.mnemo_user u ON u.personal_tenant_id = w.tenant_id
        WHERE w.id = p_workspace
      );
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_is_personal(text) FROM PUBLIC;

-- The role of an enabled user in a workspace; NULL when not a member or disabled.
CREATE FUNCTION mnemosyne.mnemo_workspace_active_role(p_workspace text, p_user text)
    RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT m.role
      FROM mnemosyne.mnemo_workspace_member m
      JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
      WHERE m.workspace_id = p_workspace AND m.user_id = p_user AND u.disabled_at IS NULL;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_active_role(text, text) FROM PUBLIC;

-- Lock the workspace row; workspace_not_found (no_data_found) when it is gone.
CREATE FUNCTION mnemosyne.mnemo_workspace_lock(p_workspace text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  PERFORM 1 FROM mnemosyne.mnemo_workspace w WHERE w.id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_lock(text) FROM PUBLIC;

-- The caller's role in the workspace, under its row lock, when it is owner or
-- admin; not_workspace_admin (insufficient_privilege) otherwise.
CREATE FUNCTION mnemosyne.mnemo_workspace_lock_as_admin(p_actor text, p_workspace text)
    RETURNS text
    LANGUAGE plpgsql VOLATILE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_role text;
BEGIN
  PERFORM mnemosyne.mnemo_workspace_lock(p_workspace);
  v_role := mnemosyne.mnemo_workspace_active_role(p_workspace, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'not_workspace_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_role;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_lock_as_admin(text, text) FROM PUBLIC;

-- Change a member's role (p_remove false) or remove them (p_remove true).
-- Locks the workspace row (already held by a caller that locked it), then the
-- membership. p_actor_role limits what the caller may do: NULL (a superadmin)
-- or 'owner' may do anything; 'admin' may neither change nor remove an owner
-- nor make one (role_not_allowed). Demoting or removing the only enabled
-- owner raises last_owner. Unknown workspace or member: workspace_not_found /
-- member_not_found (no_data_found). Removing a member also revokes every
-- mnemo_api_keys row bound to them and homed in that workspace.
CREATE FUNCTION mnemosyne.mnemo_workspace_member_apply(
    p_workspace text, p_user text, p_role text, p_remove boolean, p_actor_role text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_role text;
BEGIN
  IF p_remove IS NULL THEN
    RAISE EXCEPTION 'invalid_remove_flag' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT p_remove AND (p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'write', 'read')) THEN
    RAISE EXCEPTION 'invalid_role' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_actor_role IS NOT NULL AND p_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'not_workspace_admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM mnemosyne.mnemo_workspace_lock(p_workspace);
  SELECT m.role INTO v_role FROM mnemosyne.mnemo_workspace_member m
  WHERE m.workspace_id = p_workspace AND m.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_actor_role IS NOT NULL AND p_actor_role = 'admin'
     AND (v_role = 'owner' OR (NOT p_remove AND p_role = 'owner')) THEN
    RAISE EXCEPTION 'role_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role = 'owner' AND (p_remove OR p_role <> 'owner') AND NOT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_workspace_member m
    JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
    WHERE m.workspace_id = p_workspace AND m.role = 'owner' AND m.user_id <> p_user
      AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'last_owner' USING ERRCODE = 'check_violation';
  END IF;
  IF p_remove THEN
    DELETE FROM mnemosyne.mnemo_workspace_member m
    WHERE m.workspace_id = p_workspace AND m.user_id = p_user;
    -- The member's user-bound keys homed here go with the membership: the
    -- auth path keeps a key's own scopes when its home membership is missing
    -- (legacy keys), so a removed member's key would otherwise keep working.
    UPDATE mnemosyne.mnemo_api_keys k SET revoked_at = clock_timestamp()
    WHERE k.user_id = p_user AND k.workspace_id = p_workspace AND k.revoked_at IS NULL;
  ELSE
    UPDATE mnemosyne.mnemo_workspace_member m SET role = p_role
    WHERE m.workspace_id = p_workspace AND m.user_id = p_user;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_member_apply(text, text, text, boolean, text) FROM PUBLIC;

-- Serializes everything that creates an account for, or issues a link to,
-- one normalized email.
CREATE FUNCTION mnemosyne.mnemo_link_email_lock(p_email text)
    RETURNS void
    LANGUAGE sql VOLATILE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT pg_advisory_xact_lock(hashtext('mnemo_link_email:' || p_email));
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_link_email_lock(text) FROM PUBLIC;

-- Whether a link can still be used, judged now. Never NULL: every unknown is
-- false, and the call sites COALESCE again.
--
--   * not consumed, not revoked, not expired;
--   * its email is not shared by several accounts (ambiguous);
--   * invite: the workspace exists and is not personal, and whoever issued the
--     link is still an enabled owner or admin there (an owner for an owner
--     invitation); an existing account must be enabled;
--   * account_setup: no account has the email yet;
--   * password_reset: exactly one account has it, and it is enabled;
--   * account_setup and password_reset: whoever issued the link is still an
--     active superadmin (mnemo_instance_is_admin).
CREATE FUNCTION mnemosyne.mnemo_link_usable(p_link mnemosyne.mnemo_link_token)
    RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_accounts integer;
  v_disabled boolean;
  v_issuer text;
BEGIN
  IF p_link.consumed_at IS NOT NULL OR p_link.revoked_at IS NOT NULL
     OR p_link.expires_at <= clock_timestamp() THEN
    RETURN false;
  END IF;
  SELECT count(*), bool_or(u.disabled_at IS NOT NULL) INTO v_accounts, v_disabled
  FROM mnemosyne.mnemo_user u WHERE lower(btrim(u.email)) = p_link.email;
  IF v_accounts > 1 THEN
    RETURN false;
  END IF;
  IF p_link.purpose = 'invite' THEN
    IF NOT EXISTS (SELECT 1 FROM mnemosyne.mnemo_workspace w WHERE w.id = p_link.workspace_id)
       OR mnemosyne.mnemo_workspace_is_personal(p_link.workspace_id)
       OR (v_accounts = 1 AND v_disabled) THEN
      RETURN false;
    END IF;
    -- NULL when the issuer has no enabled membership: COALESCE so that case
    -- is "unusable", never unknown (NOT NULL would let a consume through).
    v_issuer := mnemosyne.mnemo_workspace_active_role(p_link.workspace_id, p_link.created_by);
    RETURN COALESCE(v_issuer = 'owner' OR (v_issuer = 'admin' AND p_link.role <> 'owner'), false);
  END IF;
  -- account_setup and password_reset: the issuer must still be an active
  -- superadmin. A revoked or disabled one cannot use a reset link they issued
  -- before to take over an account. COALESCE: never unknown.
  IF NOT COALESCE(mnemosyne.mnemo_instance_is_admin(p_link.created_by), false) THEN
    RETURN false;
  END IF;
  IF p_link.purpose = 'account_setup' THEN
    RETURN COALESCE(v_accounts = 0, false);
  ELSIF p_link.purpose = 'password_reset' THEN
    RETURN COALESCE(v_accounts = 1 AND NOT v_disabled, false);
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_link_usable(mnemosyne.mnemo_link_token) FROM PUBLIC;

-- ── Workspace members ────────────────────────────────────────────────────────

-- The members of a workspace, with email and display name, when the actor is
-- an enabled member of it or a superadmin; no rows otherwise.
CREATE FUNCTION mnemosyne.mnemo_workspace_member_profiles(p_actor text, p_workspace text)
    RETURNS TABLE (
      user_id text, email text, display_name text, role text, joined_at timestamptz
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT u.id, u.email, u.display_name, m.role, m.joined_at
      FROM mnemosyne.mnemo_workspace_member m
      JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
      WHERE m.workspace_id = p_workspace
        AND (mnemosyne.mnemo_instance_is_admin(p_actor)
             OR mnemosyne.mnemo_workspace_active_role(p_workspace, p_actor) IS NOT NULL)
      ORDER BY lower(u.email), u.id;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_member_profiles(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_workspace_member_profiles(text, text) TO app_user, mnemo_app_role;

-- Pending invitations of a workspace (not consumed, revoked or expired) for
-- its owners and admins, or a superadmin; no rows otherwise. Never the hash.
CREATE FUNCTION mnemosyne.mnemo_workspace_invitations(p_actor text, p_workspace text)
    RETURNS TABLE (
      id text, email text, role text, created_at timestamptz, expires_at timestamptz
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT t.id, t.email, t.role, t.created_at, t.expires_at
      FROM mnemosyne.mnemo_link_token t
      WHERE t.purpose = 'invite' AND t.workspace_id = p_workspace
        AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp()
        AND (mnemosyne.mnemo_instance_is_admin(p_actor)
             OR mnemosyne.mnemo_workspace_active_role(p_workspace, p_actor) IN ('owner', 'admin'))
      ORDER BY t.created_at, t.id;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_invitations(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_workspace_invitations(text, text) TO app_user, mnemo_app_role;

-- A workspace owner or admin changes a member's role. The actor's own role is
-- read under the workspace row lock. Errors: not_workspace_admin and
-- role_not_allowed (insufficient_privilege), workspace_not_found and
-- member_not_found (no_data_found), last_owner (check_violation).
CREATE FUNCTION mnemosyne.mnemo_workspace_set_member_role(
    p_actor text, p_workspace text, p_user text, p_role text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  PERFORM mnemosyne.mnemo_workspace_member_apply(
    p_workspace, p_user, p_role, false,
    mnemosyne.mnemo_workspace_lock_as_admin(p_actor, p_workspace));
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_set_member_role(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_workspace_set_member_role(text, text, text, text) TO app_user, mnemo_app_role;

-- A workspace owner or admin removes a member (themselves included). Same
-- errors as set_member_role.
CREATE FUNCTION mnemosyne.mnemo_workspace_remove_member(p_actor text, p_workspace text, p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  PERFORM mnemosyne.mnemo_workspace_member_apply(
    p_workspace, p_user, NULL, true,
    mnemosyne.mnemo_workspace_lock_as_admin(p_actor, p_workspace));
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_workspace_remove_member(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_workspace_remove_member(text, text, text) TO app_user, mnemo_app_role;

-- 0053's instance functions, now through the shared rules above. Same
-- behaviour and errors as before.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_workspace_members(p_actor text, p_workspace text)
    RETURNS TABLE (
      user_id text, email text, display_name text, role text, joined_at timestamptz
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM mnemosyne.mnemo_workspace w WHERE w.id = p_workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT * FROM mnemosyne.mnemo_workspace_member_profiles(p_actor, p_workspace);
END;
$$;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_set_member_role(
    p_actor text, p_workspace text, p_user text, p_role text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM mnemosyne.mnemo_workspace_member_apply(p_workspace, p_user, p_role, false, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_remove_member(p_actor text, p_workspace text, p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM mnemosyne.mnemo_workspace_member_apply(p_workspace, p_user, NULL, true, NULL);
END;
$$;

-- ── Single-use links ─────────────────────────────────────────────────────────

-- Issue a link; returns its id. p_token_hash is the SHA-256 (hex) of the raw
-- token, which never reaches the database. p_email is normalized here.
--   * invite: the actor is an enabled owner or admin of a workspace that is
--     not personal (not_workspace_admin, personal_workspace), and only an
--     owner invites an owner (role_not_allowed): insufficient_privilege. A
--     current member's email is refused (already_member, check_violation).
--     Replaces the pending invitation of the same email to that workspace.
--   * account_setup (an account still to be created, with p_display_name) and
--     password_reset (for the one enabled account with the email): a
--     superadmin only (not_superadmin). email_taken (unique_violation),
--     user_not_found (no_data_found), ambiguous_email and user_disabled
--     (check_violation). Revokes the older unused links of the same purpose
--     for the email.
CREATE FUNCTION mnemosyne.mnemo_link_issue(
    p_actor text, p_purpose text, p_email text, p_workspace text, p_role text,
    p_token_hash text, p_ttl interval, p_display_name text DEFAULT NULL)
    RETURNS text
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_actor_role text;
  v_accounts integer;
  v_disabled boolean;
  v_id text;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'invalid_email' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ttl IS NULL OR p_ttl <= interval '0' OR p_ttl > interval '30 days' THEN
    RAISE EXCEPTION 'invalid_ttl' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_purpose = 'invite' THEN
    IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'write', 'read') THEN
      RAISE EXCEPTION 'invalid_role' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_actor_role := mnemosyne.mnemo_workspace_lock_as_admin(p_actor, p_workspace);
    IF mnemosyne.mnemo_workspace_is_personal(p_workspace) THEN
      RAISE EXCEPTION 'personal_workspace' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_role = 'owner' AND v_actor_role <> 'owner' THEN
      RAISE EXCEPTION 'role_not_allowed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM mnemosyne.mnemo_link_email_lock(v_email);
    IF EXISTS (
      SELECT 1 FROM mnemosyne.mnemo_workspace_member m
      JOIN mnemosyne.mnemo_user u ON u.id = m.user_id
      WHERE m.workspace_id = p_workspace AND lower(btrim(u.email)) = v_email
    ) THEN
      RAISE EXCEPTION 'already_member' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE mnemosyne.mnemo_link_token t SET revoked_at = clock_timestamp()
    WHERE t.purpose = 'invite' AND t.workspace_id = p_workspace AND t.email = v_email
      AND t.consumed_at IS NULL AND t.revoked_at IS NULL;
  ELSIF p_purpose IN ('account_setup', 'password_reset') THEN
    IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
      RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_workspace IS NOT NULL OR p_role IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_target' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM mnemosyne.mnemo_link_email_lock(v_email);
    SELECT count(*), bool_or(u.disabled_at IS NOT NULL) INTO v_accounts, v_disabled
    FROM mnemosyne.mnemo_user u WHERE lower(btrim(u.email)) = v_email;
    IF p_purpose = 'account_setup' AND v_accounts > 0 THEN
      RAISE EXCEPTION 'email_taken' USING ERRCODE = 'unique_violation';
    END IF;
    IF p_purpose = 'password_reset' THEN
      IF v_accounts = 0 THEN
        RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
      ELSIF v_accounts > 1 THEN
        RAISE EXCEPTION 'ambiguous_email' USING ERRCODE = 'check_violation';
      ELSIF v_disabled THEN
        RAISE EXCEPTION 'user_disabled' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    UPDATE mnemosyne.mnemo_link_token t SET revoked_at = clock_timestamp()
    WHERE t.purpose = p_purpose AND t.email = v_email
      AND t.consumed_at IS NULL AND t.revoked_at IS NULL;
  ELSE
    RAISE EXCEPTION 'invalid_purpose' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO mnemosyne.mnemo_link_token
    (token_hash, purpose, email, display_name, workspace_id, role, created_by, expires_at)
  VALUES (p_token_hash, p_purpose, v_email,
          CASE WHEN p_purpose = 'account_setup' THEN NULLIF(btrim(p_display_name), '') END,
          p_workspace, p_role, p_actor, clock_timestamp() + p_ttl)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_link_issue(text, text, text, text, text, text, interval, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_link_issue(text, text, text, text, text, text, interval, text) TO app_user, mnemo_app_role;

-- A new link for a pending (not consumed, not revoked; expired is fine)
-- invitation of the workspace: the old link stops working at once. The actor
-- becomes its issuer. Returns the new expiry. Errors: not_workspace_admin and
-- role_not_allowed (an admin and an owner invitation), invitation_not_found
-- (no_data_found).
CREATE FUNCTION mnemosyne.mnemo_invitation_regenerate(
    p_actor text, p_workspace text, p_id text, p_token_hash text, p_ttl interval)
    RETURNS timestamptz
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_actor_role text;
  v_link mnemosyne.mnemo_link_token;
  v_expires timestamptz;
BEGIN
  IF p_ttl IS NULL OR p_ttl <= interval '0' OR p_ttl > interval '30 days' THEN
    RAISE EXCEPTION 'invalid_ttl' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_actor_role := mnemosyne.mnemo_workspace_lock_as_admin(p_actor, p_workspace);
  SELECT * INTO v_link FROM mnemosyne.mnemo_link_token t
  WHERE t.id = p_id AND t.purpose = 'invite' AND t.workspace_id = p_workspace
    AND t.consumed_at IS NULL AND t.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_link.role = 'owner' AND v_actor_role <> 'owner' THEN
    RAISE EXCEPTION 'role_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE mnemosyne.mnemo_link_token t
  SET token_hash = p_token_hash, created_by = p_actor,
      expires_at = clock_timestamp() + p_ttl
  WHERE t.id = p_id
  RETURNING t.expires_at INTO v_expires;
  RETURN v_expires;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_invitation_regenerate(text, text, text, text, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_invitation_regenerate(text, text, text, text, interval) TO app_user, mnemo_app_role;

-- Revoke a pending invitation of the workspace. Same errors as regenerate.
CREATE FUNCTION mnemosyne.mnemo_invitation_revoke(p_actor text, p_workspace text, p_id text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
DECLARE
  v_actor_role text;
  v_role text;
BEGIN
  v_actor_role := mnemosyne.mnemo_workspace_lock_as_admin(p_actor, p_workspace);
  SELECT t.role INTO v_role FROM mnemosyne.mnemo_link_token t
  WHERE t.id = p_id AND t.purpose = 'invite' AND t.workspace_id = p_workspace
    AND t.consumed_at IS NULL AND t.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role = 'owner' AND v_actor_role <> 'owner' THEN
    RAISE EXCEPTION 'role_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE mnemosyne.mnemo_link_token t SET revoked_at = clock_timestamp() WHERE t.id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_invitation_revoke(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_invitation_revoke(text, text, text) TO app_user, mnemo_app_role;

-- What the holder of a link may learn: its purpose, the workspace name of an
-- invitation, whether an account already has the email (the accepted risk of
-- spec §4), the expiry, and the email itself (for the password policy; the
-- server does not return it). Zero rows when the link is unknown or no longer
-- usable (mnemo_link_usable). The token is the authority: no actor.
CREATE FUNCTION mnemosyne.mnemo_link_describe(p_token_hash text)
    RETURNS TABLE (
      purpose text, workspace_name text, account_exists boolean, expires_at timestamptz,
      email text
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT t.purpose, w.name,
             EXISTS (SELECT 1 FROM mnemosyne.mnemo_user u WHERE lower(btrim(u.email)) = t.email),
             t.expires_at, t.email
      FROM mnemosyne.mnemo_link_token t
      LEFT JOIN mnemosyne.mnemo_workspace w ON w.id = t.workspace_id
      WHERE t.token_hash = p_token_hash AND COALESCE(mnemosyne.mnemo_link_usable(t), false);
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_link_describe(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_link_describe(text) TO app_user, mnemo_app_role;

-- Use a link, once, in one transaction. Locks, in order: the invitation's
-- workspace row, the email, the link row; then re-checks mnemo_link_usable,
-- so of two concurrent uses the second sees the first one's consumed_at and
-- gets link_invalid (no_data_found), like an unknown, revoked or expired link,
-- an invitation whose issuer lost the right to invite or whose workspace is
-- gone.
--   * No account has the email (invite, account_setup): creates it with
--     mnemo_provision_user (personal tenant and workspace) and the credential
--     p_password_hash (password_required, invalid_parameter_value, without).
--   * An account has it (invite): p_session_user must be that account
--     (session_required, invalid_authorization_specification).
--   * invite: adds the tenant membership (member) when absent and the
--     workspace membership with the invited role.
--   * password_reset: sets the password (password_required without one),
--     unlocks the credential and ends every session (sessions_valid_after).
-- Returns the user, the workspace to sign in to (the invited one, else the
-- user's personal workspace, NULL when they have none), the link id and
-- purpose, and whether the account was created.
CREATE FUNCTION mnemosyne.mnemo_link_consume(
    p_token_hash text, p_password_hash text, p_session_user text,
    p_display_name text DEFAULT NULL)
    RETURNS TABLE (
      user_id text, workspace_id text, link_id text, purpose text, account_created boolean
    )
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
#variable_conflict use_column
DECLARE
  v_probe mnemosyne.mnemo_link_token;
  v_link mnemosyne.mnemo_link_token;
  v_user text;
  v_created boolean := false;
  v_workspace text;
BEGIN
  -- workspace_id and email never change: take their locks before the row's.
  SELECT * INTO v_probe FROM mnemosyne.mnemo_link_token t WHERE t.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'link_invalid' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_probe.workspace_id IS NOT NULL THEN
    PERFORM 1 FROM mnemosyne.mnemo_workspace w WHERE w.id = v_probe.workspace_id FOR UPDATE;
  END IF;
  PERFORM mnemosyne.mnemo_link_email_lock(v_probe.email);
  SELECT * INTO v_link FROM mnemosyne.mnemo_link_token t
  WHERE t.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR NOT COALESCE(mnemosyne.mnemo_link_usable(v_link), false) THEN
    RAISE EXCEPTION 'link_invalid' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT u.id INTO v_user FROM mnemosyne.mnemo_user u WHERE lower(btrim(u.email)) = v_link.email;
  IF v_user IS NULL THEN
    IF p_password_hash IS NULL THEN
      RAISE EXCEPTION 'password_required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- mnemo_provision_user admits a caller with no user GUC; the link is the
    -- authority here, and the account belongs to no provisioning tenant.
    PERFORM set_config('mnemosyne.actor_user_id', '', true),
            set_config('mnemosyne.actor_tenant_id', '', true);
    SELECT p.user_id INTO v_user
    FROM mnemosyne.mnemo_provision_user(
      v_link.email,
      COALESCE(NULLIF(btrim(p_display_name), ''), v_link.display_name, v_link.email),
      'Personal') p;
    INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash)
    VALUES (v_user, p_password_hash);
    v_created := true;
  ELSIF v_link.purpose = 'password_reset' THEN
    IF p_password_hash IS NULL THEN
      RAISE EXCEPTION 'password_required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash)
    VALUES (v_user, p_password_hash)
    ON CONFLICT (user_id) DO UPDATE
      SET password_hash = EXCLUDED.password_hash, password_updated_at = clock_timestamp(),
          failed_attempts = 0, locked_until = NULL;
    UPDATE mnemosyne.mnemo_user u SET sessions_valid_after = clock_timestamp() WHERE u.id = v_user;
  ELSIF p_session_user IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'session_required' USING ERRCODE = 'invalid_authorization_specification';
  END IF;

  IF v_link.purpose = 'invite' THEN
    INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role, invited_by)
    SELECT w.tenant_id, v_user, 'member', v_link.created_by
    FROM mnemosyne.mnemo_workspace w WHERE w.id = v_link.workspace_id
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
    INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role, invited_by)
    VALUES (v_link.workspace_id, v_user, v_link.role, v_link.created_by)
    ON CONFLICT (workspace_id, user_id) DO NOTHING;
    v_workspace := v_link.workspace_id;
  ELSE
    SELECT w.id INTO v_workspace
    FROM mnemosyne.mnemo_user u
    JOIN mnemosyne.mnemo_workspace w ON w.tenant_id = u.personal_tenant_id
    JOIN mnemosyne.mnemo_workspace_member m ON m.workspace_id = w.id AND m.user_id = u.id
    WHERE u.id = v_user
    ORDER BY w.created_at, w.id
    LIMIT 1;
  END IF;

  UPDATE mnemosyne.mnemo_link_token t SET consumed_at = clock_timestamp() WHERE t.id = v_link.id;
  RETURN QUERY SELECT v_user, v_workspace, v_link.id, v_link.purpose, v_created;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_link_consume(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_link_consume(text, text, text, text) TO app_user, mnemo_app_role;
