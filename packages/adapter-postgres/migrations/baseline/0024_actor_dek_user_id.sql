-- Migration 0024: mnemo_actor_dek gains user_id — real per-person GDPR crypto-erasure.
--
-- Root cause: mnemo_actor_dek (and the DEK provisioning/erasure code in
-- FactRepository/EncryptionRepository) is keyed entirely on actor_id — the
-- authenticating credential, not the person. A person holding two API keys
-- ends up with two separate DEKs; "erase this actor's data" only ever
-- destroys one of them, leaving the other person's data recoverable.
--
-- The fix does NOT touch the wrap/unwrap crypto. KeyRingAdapter.wrapDek/
-- unwrapDek use AAD = "<workspaceId>|<actorId>" — that stays byte-for-byte
-- unchanged, so no existing wrapped DEK is invalidated by this migration.
-- This is safe because an API key's user_id binding (mnemo_api_keys.user_id)
-- is fixed for the key's entire lifetime — it is read once per request from
-- the key row, never varies per-request (see packages/server/src/auth.ts).
-- That means an actor-keyed DEK can only ever protect ONE person's data (or
-- zero, for unbound service/agent/system keys) — we don't need to re-key the
-- crypto, we just need to know WHICH person each DEK belongs to, so all of a
-- person's DEKs (however many actor_ids/keys they've used) can be destroyed
-- together in one erasure action.
--
-- user_id is nullable and populated only at provisioning time going forward
-- (see FactRepository.createFact's DEK-provisioning INSERT). Existing DEK
-- rows predating this column are NOT backfilled — there is no reliable way
-- to retroactively map a bare actor_id string back to a user_id without a
-- lookup this table never recorded, and per the project's pre-1.0/
-- pre-production stance there is no real data this needs to preserve. Those
-- rows remain destroyable via the existing actor_id-keyed path
-- (destroyActorDek) exactly as today — this migration only ADDS the
-- person-scoped path (destroyUserDeks), it does not replace anything.

ALTER TABLE mnemosyne.mnemo_actor_dek
  ADD COLUMN user_id text;

ALTER TABLE mnemosyne.mnemo_actor_dek
  ADD CONSTRAINT mnemo_actor_dek_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL;

CREATE INDEX mnemo_actor_dek_user_idx
  ON mnemosyne.mnemo_actor_dek (workspace_id, user_id)
  WHERE user_id IS NOT NULL AND status = 'active';
