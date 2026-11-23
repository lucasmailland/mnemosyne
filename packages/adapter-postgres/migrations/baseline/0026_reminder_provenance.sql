-- Migration 0026: write-provenance columns on mnemo_reminder.
--
-- Root cause (p45 design doc / CLAUDE.md "Provenance identity"): mnemo_reminder
-- has never carried actor_id/user_id/actor_type. It was missed by migration
-- 0023 because it is not one of the 10 cognitive primitive tables — it only
-- had `created_by_agent_id`, which names an agent, not a principal, and
-- cannot distinguish a human user from an API-key-only actor. This migration
-- extends the same additive/nullable pattern used by 0023 (primitives) and
-- 0025 (relation/hyperedge) so `reminders.ts` can populate real provenance
-- via resolveProvenance() without a backfill or a NOT NULL constraint.
--
-- Additive-optional only: nullable columns, no backfill (all rows are
-- currently NULL for these new columns), no default beyond NULL.

ALTER TABLE mnemosyne.mnemo_reminder
  ADD COLUMN actor_id text,
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_reminder
  ADD CONSTRAINT mnemo_reminder_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_reminder_actor_type_check
    CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

CREATE INDEX idx_mnemo_reminder_user_id ON mnemosyne.mnemo_reminder
  USING btree (workspace_id, user_id) WHERE (user_id IS NOT NULL);
