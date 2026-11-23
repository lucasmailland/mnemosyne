-- 0066_api_keys_scopes.sql — Add scope array to bearer API keys.
-- Empty array = legacy key = no scope restriction (full access, backward compat).
BEGIN;
ALTER TABLE mnemo_api_keys
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}'::text[];
COMMENT ON COLUMN mnemo_api_keys.scopes IS
  'Granted scopes. Empty array = legacy key with unrestricted access (backward compat).';
COMMIT;
