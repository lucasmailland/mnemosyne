-- 0015_mnemo_rls_foundation.sql
--
-- FOUNDATIONAL RLS LAYER for the mnemo_* schema.
--
-- IMPORTANT — pgvector extension:
-- Migrations from 0016 onward declare columns of type `vector(N)`. The
-- extension that provides that type is NOT created by any earlier
-- migration in this bundle (historically the Orchester host repo did it
-- in its own pre-0015 migrations). For self-host installs running this
-- bundle against a fresh Postgres, the very first migration must create
-- the extension or every subsequent CREATE TABLE blows up with
-- `type "vector" does not exist`. `IF NOT EXISTS` is idempotent, so hosts
-- that already enabled the extension out-of-band see a no-op.
CREATE EXTENSION IF NOT EXISTS vector;

-- WHY the RLS foundation exists / WHY it must run first:
--
-- WHY this exists / WHY it must run first:
-- Every mnemo_* migration from 0016 onward (16 of them) calls
-- `apply_pattern_a('<table>')` to switch on row-level security and install
-- the standard tenant-isolation policies. That helper — together with the
-- two settings-reader functions it depends on — historically lived in the
-- Orchester monorepo's migrations 0006 + 0008 and was NEVER extracted into
-- this package's bundle. The result: 16 migrations referenced a function
-- that nothing here defined, so a clean external install failed.
--
-- This migration restores the missing foundation. It is intentionally named
-- 0015 so it sorts (and therefore RUNS) strictly BEFORE 0016 under the
-- lexical ordering the migrate CLI uses.
--
-- PORTABILITY NOTE: this file defines FUNCTIONS ONLY. The Orchester source
-- also contained a DO-block that applied policies to first-class Orchester
-- tables (team / agent / conversation / …). Those tables do not exist in the
-- @mnemosyne/core schema, so that block is deliberately omitted here — the
-- mnemo_* migrations call apply_pattern_a() themselves for their own tables.
--
-- IDEMPOTENCY: the three functions use CREATE OR REPLACE and are safe to
-- (re)create. `apply_pattern_a(tbl)` itself is NOT internally idempotent
-- (CREATE POLICY has no IF NOT EXISTS pre-PG15), so it is meant to be called
-- exactly ONCE per table — which is exactly how the mnemo_* migrations use it.
--
-- ROLES: the mnemo_* migrations GRANT privileges to two NOLOGIN roles, and
-- `withMnemoTx` does `SET LOCAL ROLE app_user` to downgrade each transaction
-- to a role that LACKS BYPASSRLS — that downgrade is what makes FORCE ROW
-- LEVEL SECURITY actually bite (a superuser/owner connection would otherwise
-- sail past every policy). We create both roles here, idempotently, so a
-- clean external install is self-sufficient. They are NOLOGIN (pure SET ROLE
-- targets, never connection roles) and NOSUPERUSER / no BYPASSRLS.
--
-- The CONNECTING role must be a member of app_user / app_org_user to SET ROLE
-- to them (a superuser bypasses this check). For a non-superuser host, grant
-- membership once: `GRANT app_user, app_org_user TO <your_connect_role>;`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_org_user') THEN
    CREATE ROLE app_org_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END$$;

-- BASE PRIVILEGES for the RLS-enforcing roles.
--
-- RLS only *filters* rows for a role that already has table privileges — a
-- role with no GRANT gets "permission denied" before any policy is even
-- evaluated. The Orchester source granted these in an early (un-extracted)
-- migration; we restore them here so app_user can actually read/write the
-- mnemo_* tables (subject to the per-workspace policies installed by
-- apply_pattern_a) and app_org_user can read the consolidation view.
--
-- USAGE on the schema is the precondition for touching anything in it.
GRANT USAGE ON SCHEMA public TO app_user, app_org_user;

-- DEFAULT PRIVILEGES apply to tables created AFTER this statement BY THE
-- ROLE RUNNING IT (the migration runner). Since 0015 runs first and every
-- mnemo_* table is created afterward by that same role, this single
-- statement covers the whole stream — no per-table GRANT needed. app_user
-- gets full DML; row visibility is still gated by the RLS policies.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- Sequences (for any serial/identity columns the mnemo_* tables use).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

CREATE OR REPLACE FUNCTION current_workspace_id()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::text;
$$;

CREATE OR REPLACE FUNCTION is_cross_tenant_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.cross_tenant_admin', true) = 'true', false);
$$;

CREATE OR REPLACE FUNCTION apply_pattern_a(tbl text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format($f$
    CREATE POLICY %1$I_tenant_select ON %1$I FOR SELECT
    USING (workspace_id = current_workspace_id() OR is_cross_tenant_admin())
  $f$, tbl);
  EXECUTE format($f$
    CREATE POLICY %1$I_tenant_insert ON %1$I FOR INSERT
    WITH CHECK (workspace_id = current_workspace_id() OR is_cross_tenant_admin())
  $f$, tbl);
  EXECUTE format($f$
    CREATE POLICY %1$I_tenant_update ON %1$I FOR UPDATE
    USING (workspace_id = current_workspace_id() OR is_cross_tenant_admin())
    WITH CHECK (workspace_id = current_workspace_id() OR is_cross_tenant_admin())
  $f$, tbl);
  EXECUTE format($f$
    CREATE POLICY %1$I_tenant_delete ON %1$I FOR DELETE
    USING (workspace_id = current_workspace_id() OR is_cross_tenant_admin())
  $f$, tbl);
END;
$$;
