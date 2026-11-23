-- 0063_server_api_keys.sql — HTTP server bearer-token API keys.
--
-- WHY THIS LIVES IN CORE'S MIGRATION STREAM (not in @mnemosyne/server):
--   The bundled `mnemo-migrate` CLI ships in @mnemosyne/core and discovers
--   exactly ONE migrations directory — this one. The Docker `migrate`
--   service deploys only @mnemosyne/core, so a migration parked under
--   packages/server/migrations would never run, and the HTTP server's auth
--   table would be missing on first boot (every request 500s on a missing
--   relation). Keeping the table in core's ordered stream means a single
--   `mnemo-migrate` run provisions everything the server needs.
--
--   Library-only consumers (who use @mnemosyne/core without the HTTP
--   server) get one small unused table. That is an acceptable cost for a
--   single, unambiguous migration stream.
--
-- Stores bearer API keys for the HTTP server. Plaintext is NEVER stored —
-- only a bcrypt hash. We can't index by hash directly (bcrypt salts are
-- per-row), so the server walks all non-revoked rows and bcrypt-compares
-- each. That scales to thousands of keys per replica with the LRU cache
-- in front of it; if you outgrow that, add a deterministic HMAC index
-- column and a UNIQUE index on it.

BEGIN;

CREATE TABLE IF NOT EXISTS mnemo_api_keys (
    -- Surrogate id (text cuid / uuid — runner's choice).
    id            text        PRIMARY KEY,

    -- Hashed bearer token. Never the plaintext.
    --
    -- This column stores a BCRYPT hash ONLY (a `$2b$…` string, cost 12) —
    -- exactly what `server/src/auth.ts` writes and what the bootstrap
    -- `docker/scripts/create-api-key.cjs` writes. Verification is
    -- `bcrypt.compare()` behind a 60s LRU cache. bcrypt salts are per-row,
    -- so this column CANNOT be indexed for direct equality against a bcrypt
    -- output; the middleware walks all non-revoked rows (O(n) on active key
    -- count).
    --
    -- There is NO sha256 path. An earlier design floated a deterministic
    -- sha256 index column for O(1) lookups, but that path was never wired
    -- into the live auth middleware and has been removed — do NOT write
    -- sha256 (or any non-bcrypt) digests here.
    key_hash      text        NOT NULL CHECK (length(key_hash) > 0),

    -- The workspace this key authorises. Hard FK kept off here because the
    -- host owns the workspaces table; add the constraint manually after
    -- migrating if you want enforced referential integrity:
    --   ALTER TABLE mnemo_api_keys
    --     ADD CONSTRAINT mnemo_api_keys_workspace_fk
    --     FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
    workspace_id  text        NOT NULL CHECK (length(workspace_id) > 0),

    -- Human-readable label set at issuance ("CI", "backfill bot").
    label         text        NOT NULL DEFAULT '',

    created_at    timestamptz NOT NULL DEFAULT now(),

    -- Telemetry. Updated fire-and-forget per request — not strictly accurate.
    last_used_at  timestamptz,

    -- Soft delete. Auth middleware filters on (revoked_at IS NULL).
    revoked_at    timestamptz,

    -- Defensive: a key cannot be revoked before it existed.
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- UNIQUE so we never have two rows with the same stored hash.
CREATE UNIQUE INDEX IF NOT EXISTS mnemo_api_keys_key_hash_uidx
    ON mnemo_api_keys (key_hash);

-- Hot path of the listActive() lookup: scan only non-revoked rows.
CREATE INDEX IF NOT EXISTS mnemo_api_keys_active_idx
    ON mnemo_api_keys (workspace_id)
    WHERE revoked_at IS NULL;

COMMIT;
