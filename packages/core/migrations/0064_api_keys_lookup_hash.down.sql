-- Rollback for 0064_api_keys_lookup_hash.sql

BEGIN;

DROP INDEX IF EXISTS mnemo_api_keys_lookup_active_idx;
DROP INDEX IF EXISTS mnemo_api_keys_lookup_hash_uidx;
ALTER TABLE mnemo_api_keys DROP COLUMN IF EXISTS lookup_hash;

COMMIT;
