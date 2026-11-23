-- Migration 0025: write-provenance columns on mnemo_relation + mnemo_hyperedge.
--
-- Root cause (see p46 design doc / CLAUDE.md "Provenance identity"): graph
-- edges (`mnemo_relation`) and n-ary relations (`mnemo_hyperedge`) have never
-- recorded WHO created them. Every other cognitive primitive already carries
-- actor_id/user_id/actor_type (migration 0023); this migration extends the
-- same additive/nullable pattern to the two graph tables so future write
-- paths (p45/p47) can populate real provenance without a backfill or a
-- NOT NULL constraint that would break the 22 existing call sites that omit
-- these fields today.
--
-- Additive-optional only: nullable columns, no backfill, no default, no
-- index, no RLS policy. Nothing reads these columns yet — p45/p47 wire the
-- call sites that populate them.

ALTER TABLE mnemosyne.mnemo_relation
  ADD COLUMN actor_id text,
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_relation
  ADD CONSTRAINT mnemo_relation_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_relation_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_hyperedge
  ADD COLUMN actor_id text,
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_hyperedge
  ADD CONSTRAINT mnemo_hyperedge_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_hyperedge_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));
