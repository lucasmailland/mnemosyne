-- Passwords are separate from user profiles. New empty table: no backfill.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_user_credential (
    user_id text PRIMARY KEY REFERENCES mnemosyne.mnemo_user(id) ON DELETE CASCADE,
    password_hash text NOT NULL CHECK (password_hash ~ '^\$2[ab]\$12\$[./A-Za-z0-9]{53}$'),
    password_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mnemosyne.mnemo_user_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_user_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_user_credential_own ON mnemosyne.mnemo_user_credential FOR ALL
    USING (user_id = current_setting('mnemosyne.actor_user_id', true))
    WITH CHECK (user_id = current_setting('mnemosyne.actor_user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mnemosyne.mnemo_user_credential TO app_user, mnemo_app_role;

-- Auth bootstrap boundary: no caller user exists yet. Match exactly one account
-- by normalized email, lock only its credential row, and expose no other profile.
-- The migration owner must bypass RLS, as for the existing provisioning helpers.
CREATE FUNCTION mnemosyne.mnemo_dashboard_credential_lookup(p_email text)
    RETURNS TABLE (
      "userId" text, email text, "passwordHash" text,
      "passwordUpdatedAt" text, "failedAttempts" integer, "lockedUntil" timestamptz
    )
    LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
      SELECT c.user_id, u.email, c.password_hash, c.password_updated_at::text,
             c.failed_attempts, c.locked_until
      FROM mnemosyne.mnemo_user_credential c
      JOIN mnemosyne.mnemo_user u ON u.id = c.user_id
      WHERE lower(btrim(u.email)) = lower(btrim(p_email))
        AND (SELECT count(*) FROM mnemosyne.mnemo_user candidate
             WHERE lower(btrim(candidate.email)) = lower(btrim(p_email))) = 1
      FOR UPDATE OF c;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_dashboard_credential_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_dashboard_credential_lookup(text) TO app_user, mnemo_app_role;
