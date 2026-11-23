-- Migration 0011: mnemo_fact_archive was missing 16 columns that the Drizzle
-- schema (packages/adapter-postgres/src/schema/facts.ts factArchiveTable,
-- "All columns from mnemo_fact (LIKE mnemo_fact INCLUDING ALL)") declares and
-- FactRepository.archiveFact() unconditionally inserts.
--
-- Effect in practice: any /remember call that triggers §33 auto-resolve
-- (an incoming fact contradicts and supersedes an existing one) throws
-- `column "actor_id" of relation "mnemo_fact_archive" does not exist` and
-- 500s. Worse, the circuit breaker wrapping storageWrite trips open on that
-- failure, so every subsequent /remember call fails immediately with
-- "Breaker is open" until the breaker's cooldown resets — independent of
-- that later call's content. This is what read as "intermittent 500s that
-- sometimes still persist the fact" — it's a single deterministic write
-- failure whose blast radius (the open breaker) masquerades as flakiness.
--
-- Column definitions mirror mnemo_fact's exactly (same migration file,
-- CREATE TABLE mnemosyne.mnemo_fact).
ALTER TABLE mnemosyne.mnemo_fact_archive
  ADD COLUMN IF NOT EXISTS actor_id text,
  ADD COLUMN IF NOT EXISTS memory_type text DEFAULT 'semantic'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS memory_strength double precision DEFAULT 1.0 NOT NULL,
  ADD COLUMN IF NOT EXISTS memory_stability double precision DEFAULT 1.0 NOT NULL,
  ADD COLUMN IF NOT EXISTS last_strength_update timestamp with time zone,
  ADD COLUMN IF NOT EXISTS attribution text DEFAULT 'inferred'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS attributed_to text,
  ADD COLUMN IF NOT EXISTS protocol_version text DEFAULT 'v1.1'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS entity_id text,
  ADD COLUMN IF NOT EXISTS episode_id text,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active'::text NOT NULL,
  ADD COLUMN IF NOT EXISTS valid_from timestamp with time zone DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS valid_to timestamp with time zone,
  ADD COLUMN IF NOT EXISTS embedding public.halfvec(1536),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS text_lemmatized tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(statement, ''::text))) STORED;

-- `original_status` predates the Drizzle schema (packages/adapter-postgres/src/
-- schema/facts.ts factArchiveTable never declares it) and was NOT NULL with no
-- default — every archiveFact() insert violated the constraint since Drizzle
-- never supplies a value for a column it doesn't know exists. The `status`
-- column added above (mirroring mnemo_fact.status) is what the app actually
-- populates for this purpose now; keep the legacy column for any historical
-- rows/tooling that still reads it, just make it optional going forward.
ALTER TABLE mnemosyne.mnemo_fact_archive
  ALTER COLUMN original_status DROP NOT NULL;

-- mnemo_audit_log had only a FOR SELECT RLS policy (see mnemo_audit_log_ws in
-- 0001_v3_complete_baseline.sql) — no policy covers INSERT, so under RLS
-- (i.e. any non-superuser/non-BYPASSRLS role, which is what production
-- self-hosts are supposed to run as per docker/README.md's role-provisioning
-- section) every audit-log write is silently rejected by Postgres's
-- default-deny. remember() always appends an audit entry after creating a
-- fact, so this broke every /remember call under a properly hardened
-- deployment, not just ones that hit a fact contradiction.
-- Widened to FOR ALL, mirroring the mnemo_fact_ws policy pattern used
-- elsewhere in this migration (one workspace-scoped policy covering every
-- command) instead of bolting on a second INSERT-only policy.
DROP POLICY IF EXISTS mnemo_audit_log_ws ON mnemosyne.mnemo_audit_log;
CREATE POLICY mnemo_audit_log_ws ON mnemosyne.mnemo_audit_log
  FOR ALL USING ((workspace_id = (current_setting('mnemosyne.workspace_id', true))::uuid));
