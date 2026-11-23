-- 0063_server_api_keys.down.sql — reverse of 0063.
BEGIN;
DROP INDEX IF EXISTS mnemo_api_keys_active_idx;
DROP INDEX IF EXISTS mnemo_api_keys_key_hash_uidx;
DROP TABLE IF EXISTS mnemo_api_keys;
COMMIT;
