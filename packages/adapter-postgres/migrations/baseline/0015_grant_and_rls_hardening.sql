-- Migration 0015: grant + RLS hardening (DB-4, DB-5 from the 2026-07-23 audit).
--
-- DB-4: mnemo_key_escrow, mnemo_workspace_kek, mnemo_workspace_mode had RLS
-- ENABLE'd but never FORCE'd -- CLAUDE.md's S2 invariant ("All mnemo_*
-- tables MUST have both ENABLE ROW LEVEL SECURITY AND FORCE ROW LEVEL
-- SECURITY") was violated for these 3. Without FORCE, the table OWNER role
-- bypasses RLS even when it isn't a superuser and hasn't been granted
-- BYPASSRLS -- a real isolation gap if the owner role is ever used for
-- anything beyond migrations. mnemo_recall_log is DELIBERATELY excluded: it
-- has its own pinned exception in migrations.test.ts ("does NOT have FORCE
-- ROW LEVEL SECURITY", FORCE was removed pre-squash) -- do not force it.
ALTER TABLE mnemosyne.mnemo_key_escrow FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_workspace_kek FORCE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_workspace_mode FORCE ROW LEVEL SECURITY;

-- DB-5: no ALTER DEFAULT PRIVILEGES existed for the mnemosyne schema, so
-- every table a future migration creates starts ungranted to mnemo_app_role
-- by default -- exactly the bug class SAFE-1's grant_completeness linter
-- check exists to catch (and did: 11 missing GRANTs, fixed by migration
-- 0014). This closes the gap at the schema level going forward. No FOR ROLE
-- clause: applies to objects created by whichever role runs future
-- migrations in a given deployment (the same role executing this ALTER),
-- matching this repo's single-role migration model -- avoids hardcoding an
-- owner role name that could differ across self-hosted setups.
ALTER DEFAULT PRIVILEGES IN SCHEMA mnemosyne
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnemo_app_role;
