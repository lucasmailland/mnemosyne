-- Migration 0013: complete mnemo_fact_archive parity with mnemo_fact.
-- 0011 added 16 of 19 columns missing after the 2026-06 squash; these 3
-- remained: embedding_version, linked_memory_ids (populated by the legacy
-- packages/core write path directly on this shared table — see
-- packages/core/src/db/schema/fact.ts, packages/core/src/factory.ts) and
-- scope_owner (populated by the v3 write path, CreateFactInput.scopeOwner).
-- Idempotent (IF NOT EXISTS) so re-runs against any env that manually
-- patched are no-ops.
ALTER TABLE mnemosyne.mnemo_fact_archive
  ADD COLUMN IF NOT EXISTS embedding_version text,
  ADD COLUMN IF NOT EXISTS linked_memory_ids text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS scope_owner text;
