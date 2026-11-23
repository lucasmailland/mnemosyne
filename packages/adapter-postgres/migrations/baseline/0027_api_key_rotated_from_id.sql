-- Migration 0027: add mnemo_api_keys.rotated_from_id.
--
-- POST /admin/keys/:keyId/rotate (packages/server/src/routes/keys.ts) has
-- always INSERTed a `rotated_from_id` value on the new key row, and
-- GET /admin/keys/:keyId has always SELECTed it back to expose key-rotation
-- lineage in the API response — but mnemo_api_keys never had this column.
-- Both routes are reachable and mounted; both 500 with a real Postgres
-- `42703 undefined_column` error against a genuine database. Found by
-- flatten-version-docs' B4.1 coverage fill-in.
--
-- `rotated_from_id` already exists on the unrelated mnemo_scoped_api_keys
-- table (0001_v3_complete_baseline.sql) with the same purpose — this gives
-- mnemo_api_keys the column its own, already-shipped rotation code expects.
--
-- Nullable, no default, no backfill: the safest possible additive column
-- per migration-safety.ts. Existing keys simply have rotated_from_id = NULL
-- (they were never rotated, which is the truth).

ALTER TABLE mnemosyne.mnemo_api_keys
  ADD COLUMN rotated_from_id text;
