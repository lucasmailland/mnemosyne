-- Migration 0016: grant mnemo_app_role SELECT access on public.mnemo_extraction_job.
--
-- STATS-1 (docs/STATUS.md memory_stats finding, 2026-07-28): computeHealthSnapshot
-- (packages/core/src/health/compute.ts) queries public.mnemo_extraction_job for
-- extractionJobsFailed7d/extractionJobsDeferred. That table is created by the
-- legacy core migration stream (0017_mnemosyne_init.sql), not this one, and
-- never received a matching GRANT to mnemo_app_role -- the same conditional-grant
-- gap 0001_v3_complete_baseline.sql already closed for public.mnemo_semantic_neighbor.
--
-- Under the unified single-role deployment (connecting role is mnemo_app_role
-- with no app_user membership -- see core/src/tx.ts's pg_has_role guard), every
-- computeHealthSnapshot({fresh:true}) call throws "permission denied for table
-- mnemo_extraction_job", which routes/governance.ts's bare catch {} silently
-- swallows into a null 200 response -- so mnemo_health can never receive a row
-- through any code path. Proven against a real Postgres container in
-- packages/server/src/__tests__/integration/admin-stats.integration.test.ts.
--
-- Conditional (not unconditional, unlike 0014's mnemosyne.* grants) because
-- this table lives in the legacy public schema stream, which a v3-only
-- deployment may never have run -- same defensive pattern as the
-- mnemo_semantic_neighbor grant above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mnemo_extraction_job'
  ) THEN
    GRANT SELECT
      ON TABLE public.mnemo_extraction_job
      TO mnemo_app_role;
  END IF;
END $$;
