-- Migration 0023: provenance identity — user_id + actor_type columns.
--
-- Root cause (see CLAUDE.md "Provenance identity" / the actorId coherence
-- design doc): `actor_id` was specified as "the end-user this transaction
-- speaks for" but got populated with the authenticating API key's own row
-- id, and no column ever distinguished the two meanings at read time. This
-- migration adds the missing, FK-backed `user_id` column (the real
-- mnemo_user.id, when one exists) plus `actor_type` (agent|user|system|
-- federation) alongside the existing free-text `actor_id` provenance
-- column, on every table that carries it.
--
-- `actor_id` itself is NOT redefined or renamed here — it keeps meaning
-- "the authenticated credential" and stays a free-text column, because it
-- must still name agent/system/federation principals that have no
-- mnemo_user row. Only `@mnemo-ai/server` (Phase 3) stops writing raw,
-- unnamespaced values into it.
--
-- 8 of the 10 cognitive primitive tables already had `actor_id`: mnemo_fact,
-- mnemo_decision, mnemo_episode, mnemo_entity, mnemo_strategy,
-- mnemo_workflow, mnemo_skill, mnemo_task. mnemo_event and mnemo_reasoning
-- never had it at all (that's why events.ts had been stuffing identity into
-- agent_id) — this migration adds actor_id to those two for the first time,
-- alongside user_id/actor_type, so all 10 primitives end up symmetric.

ALTER TABLE mnemosyne.mnemo_fact
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_fact
  ADD CONSTRAINT mnemo_fact_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_fact_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_decision
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_decision
  ADD CONSTRAINT mnemo_decision_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_decision_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_episode
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_episode
  ADD CONSTRAINT mnemo_episode_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_episode_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_strategy
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_strategy
  ADD CONSTRAINT mnemo_strategy_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_strategy_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_workflow
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_workflow
  ADD CONSTRAINT mnemo_workflow_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_workflow_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_skill
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_skill
  ADD CONSTRAINT mnemo_skill_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_skill_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_task
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_task
  ADD CONSTRAINT mnemo_task_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_task_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

-- mnemo_event and mnemo_reasoning: actor_id did not exist before this migration.
ALTER TABLE mnemosyne.mnemo_event
  ADD COLUMN actor_id text,
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_event
  ADD CONSTRAINT mnemo_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_event_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

ALTER TABLE mnemosyne.mnemo_reasoning
  ADD COLUMN actor_id text,
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_reasoning
  ADD CONSTRAINT mnemo_reasoning_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_reasoning_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

-- mnemo_fact_archive: user_id/actor_type are deliberately PLAIN columns, no FK.
-- The archive is the tombstone/historical record the GDPR erasure process
-- must be able to FIND by user_id — an ON DELETE SET NULL (or CASCADE) FK
-- would blind erasure to exactly the rows it needs to act on when the user
-- row it should be keyed to is gone. It's a point-in-time copy of
-- provenance at archival time, not a live reference.
ALTER TABLE mnemosyne.mnemo_fact_archive
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS actor_type text;

-- mnemo_api_keys: user_id already exists (added pre-baseline) and was never
-- FK-constrained. This table has no RLS (see CLAUDE.md "Auth bootstrap
-- exception"), so the FK is unconditionally safe. RESTRICT (not SET NULL /
-- CASCADE): a key's user binding must never silently disappear or take the
-- key down with it — deleting a user while a key still references them
-- should fail loudly and force an explicit key-revocation decision first.
ALTER TABLE mnemosyne.mnemo_api_keys
  ADD CONSTRAINT mnemo_api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE RESTRICT;

-- mnemo_entity: user_id/actor_type (provenance — who WROTE this row), same
-- as every other primitive above.
ALTER TABLE mnemosyne.mnemo_entity
  ADD COLUMN user_id text,
  ADD COLUMN actor_type text;
ALTER TABLE mnemosyne.mnemo_entity
  ADD CONSTRAINT mnemo_entity_user_id_fkey FOREIGN KEY (user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_entity_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('agent','user','system','federation'));

-- linked_user_id is a SEPARATE concept from user_id/actor_type above.
-- user_id/actor_type answer "who WROTE this row" (provenance, same as every
-- other primitive). linked_user_id answers "who this row is ABOUT" (subject)
-- — i.e. this "person" entity IS this real platform account. Only ever
-- settable via a dedicated, trusted route (POST /entities/:id/link-user,
-- Phase 3 — not part of this migration); never accepted on create/update,
-- so an LLM cannot claim an identity by supplying the field. Enforced here
-- at the schema level: only valid on kind='person', and at most one LIVE
-- (valid_to IS NULL) linked entity per user per workspace.
ALTER TABLE mnemosyne.mnemo_entity
  ADD COLUMN linked_user_id text;
