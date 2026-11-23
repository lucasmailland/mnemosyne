-- 0065_api_keys_expiry.sql — Add expiry support to bearer API keys.
BEGIN;
ALTER TABLE mnemo_api_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS mnemo_api_keys_expires_idx
  ON mnemo_api_keys (expires_at)
  WHERE expires_at IS NOT NULL AND revoked_at IS NULL;
COMMIT;
