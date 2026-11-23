-- migrate:allow-rls-no-policy reason=mnemo_dashboard_session_revocation holds hashes of signed-out session ids; only the SECURITY DEFINER functions below read or write it, so no policy is deliberate
-- migrate:allow-no-grant reason=no app role touches mnemo_dashboard_session_revocation directly; every access goes through the SECURITY DEFINER functions below
-- Migration 0059: signing out of the dashboard ends the session on the server.
--
-- A dashboard session is an 8-hour HS256 JWT in an HttpOnly cookie. Clearing
-- the cookie on sign-out left the token itself valid until it expired, so a
-- copy of it kept working (AUD-007). Sign-out now stores the SHA-256 of the
-- session's id (the token's signed, random jti; never the token string, which
-- base64url lets one signature spell several ways) here for the session TTL plus an hour
-- (a switch or an "open" re-mints with the same jti, so the row has to outlive
-- every token of the session), and every live session check
-- (resolveLiveSession) refuses a token whose session id is present. Only that
-- session ends: the user's other sessions are untouched (a password change
-- still ends all of them, through sessions_valid_after).
--
-- Rows past expires_at are useless (the JWT is refused on its exp anyway);
-- each revoke deletes them, so the table holds at most the sign-outs of the
-- last 8 hours.
--
-- Both functions run as the migration owner (which must bypass RLS, as for
-- 0047, 0049, 0050 and 0052-0055).
--
-- DEPLOYMENT ORDER. Before the server code that calls these functions.
SET LOCAL lock_timeout = '5s';

CREATE TABLE mnemosyne.mnemo_dashboard_session_revocation (
    session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL
);
CREATE INDEX mnemo_dashboard_session_revocation_expires_idx
    ON mnemosyne.mnemo_dashboard_session_revocation (expires_at);

ALTER TABLE mnemosyne.mnemo_dashboard_session_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_dashboard_session_revocation FORCE ROW LEVEL SECURITY;
-- 0015's default privileges hand mnemo_app_role all four DML rights on every
-- new table; take them back (provision-app-role.mjs does too on each deploy).
REVOKE ALL ON TABLE mnemosyne.mnemo_dashboard_session_revocation FROM PUBLIC, app_user, mnemo_app_role;

-- Record a sign-out. The caller proved the token (it verified its signature);
-- an already expired one needs no row.
CREATE FUNCTION mnemosyne.mnemo_dashboard_session_revoke(p_session_hash text, p_expires_at timestamptz)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM mnemosyne.mnemo_dashboard_session_revocation WHERE expires_at < clock_timestamp();
  IF p_expires_at > clock_timestamp() THEN
    -- No session outlives its 8-hour TTL: a later expiry is clamped, never kept.
    INSERT INTO mnemosyne.mnemo_dashboard_session_revocation (session_hash, expires_at)
    VALUES (p_session_hash, LEAST(p_expires_at, clock_timestamp() + interval '9 hours'))
    ON CONFLICT (session_hash) DO NOTHING;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_dashboard_session_revoke(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_dashboard_session_revoke(text, timestamptz) TO app_user, mnemo_app_role;

CREATE FUNCTION mnemosyne.mnemo_dashboard_session_revoked(p_session_hash text)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'mnemosyne', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM mnemosyne.mnemo_dashboard_session_revocation WHERE session_hash = p_session_hash
  );
$$;
REVOKE ALL ON FUNCTION mnemosyne.mnemo_dashboard_session_revoked(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mnemosyne.mnemo_dashboard_session_revoked(text) TO app_user, mnemo_app_role;