ALTER TABLE mnemosyne.mnemo_entity
  ADD CONSTRAINT mnemo_entity_linked_user_id_fkey FOREIGN KEY (linked_user_id) REFERENCES mnemosyne.mnemo_user(id) ON DELETE SET NULL,
  ADD CONSTRAINT mnemo_entity_linked_user_is_person CHECK (linked_user_id IS NULL OR kind = 'person');

CREATE UNIQUE INDEX uq_mnemo_entity_linked_user_live
  ON mnemosyne.mnemo_entity (workspace_id, linked_user_id)
  WHERE linked_user_id IS NOT NULL AND valid_to IS NULL;

-- Partial indexes mirroring the existing idx_mnemo_fact_scope_owner pattern.
CREATE INDEX idx_mnemo_fact_user_id ON mnemosyne.mnemo_fact USING btree (workspace_id, user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX idx_mnemo_entity_user_id ON mnemosyne.mnemo_entity USING btree (workspace_id, user_id) WHERE (user_id IS NOT NULL);

-- Backfill: NULL out garbage actor_id values that were never a real
-- identity — the shared apiKeyPrefix constant (e.g. "mns_live_") and the
-- various hardcoded literal fallbacks ("api"/"system"/"unknown"/"local").
-- Confirmed acceptable with the project owner (2026-08-01): pre-production,
-- no real data to preserve, and these rows were already indistinguishable
-- from one another under the old scheme (all sharing one bucket), so this
-- makes nothing more or less visible than it already was — NULL is simply
-- the honest encoding of "provenance unknown" instead of a fictitious
-- shared identity. Applied only to the 8 tables that could already hold
-- these values; mnemo_event/mnemo_reasoning just gained actor_id above and
-- are NULL by default, so backfilling them would be a no-op.
UPDATE mnemosyne.mnemo_fact SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');
UPDATE mnemosyne.mnemo_decision SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');
UPDATE mnemosyne.mnemo_episode SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');
UPDATE mnemosyne.mnemo_entity SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');
UPDATE mnemosyne.mnemo_strategy SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');
UPDATE mnemosyne.mnemo_workflow SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');
UPDATE mnemosyne.mnemo_skill SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');
UPDATE mnemosyne.mnemo_task SET actor_id = NULL
  WHERE actor_id IN ('api','system','unknown','local','mns_live_','mns_test_','mk_live_','mk_test_','mk_sess_','mk_fed_','mk_admin_');

-- ── RLS: additive only in this migration, NOT a swap ───────────────────────
--
-- IMPORTANT — deviates from an earlier draft of this plan, which assumed
-- mnemo_fact_actor_isolation_select (added pre-baseline, current definition:
--   AS RESTRICTIVE FOR SELECT USING (
--     current_setting('app.enforce_actor_isolation', true) IS DISTINCT FROM 'true'
--     OR actor_id IS NULL
--     OR actor_id = current_setting('app.actor_id', true)
--   )
-- ) was a permanent no-op today and could simply be swapped for a user_id
-- version. That assumption was WRONG: verified against
-- packages/adapter-postgres/src/repositories/FactRepository.ts, the two GUCs
-- (app.actor_id / app.enforce_actor_isolation) ARE actively set — but only
-- inside FactRepository.replaceFact(), gated on input.actorIsolationId,
-- which packages/server/src/routes/self.ts and grpc.ts populate after their
-- application-level ownership match for the self-edit "replace" action. This
-- policy is a real, live defense-in-depth backstop for that one write path
-- today, not dead code.
--
-- Dropping/redefining it in this migration — before core/server are updated
-- to resolve and pass user_id-based isolation through that same call path
-- (Phase 2/3, explicitly out of scope for this adapter-postgres-only pass)
-- — would silently DISABLE that backstop the moment this migration runs,
-- regressing the very security posture this whole effort exists to improve.
--
-- So: the existing actor_id-keyed policy is left completely untouched here.
-- This migration only ADDS a second, currently-inert RESTRICTIVE SELECT
-- policy on the new user_id column, using the mnemosyne.actor_user_id GUC
-- that withMnemoTenantTx already sets for tenant tables (see
-- packages/core/src/tx.ts) — reusing that name means it becomes one GUC
-- meaning "the human this transaction speaks for" everywhere, once Phase 2
-- wires withMnemoTx to set it for primitive-table transactions too and
-- Phase 3 rewires the self-edit ownership match onto user_id. Multiple
-- RESTRICTIVE policies on the same table combine with AND, so adding this
-- now is safe: since nothing sets app.enforce_user_isolation yet, its first
-- OR-clause is always true and it never restricts anything until Phase 2/3
-- activate it. Retiring mnemo_fact_actor_isolation_select is deferred to
-- whichever later phase finishes that rewiring.
CREATE POLICY mnemo_fact_user_isolation_select ON mnemosyne.mnemo_fact AS RESTRICTIVE FOR SELECT
  USING (current_setting('app.enforce_user_isolation', true) IS DISTINCT FROM 'true'
      OR user_id IS NULL
      OR user_id = current_setting('mnemosyne.actor_user_id', true));
