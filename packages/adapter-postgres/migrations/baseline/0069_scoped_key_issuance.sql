-- Migration 0069: the server issues scoped-scheme keys (POST /admin/scoped-keys).
--
-- * user_id: the platform user who issued the key. The break-glass two-person
--   gate (middleware/rbac-policy.ts, routes/break-glass.ts) keys on the human,
--   so an mk_admin_ key without one can never pass it; the server binds every
--   key it issues to the caller's user, as POST /admin/keys does in
--   mnemo_api_keys.user_id. NULL for keys issued by a workspace key.
-- * Grants. The server reads these tables over DATABASE_URL, which in
--   production is the NOSUPERUSER / NOBYPASSRLS application role (docker/README).
--   0014 left them ungranted on the belief that mnemo_api_keys was too; it is
--   granted to mnemo_app_role (0001), so under that role MNEMO_SCOPED_AUTH=1
--   refused every key ("Key store unavailable"). No RLS, like mnemo_api_keys:
--   the lookup is what establishes the workspace. The grants are the least each
--   table needs: no DELETE (a key is revoked, never removed), the escrow is
--   append-only, and TRUNCATE stays with the owner.
--
-- DEPLOYMENT ORDER. Before the server code that writes user_id.
SET LOCAL lock_timeout = '5s';

-- RESTRICT like mnemo_api_keys.user_id (0023): deleting a user who still holds
-- keys must fail loudly and force a revocation decision first.
ALTER TABLE mnemosyne.mnemo_scoped_api_keys
    ADD COLUMN user_id text REFERENCES mnemosyne.mnemo_user(id) ON DELETE RESTRICT;

GRANT SELECT, INSERT, UPDATE ON TABLE mnemosyne.mnemo_scoped_api_keys TO mnemo_app_role;
GRANT SELECT, INSERT ON TABLE mnemosyne.mnemo_scoped_key_usage TO mnemo_app_role;
GRANT INSERT ON TABLE mnemosyne.mnemo_scoped_key_escrow TO mnemo_app_role;
