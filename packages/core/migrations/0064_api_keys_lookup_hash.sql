-- 0064_api_keys_lookup_hash.sql — O(1) API key lookup via HMAC index.
--
-- Problem: auth.ts does bcrypt.compare() (O(n) in active key count) on every
-- cache-miss. With n keys and ~100ms per bcrypt, a token matching the pattern
-- but not in the DB triggers a full O(n) scan — a CPU-amplification DoS
-- accessible to any unauthenticated caller.
--
-- Fix: add a deterministic HMAC-SHA256 column so the server can find the
-- exact row to compare before calling bcrypt. Only ONE bcrypt.compare() is
-- ever needed. The HMAC uses a server-side pepper (MNEMO_KEY_PEPPER) so the
-- lookup_hash is not brute-forceable even if the DB is exfiltrated.
--
-- Migration strategy: column is nullable. Old rows (created before this
-- migration) have NULL and get their lookup_hash set lazily on first
-- successful use. New rows set lookup_hash at key-issuance time.
--
-- Revoke: 0064_api_keys_lookup_hash.down.sql

BEGIN;

ALTER TABLE mnemo_api_keys
  ADD COLUMN IF NOT EXISTS lookup_hash text;

-- Partial unique index: only non-null hashes must be unique.
-- Allows multiple NULL rows (unmigrated old keys) to coexist.
CREATE UNIQUE INDEX IF NOT EXISTS mnemo_api_keys_lookup_hash_uidx
  ON mnemo_api_keys (lookup_hash)
  WHERE lookup_hash IS NOT NULL;

-- Partial index for the fast-path SELECT by lookup_hash.
CREATE INDEX IF NOT EXISTS mnemo_api_keys_lookup_active_idx
  ON mnemo_api_keys (lookup_hash)
  WHERE revoked_at IS NULL AND lookup_hash IS NOT NULL;

COMMENT ON COLUMN mnemo_api_keys.lookup_hash IS
  'HMAC-SHA256(MNEMO_KEY_PEPPER, plaintext_key) encoded as hex. '
  'Enables O(1) lookup: find this row, then bcrypt-compare once. '
  'NULL means the key was issued before migration 0064 — set lazily on first use.';

COMMIT;
