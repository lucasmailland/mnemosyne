-- Migration 0051 (accounts stage A): the first superadmin from the setup
-- wizard.
--
-- POST /bootstrap runs as an app role, which cannot write mnemo_instance_admin
-- (0050: FORCE RLS, no policy). This function is the one write it may make, and
-- only on a fresh installation: the table is empty AND mnemo_api_keys holds at
-- most one row (the key the bootstrap transaction has just inserted, before
-- this call). An installation already in use with zero superadmins (between an
-- upgrade and the break-glass script) is not fresh: any app-role caller could
-- otherwise name a superadmin. The user must exist and be enabled. It names
-- the installation's first superadmin and nothing else. Every later grant goes through mnemo_instance_grant_admin,
-- which needs an existing superadmin. As for the other functions on that
-- table, it runs as the migration owner, which must bypass RLS.
--
-- DEPLOYMENT ORDER. Before the server code that calls it.
SET LOCAL lock_timeout = '5s';

-- Takes the lock grant and revoke take, so a concurrent first grant and this
-- one cannot both see an empty table. A non-empty table, more than one API
-- key, or an unknown or disabled user raises 42501.
CREATE FUNCTION mnemosyne.mnemo_instance_bootstrap_admin(p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mnemo_instance_admin'));
  IF EXISTS (SELECT 1 FROM mnemosyne.mnemo_instance_admin) THEN
    RAISE EXCEPTION 'already_has_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT count(*) FROM mnemosyne.mnemo_api_keys) > 1 THEN
    RAISE EXCEPTION 'already_bootstrapped' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_user u WHERE u.id = p_user AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'user_not_eligible' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by)
  VALUES (p_user, 'system:bootstrap');
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_instance_bootstrap_admin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_instance_bootstrap_admin(text) TO app_user, mnemo_app_role;
