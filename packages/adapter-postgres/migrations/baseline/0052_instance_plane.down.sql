-- Reverts 0052. Run as ONE transaction (the BEGIN/COMMIT below make that true
-- even under `psql -f` autocommit). Roll the server back first: the instance
-- routes of this change call these functions.
--
-- Users disabled through the instance plane stay disabled; superadmin grants
-- stay. The app roles get the table-level UPDATE on mnemo_user back, so they
-- can write disabled_at again, as before 0052. Deploy the previous release's
-- docker/scripts/provision-app-role.mjs with it: this release's script takes
-- that grant back from mnemo_app_role on every run.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_set_disabled(text, text, boolean);
DROP FUNCTION IF EXISTS mnemosyne.mnemo_instance_list_users(text);

-- 0050's definition.
CREATE OR REPLACE FUNCTION mnemosyne.mnemo_instance_grant_admin(p_actor text, p_user text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('mnemo_instance_admin'));
  IF NOT mnemosyne.mnemo_instance_is_admin(p_actor) THEN
    RAISE EXCEPTION 'not_superadmin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by)
  VALUES (p_user, p_actor)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

-- A table-level REVOKE also drops the column grants 0052 made.
REVOKE UPDATE ON TABLE mnemosyne.mnemo_user FROM app_user, mnemo_app_role;
GRANT UPDATE ON TABLE mnemosyne.mnemo_user TO app_user, mnemo_app_role;
COMMIT;
