-- Migration 0028: narrow mnemo_fact_scope_check, dropping the dead
-- 'employee'/'team' values.
--
-- flatten-legacy-dual-core Slice 1 pt.2 (tasks.md 2.9). @mnemo-ai/types'
-- Fact.scope TS union has only ever declared "global" | "conversation"
-- (packages/types/src/primitives.ts) — the physical CHECK allowed 2 extra
-- values ('employee', 'team') the application type never exposed. Confirmed
-- 2026-08-09 via repo-wide grep across packages/server, packages/mcp, and
-- packages/core: zero references to either value anywhere in production
-- code. This is dead surface from an earlier, abandoned design, not a
-- feature in use — narrowing the CHECK to the 2 values the application
-- actually understands, per design.md D1 (physical follows the real,
-- exercised contract).
--
-- NOT VALID + a same-file VALIDATE CONSTRAINT keeps this zero-downtime
-- (migration-safety.ts check #1): the ADD is instant catalog-only work, and
-- VALIDATE CONSTRAINT only needs SHARE UPDATE EXCLUSIVE (concurrent
-- reads/writes stay unblocked) while it scans for any pre-existing
-- 'employee'/'team' row — none are expected (see above), so this is
-- expected to be a fast, uneventful scan.

ALTER TABLE mnemosyne.mnemo_fact
  DROP CONSTRAINT mnemo_fact_scope_check;

ALTER TABLE mnemosyne.mnemo_fact
  ADD CONSTRAINT mnemo_fact_scope_check
  CHECK (scope = ANY (ARRAY['global', 'conversation']::text[])) NOT VALID;

ALTER TABLE mnemosyne.mnemo_fact
  VALIDATE CONSTRAINT mnemo_fact_scope_check;
